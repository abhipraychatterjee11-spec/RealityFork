import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { network } from "hardhat";

export const MANIFEST_SCHEMA_VERSION = "realityfork.deployment.v1" as const;
export const EIP712_DOMAIN_NAME = "RealityFork" as const;
export const EIP712_DOMAIN_VERSION = "2" as const;
export const LOCAL_NETWORKS = new Set(["default", "hardhatMainnet", "localhost"]);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");

export interface DeploymentManifest {
  manifestSchemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  contractName: "RealityRegistry";
  chainId: number;
  networkName: string;
  contractAddress: Address;
  deploymentTransactionHash: Hex;
  deploymentBlockNumber: string;
  deployedAt: string;
  administratorAddress: Address;
  relayerAddress: Address;
  reviewerAddress: Address;
  eip712Domain: {
    name: typeof EIP712_DOMAIN_NAME;
    version: typeof EIP712_DOMAIN_VERSION;
    chainId: number;
    verifyingContract: Address;
  };
  abiPath: "packages/contracts/abi/RealityRegistry.json";
  gitCommitHash: string | null;
}

export interface DeploymentOptions {
  administratorAddress?: string;
  relayerAddress?: string;
  reviewerAddress?: string;
  manifestDirectory?: string;
  abiOutputPath?: string;
}

export function requireRoleAddress(value: string, label: string): Address {
  if (!isAddress(value, { strict: false })) throw new Error(`${label} must be a valid EVM address`);
  const address = getAddress(value);
  if (address === zeroAddress) throw new Error(`${label} must not be the zero address`);
  return address;
}

function requireLoopbackRpc(networkName: string): void {
  if (networkName !== "localhost") return;
  const rpcUrl = new URL(process.env.CHAIN_RPC_URL ?? "http://127.0.0.1:8545");
  const hostname = rpcUrl.hostname.toLowerCase();
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") {
    throw new Error(`Refusing local deployment through non-loopback RPC host '${rpcUrl.hostname}'`);
  }
}

function gitCommitHash(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || null;
  } catch {
    return null;
  }
}

export async function writeAbiExport(abi: readonly unknown[], outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(abi, null, 2)}\n`, "utf8");
}

export async function deployRealityRegistry(
  connection: Awaited<ReturnType<typeof network.create>>,
  options: DeploymentOptions = {}
) {
  if (!LOCAL_NETWORKS.has(connection.networkName)) {
    throw new Error(`Refusing deployment to non-local network '${connection.networkName}'`);
  }
  requireLoopbackRpc(connection.networkName);

  const publicClient = await connection.viem.getPublicClient();
  const wallets = await connection.viem.getWalletClients();
  if (wallets.length < 3) throw new Error("Local deployment requires at least three unlocked accounts");

  const administratorAddress = requireRoleAddress(
    options.administratorAddress ?? wallets[0]!.account.address,
    "Administrator address"
  );
  const relayerAddress = requireRoleAddress(options.relayerAddress ?? wallets[1]!.account.address, "Relayer address");
  const reviewerAddress = requireRoleAddress(options.reviewerAddress ?? wallets[2]!.account.address, "Reviewer address");
  const administratorWallet = wallets.find(
    (wallet) => getAddress(wallet.account.address) === administratorAddress
  );
  if (!administratorWallet) {
    throw new Error("Administrator address must be one of the unlocked local network accounts");
  }

  const chainId = await publicClient.getChainId();
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("Local network returned an invalid chain ID");
  const manifestDirectory = options.manifestDirectory ?? resolve(packageRoot, "deployments");
  const manifestPath = resolve(manifestDirectory, `${chainId}.json`);
  if (existsSync(manifestPath)) {
    throw new Error(`Deployment manifest already exists: ${manifestPath}`);
  }

  const { contract, deploymentTransaction } = await connection.viem.sendDeploymentTransaction(
    "RealityRegistry",
    [administratorAddress]
  );
  const deploymentReceipt = await publicClient.waitForTransactionReceipt({ hash: deploymentTransaction.hash });

  const relayerRole = await contract.read.RELAYER_ROLE();
  const reviewerRole = await contract.read.REVIEWER_ROLE();
  const relayerGrant = await contract.write.grantRole([relayerRole, relayerAddress], {
    account: administratorWallet.account
  });
  await publicClient.waitForTransactionReceipt({ hash: relayerGrant });
  const reviewerGrant = await contract.write.grantRole([reviewerRole, reviewerAddress], {
    account: administratorWallet.account
  });
  await publicClient.waitForTransactionReceipt({ hash: reviewerGrant });

  const domain = await contract.read.eip712Domain() as readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]];
  if (domain[1] !== EIP712_DOMAIN_NAME || domain[2] !== EIP712_DOMAIN_VERSION) {
    throw new Error("Deployed contract returned an unexpected EIP-712 domain");
  }
  const block = await publicClient.getBlock({ blockNumber: deploymentReceipt.blockNumber });
  const manifest: DeploymentManifest = {
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    contractName: "RealityRegistry",
    chainId,
    networkName: connection.networkName,
    contractAddress: getAddress(contract.address),
    deploymentTransactionHash: deploymentTransaction.hash,
    deploymentBlockNumber: deploymentReceipt.blockNumber.toString(10),
    deployedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
    administratorAddress,
    relayerAddress,
    reviewerAddress,
    eip712Domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId,
      verifyingContract: getAddress(contract.address)
    },
    abiPath: "packages/contracts/abi/RealityRegistry.json",
    gitCommitHash: gitCommitHash()
  };

  const abiOutputPath = options.abiOutputPath ?? resolve(packageRoot, "abi/RealityRegistry.json");
  await writeAbiExport(contract.abi, abiOutputPath);
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  return { contract, manifest, manifestPath, abiOutputPath };
}
