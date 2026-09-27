import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RealityCommit } from "@realityfork/shared";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { BlockchainConfigurationError, loadEvmAdapterConfig, validateManifest, type EvmAdapterConfig } from "../src/blockchain/config.js";
import { EvmBlockchainAdapter, type EvmClients } from "../src/blockchain/evm.js";
import { MockBlockchainAdapter } from "../src/blockchain/mock.js";
import type { SignedCommitAnchorRequest } from "../src/blockchain/types.js";
import { buildApp } from "../src/app.js";
import { MemoryRealityStore } from "../src/store.js";

const contractAddress = getAddress("0x1000000000000000000000000000000000000001");
const relayerAddress = getAddress("0x2000000000000000000000000000000000000002");
const reviewerAddress = getAddress("0x3000000000000000000000000000000000000003");
const authorAddress = getAddress("0x4000000000000000000000000000000000000004");
const hash = (character: string) => character.repeat(64);

const request: SignedCommitAnchorRequest = {
  commitHash: hash("a"), evidenceRoot: hash("b"), parentA: hash("0"), parentB: hash("0"),
  author: authorAddress, nonce: "1", expiresAt: 2_000_000_000, authorSignature: `0x${"1".repeat(130)}`
};

function commit(overrides: Partial<RealityCommit> = {}): RealityCommit {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    parentIds: [], authorId: authorAddress.toLowerCase(), authorRole: "citizen",
    claim: { subjectId: "road-adapter", field: "condition", value: "damaged", observedAt: "2026-09-26T09:25:00.000Z" },
    evidence: [{ id: "22222222-2222-4222-8222-222222222222", kind: "photo", uri: "ipfs://adapter", sha256: hash("b"), capturedAt: "2026-09-26T09:24:00.000Z" }],
    message: "Adapter test", commitHash: hash("a"), evidenceRoot: hash("b"), parentCommitHashes: [],
    createdAt: "2026-09-26T09:26:00.000Z", status: "active", evidenceStrength: 80,
    sourceReputation: 50, contradictionFlags: [],
    authorization: {
      signerAddress: authorAddress, signature: request.authorSignature, nonce: "1", expiresAt: 2_000_000_000,
      chainId: 31_337, registryContractAddress: contractAddress, verifiedAt: "2026-09-26T09:25:30.000Z"
    },
    ...overrides
  };
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestSchemaVersion: "realityfork.deployment.v1", contractName: "RealityRegistry", chainId: 31_337,
    networkName: "localhost", contractAddress, relayerAddress, reviewerAddress,
    eip712Domain: { name: "RealityFork", version: "2", chainId: 31_337, verifyingContract: contractAddress },
    abiPath: "packages/contracts/abi/RealityRegistry.json", ...overrides
  };
}

function config(): EvmAdapterConfig {
  return {
    chainId: 31_337, rpcUrl: "http://127.0.0.1:8545", contractAddress, relayerAddress, reviewerAddress,
    confirmations: 1, receiptTimeoutMs: 100, manifest: validateManifest(manifest()), abi: []
  };
}

function fakeClients(options: {
  receipt?: "success" | "reverted" | "timeout";
  anchor?: readonly [Hex, Hex, Hex, Hex, Address, Address, Address, bigint, number];
  unavailable?: boolean;
} = {}): EvmClients {
  const transactionHash = `0x${hash("c")}` as Hex;
  let domainRead = false;
  return {
    getChainId: async () => 31_337,
    getAddresses: async () => [relayerAddress, reviewerAddress],
    readContract: async (args) => {
      const name = args.functionName;
      if (name === "eip712Domain") {
        domainRead = true;
        return ["0x0f", "RealityFork", "2", 31_337n, contractAddress, `0x${hash("0")}`, []];
      }
      if (options.unavailable && domainRead) throw new Error("offline");
      if (name === "RELAYER_ROLE" || name === "REVIEWER_ROLE") return `0x${hash("d")}`;
      if (name === "hasRole") return true;
      if (name === "commitExists") return options.anchor !== undefined;
      if (name === "getCommit") return options.anchor;
      throw new Error(`Unexpected read ${String(name)}`);
    },
    waitForTransactionReceipt: async () => {
      if (options.receipt === "timeout") throw new Error("timeout");
      return { status: options.receipt ?? "success", blockNumber: 7n, transactionHash };
    },
    getTransactionReceipt: async () => ({ status: "success", blockNumber: 7n, transactionHash }),
    relayerWrite: async () => transactionHash,
    reviewerWrite: async () => transactionHash
  };
}

test("mock adapter anchors deterministically, is idempotent, and exposes mock metadata", async () => {
  const adapter = new MockBlockchainAdapter({ contractAddress });
  const [first, duplicate] = await Promise.all([adapter.anchorSignedCommit(request), adapter.anchorSignedCommit(request)]);
  assert.deepEqual(first, duplicate);
  assert.equal(first.status, "confirmed");
  assert.equal(first.mock, true);
  assert.equal((await adapter.verifyCommitAnchor(commit())).status, "verified");
  assert.equal((await adapter.verifyCommitAnchor(commit({ evidenceRoot: hash("e") }))).status, "mismatch");
  assert.equal((await new MockBlockchainAdapter().verifyCommitAnchor(commit())).status, "not_found");
});

