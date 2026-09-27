import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, type Address } from "viem";

export const SUPPORTED_MANIFEST_SCHEMA = "realityfork.deployment.v1" as const;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export interface LocalDeploymentManifest {
  manifestSchemaVersion: typeof SUPPORTED_MANIFEST_SCHEMA;
  contractName: "RealityRegistry";
  chainId: number;
  networkName: string;
  contractAddress: Address;
  relayerAddress: Address;
  reviewerAddress: Address;
  eip712Domain: { name: "RealityFork"; version: "2"; chainId: number; verifyingContract: Address };
  abiPath: string;
}

export interface EvmAdapterConfig {
  chainId: number;
  rpcUrl: string;
  contractAddress: Address;
  relayerAddress: Address;
  reviewerAddress: Address;
  confirmations: number;
  receiptTimeoutMs: number;
  manifest: LocalDeploymentManifest;
  abi: readonly unknown[];
}

export class BlockchainConfigurationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function positiveInteger(value: string | undefined, label: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new BlockchainConfigurationError("INVALID_CONFIGURATION", `${label} must be a positive integer`);
  return parsed;
}

function address(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new BlockchainConfigurationError("INVALID_MANIFEST", `${label} must be a valid address`);
  return getAddress(value);
}

export function validateManifest(raw: unknown): LocalDeploymentManifest {
  if (!raw || typeof raw !== "object") throw new BlockchainConfigurationError("INVALID_MANIFEST", "Deployment manifest must be an object");
  const value = raw as Record<string, unknown>;
  if (value.manifestSchemaVersion !== SUPPORTED_MANIFEST_SCHEMA) {
    throw new BlockchainConfigurationError("UNSUPPORTED_MANIFEST_SCHEMA", "Unsupported deployment manifest schema");
  }
  if (value.contractName !== "RealityRegistry") throw new BlockchainConfigurationError("INVALID_MANIFEST", "Unexpected contract name");
  if (!Number.isSafeInteger(value.chainId) || Number(value.chainId) <= 0) throw new BlockchainConfigurationError("INVALID_MANIFEST", "Manifest chain ID is invalid");
  const domain = value.eip712Domain as Record<string, unknown> | undefined;
  if (!domain || domain.name !== "RealityFork" || domain.version !== "2") {
    throw new BlockchainConfigurationError("INVALID_EIP712_DOMAIN", "Manifest EIP-712 domain must be RealityFork version 2");
  }
  const chainId = Number(value.chainId);
  if (domain.chainId !== chainId) throw new BlockchainConfigurationError("INVALID_EIP712_DOMAIN", "Manifest domain chain ID mismatch");
  const contractAddress = address(value.contractAddress, "Manifest contract address");
  const verifyingContract = address(domain.verifyingContract, "Manifest verifying contract");
  if (verifyingContract !== contractAddress) throw new BlockchainConfigurationError("INVALID_EIP712_DOMAIN", "Manifest verifying contract mismatch");
  if (value.abiPath !== "packages/contracts/abi/RealityRegistry.json") {
    throw new BlockchainConfigurationError("INVALID_MANIFEST", "Manifest ABI path is unsupported");
  }
  return {
    manifestSchemaVersion: SUPPORTED_MANIFEST_SCHEMA,
    contractName: "RealityRegistry",
    chainId,
    networkName: String(value.networkName ?? "localhost"),
    contractAddress,
    relayerAddress: address(value.relayerAddress, "Manifest relayer address"),
    reviewerAddress: address(value.reviewerAddress, "Manifest reviewer address"),
    eip712Domain: { name: "RealityFork", version: "2", chainId, verifyingContract },
    abiPath: value.abiPath
  };
}

export async function loadEvmAdapterConfig(env: NodeJS.ProcessEnv = process.env): Promise<EvmAdapterConfig> {
  const chainId = positiveInteger(env.CHAIN_ID, "CHAIN_ID");
  const signatureChainId = positiveInteger(env.SIGNATURE_CHAIN_ID, "SIGNATURE_CHAIN_ID");
  if (signatureChainId !== chainId) throw new BlockchainConfigurationError("CHAIN_ID_MISMATCH", "SIGNATURE_CHAIN_ID must equal CHAIN_ID");
  const rpcUrl = env.CHAIN_RPC_URL ?? "";
  let parsedUrl: URL;
  try { parsedUrl = new URL(rpcUrl); } catch { throw new BlockchainConfigurationError("INVALID_RPC_URL", "CHAIN_RPC_URL must be a valid URL"); }
  if (!new Set(["localhost", "127.0.0.1", "[::1]"]).has(parsedUrl.hostname.toLowerCase())) {
    throw new BlockchainConfigurationError("REMOTE_RPC_REJECTED", "Local EVM mode requires a loopback RPC hostname");
  }
  const configuredAddress = address(env.REGISTRY_CONTRACT_ADDRESS, "REGISTRY_CONTRACT_ADDRESS");
  const manifestPath = resolve(repositoryRoot, env.CONTRACT_MANIFEST_PATH?.trim() || `packages/contracts/deployments/${chainId}.json`);
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const manifest = validateManifest(raw);
  if (manifest.chainId !== chainId) throw new BlockchainConfigurationError("CHAIN_ID_MISMATCH", "Manifest chain ID does not equal CHAIN_ID");
  if (manifest.contractAddress !== configuredAddress) throw new BlockchainConfigurationError("CONTRACT_ADDRESS_MISMATCH", "Manifest address does not equal REGISTRY_CONTRACT_ADDRESS");
  const expectedAbiPath = resolve(repositoryRoot, "packages/contracts/abi/RealityRegistry.json");
  const abi = JSON.parse(await readFile(expectedAbiPath, "utf8")) as unknown;
  if (!Array.isArray(abi)) throw new BlockchainConfigurationError("INVALID_ABI", "RealityRegistry ABI export must be an array");
  return {
    chainId,
    rpcUrl,
    contractAddress: configuredAddress,
    relayerAddress: manifest.relayerAddress,
    reviewerAddress: manifest.reviewerAddress,
    confirmations: positiveInteger(env.CHAIN_CONFIRMATIONS, "CHAIN_CONFIRMATIONS", 1),
    receiptTimeoutMs: positiveInteger(env.CHAIN_RECEIPT_TIMEOUT_MS, "CHAIN_RECEIPT_TIMEOUT_MS", 30_000),
    manifest,
    abi
  };
}
