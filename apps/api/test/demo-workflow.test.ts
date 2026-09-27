import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RealityCommit } from "@realityfork/shared";
import { getAddress } from "viem";
import { MockBlockchainAdapter } from "../src/blockchain/mock.js";
import type {
  AnchorVerificationResult,
  BlockchainAdapter,
  ReviewedMergeAnchorRequest,
  SignedChallengeAnchorRequest,
  SignedCommitAnchorRequest,
  TransactionMetadata
} from "../src/blockchain/types.js";
import { prepareLocalEvmDemo } from "../src/demo-evm.js";
import { HISTORY_NOT_TRUTH_NOTICE, runDemoWorkflow } from "../src/demo.js";

const contractAddress = getAddress("0x1000000000000000000000000000000000000001");
const relayerAddress = getAddress("0x2000000000000000000000000000000000000002");
const reviewerAddress = getAddress("0x3000000000000000000000000000000000000003");
const reviewerToken = "deterministic-local-reviewer-token-32-bytes";
const domain = { chainId: 31_337, verifyingContract: contractAddress };

class LocalEvmDemoAdapter implements BlockchainAdapter {
  readonly mode = "evm" as const;
  readonly mock = false;
  private readonly delegate = new MockBlockchainAdapter({ contractAddress });

  private async evm(transaction: Promise<TransactionMetadata>): Promise<TransactionMetadata> {
    return { ...await transaction, mock: false };
  }
  anchorSignedCommit(request: SignedCommitAnchorRequest) { return this.evm(this.delegate.anchorSignedCommit(request)); }
  anchorSignedChallenge(request: SignedChallengeAnchorRequest) { return this.evm(this.delegate.anchorSignedChallenge(request)); }
  anchorReviewedMerge(request: ReviewedMergeAnchorRequest) { return this.evm(this.delegate.anchorReviewedMerge(request)); }
  getCommitAnchor(hash: string) { return this.delegate.getCommitAnchor(hash); }
  getTransactionStatus(hash: string) { return this.delegate.getTransactionStatus(hash); }
  async verifyCommitAnchor(commit: RealityCommit): Promise<AnchorVerificationResult> {
    const result = await this.delegate.verifyCommitAnchor(commit);
    return { ...result, mock: false };
  }
  async healthCheck() {
    return { ok: true, mode: "evm" as const, chainId: domain.chainId, contractAddress, mock: false, message: "Test local EVM" };
  }
}

test("mock fallback demo completes and labels every transaction as simulated", async () => {
  const result = await runDemoWorkflow({
    adapter: new MockBlockchainAdapter({ contractAddress }),
    signatureDomain: domain,
    reviewerToken
  });
  assert.equal(result.mode, "mock");
  assert.equal(result.simulated, true);
  assert.equal(result.root.blockchainAnchor.mock, true);
  assert.equal(result.fork.blockchainAnchor.mock, true);
  assert.equal(result.merge.blockchainAnchor.mock, true);
  assert.equal(result.history.length, 3);
  assert.equal(result.verification.status, "verified");
  assert.match(result.output.join("\n"), /SIMULATED/);
  assert.ok(result.output.includes(HISTORY_NOT_TRUTH_NOTICE));
});

test("local EVM demo performs root, fork, challenge, merge, proofs, and final verification in order", async () => {
  const result = await runDemoWorkflow({
    adapter: new LocalEvmDemoAdapter(),
    signatureDomain: domain,
    reviewerToken,
    proofReader: {
      read: async (transactionHash) => ({ transactionHash, blockNumber: "7", status: "success", events: ["CommitAnchored"] })
    }
  });
  assert.equal(result.mode, "evm");
  assert.equal(result.simulated, false);
  assert.deepEqual(result.parentStatusesBeforeMerge, ["challenged", "challenged"]);
  assert.deepEqual(result.parentStatusesAfterMerge, ["superseded", "superseded"]);
  assert.equal(result.merge.status, "merged");
  assert.equal(result.verification.status, "verified");
  assert.equal(result.verification.mock, false);
  assert.equal(result.transactionProofs.length, 4);
  assert.ok(result.transactionProofs.every((proof) => proof.status === "success"));
});

test("demo fails safely when reviewer token is missing or too short", async () => {
  await assert.rejects(runDemoWorkflow({
    adapter: new MockBlockchainAdapter({ contractAddress }), signatureDomain: domain
  }), /REVIEWER_AUTH_CONFIGURATION_MISSING/);
  await assert.rejects(runDemoWorkflow({
    adapter: new MockBlockchainAdapter({ contractAddress }), signatureDomain: domain, reviewerToken: "short"
  }), /REVIEWER_AUTH_TOKEN_TOO_SHORT/);
});

test("local EVM demo setup rejects invalid manifests and unavailable loopback RPC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "realityfork-demo-"));
  const manifestPath = join(directory, "manifest.json");
  const manifest = {
    manifestSchemaVersion: "realityfork.deployment.v1",
    contractName: "RealityRegistry",
    chainId: 31_337,
    networkName: "localhost",
    contractAddress,
    relayerAddress,
    reviewerAddress,
    eip712Domain: { name: "RealityFork", version: "2", chainId: 31_337, verifyingContract: contractAddress },
    abiPath: "packages/contracts/abi/RealityRegistry.json"
  };
  const environment = {
    CHAIN_ID: "31337", SIGNATURE_CHAIN_ID: "31337", CHAIN_RPC_URL: "http://127.0.0.1:1",
    REGISTRY_CONTRACT_ADDRESS: contractAddress, CONTRACT_MANIFEST_PATH: manifestPath
  };
  try {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, manifestSchemaVersion: "tampered" }), "utf8");
    await assert.rejects(prepareLocalEvmDemo(environment), /Unsupported deployment manifest schema/);
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    await assert.rejects(prepareLocalEvmDemo(environment));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