test("mock adapter supports configured pending and failed outcomes", async () => {
  assert.equal((await new MockBlockchainAdapter({ outcome: "pending" }).anchorSignedCommit(request)).status, "pending");
  const failed = await new MockBlockchainAdapter({ outcome: "failed" }).anchorSignedCommit(request);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "MOCK_FAILURE");
  assert.equal(failed.mock, true);
});

test("manifest validation rejects schema and EIP-712 domain errors", () => {
  assert.throws(() => validateManifest(manifest({ manifestSchemaVersion: "future" })), /Unsupported deployment manifest schema/);
  assert.throws(() => validateManifest(manifest({ eip712Domain: { name: "RealityFork", version: "1", chainId: 31_337, verifyingContract: contractAddress } })), /version 2/);
});

test("EVM configuration rejects chain/address mismatch and remote RPC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "realityfork-adapter-"));
  const path = join(directory, "manifest.json");
  try {
    await writeFile(path, JSON.stringify(manifest()), "utf8");
    const base = {
      CHAIN_ID: "31337", SIGNATURE_CHAIN_ID: "31337", CHAIN_RPC_URL: "http://127.0.0.1:8545",
      REGISTRY_CONTRACT_ADDRESS: contractAddress, CONTRACT_MANIFEST_PATH: path
    };
    await assert.rejects(loadEvmAdapterConfig({ ...base, CHAIN_ID: "1", SIGNATURE_CHAIN_ID: "1" }), /Manifest chain ID/);
    await assert.rejects(loadEvmAdapterConfig({ ...base, REGISTRY_CONTRACT_ADDRESS: authorAddress }), /Manifest address/);
    await assert.rejects(loadEvmAdapterConfig({ ...base, CHAIN_RPC_URL: "https://rpc.example.com" }), /loopback RPC/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("EVM adapter handles confirmation, revert, timeout, and idempotency", async () => {
  const confirmedAdapter = await EvmBlockchainAdapter.create(config(), fakeClients());
  const [confirmed, duplicate] = await Promise.all([
    confirmedAdapter.anchorSignedCommit(request), confirmedAdapter.anchorSignedCommit(request)
  ]);
  assert.equal(confirmed.status, "confirmed");
  assert.deepEqual(confirmed, duplicate);
  assert.equal(confirmed.blockNumber, "7");

  const reverted = await (await EvmBlockchainAdapter.create(config(), fakeClients({ receipt: "reverted" }))).anchorSignedCommit(request);
  assert.equal(reverted.status, "failed");
  assert.equal(reverted.errorCode, "TRANSACTION_REVERTED");

  const timedOut = await (await EvmBlockchainAdapter.create(config(), fakeClients({ receipt: "timeout" }))).anchorSignedCommit(request);
  assert.equal(timedOut.status, "pending");
  assert.equal(timedOut.errorCode, "RECEIPT_TIMEOUT");
});

test("EVM adapter rejects an RPC chain ID that differs from the manifest", async () => {
  const clients = fakeClients();
  clients.getChainId = async () => 1;
  await assert.rejects(EvmBlockchainAdapter.create(config(), clients), /RPC_CHAIN_ID_MISMATCH/);
});

test("EVM verification reports confirmed, missing, parent mismatch, and unavailable", async () => {
  const anchored = [
    `0x${hash("a")}`, `0x${hash("b")}`, `0x${hash("0")}`, `0x${hash("0")}`,
    authorAddress, relayerAddress, zeroAddress, 1_700_000_000n, 0
  ] as const;
  const adapter = await EvmBlockchainAdapter.create(config(), fakeClients({ anchor: anchored }));
  assert.equal((await adapter.verifyCommitAnchor(commit())).status, "verified");
  assert.equal((await adapter.verifyCommitAnchor(commit({ parentCommitHashes: [hash("e")] }))).status, "mismatch");
  assert.equal((await (await EvmBlockchainAdapter.create(config(), fakeClients())).verifyCommitAnchor(commit())).status, "not_found");

  const unavailableAdapter = await EvmBlockchainAdapter.create(config(), fakeClients({ unavailable: true }));
  assert.equal((await unavailableAdapter.verifyCommitAnchor(commit())).status, "network_unavailable");
});

test("API exposes blockchain health and verification for an unsigned mock-only record", async () => {
  const store = new MemoryRealityStore();
  const adapter = new MockBlockchainAdapter({ contractAddress });
  const app = await buildApp({ store, blockchainAdapter: adapter, allowUnsignedDemoMode: true });
  const health = await app.inject({ method: "GET", url: "/api/blockchain/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().mock, true);
  const created = await app.inject({ method: "POST", url: "/api/commits", payload: {
    parentIds: [], authorId: "demo", authorRole: "citizen",
    claim: { subjectId: "road-api", field: "condition", value: "damaged", observedAt: "2026-09-26T09:25:00.000Z" },
    evidence: [{ id: "33333333-3333-4333-8333-333333333333", kind: "photo", uri: "ipfs://api", sha256: hash("3"), capturedAt: "2026-09-26T09:24:00.000Z" }],
    message: "Demo"
  }});
  const createdCommit = created.json().commit;
  const verification = await app.inject({ method: "GET", url: `/api/commits/${createdCommit.id}/blockchain-verification` });
  assert.equal(verification.json().verification.status, "not_found");
  await app.close();
});
