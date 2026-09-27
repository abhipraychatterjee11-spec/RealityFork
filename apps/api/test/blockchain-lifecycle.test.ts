import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChallengeAuthorizationTypedData,
  buildCommitAuthorizationTypedData,
  type ChallengeInput,
  type CreateCommitInput,
  type SignatureDomainConfig
} from "@realityfork/shared";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildApp } from "../src/app.js";
import { prepareChallengeAuthorization } from "../src/authorization.js";
import { MockBlockchainAdapter } from "../src/blockchain/mock.js";
import type { AnchorVerificationResult, BlockchainAdapter } from "../src/blockchain/types.js";
import { MemoryRealityStore } from "../src/store.js";

const DOMAIN: SignatureDomainConfig = {
  chainId: 31_337,
  verifyingContract: "0x1000000000000000000000000000000000000001"
};
const account = privateKeyToAccount(generatePrivateKey());
const REVIEWER_TOKEN = "reviewer-test-token-with-at-least-32-bytes";
const now = () => Math.floor(Date.now() / 1000);

function input(seed: string, parentIds: string[] = []): CreateCommitInput {
  return {
    parentIds,
    authorId: account.address.toLowerCase(),
    authorRole: "citizen",
    claim: { subjectId: `road-${seed}`, field: "condition", value: `value-${seed}`, observedAt: "2026-09-26T09:25:00.000Z" },
    evidence: [{
      id: `${seed.repeat(8)}-${seed.repeat(4)}-4${seed.repeat(3)}-8${seed.repeat(3)}-${seed.repeat(12)}`,
      kind: "photo",
      uri: `ipfs://${seed}`,
      sha256: seed.repeat(64),
      capturedAt: "2026-09-26T09:24:00.000Z"
    }],
    message: `Signed ${seed}`
  };
}

async function signedCommit(store: MemoryRealityStore, value: CreateCommitInput, nonce: string) {
  const prepared = store.prepare(value);
  const expiresAt = now() + 3_600;
  const signature = await account.signTypedData(buildCommitAuthorizationTypedData(DOMAIN, {
    ...prepared,
    author: account.address,
    nonce,
    expiresAt
  }));
  return { input: value, authorization: {
    signerAddress: account.address.toLowerCase(), signature, nonce, expiresAt,
    chainId: DOMAIN.chainId, registryContractAddress: DOMAIN.verifyingContract
  } };
}

async function signedChallenge(targetHash: string, nonce: string) {
  const challengeInput: ChallengeInput = {
    challengerId: account.address.toLowerCase(), reason: "wrong_time", note: "Conflicting timestamp", evidence: []
  };
  const expiresAt = now() + 3_600;
  const emptySignature = `0x${"0".repeat(130)}`;
  const envelope = {
    signerAddress: account.address.toLowerCase(), signature: emptySignature, nonce, expiresAt,
    chainId: DOMAIN.chainId, registryContractAddress: DOMAIN.verifyingContract
  };
  const prepared = prepareChallengeAuthorization(challengeInput, targetHash, envelope);
  const signature = await account.signTypedData(buildChallengeAuthorizationTypedData(DOMAIN, {
    ...prepared, challenger: account.address, nonce, expiresAt
  }));
  return { input: challengeInput, authorization: { ...envelope, signature } };
}

async function createSigned(app: Awaited<ReturnType<typeof buildApp>>, store: MemoryRealityStore, value: CreateCommitInput, nonce: string, url = "/api/signed/commits") {
  return app.inject({
    method: "POST",
    url,
    headers: url === "/api/signed/merges" ? { "x-reviewer-token": REVIEWER_TOKEN } : undefined,
    payload: await signedCommit(store, value, nonce)
  });
}

class EvmMismatchAdapter implements BlockchainAdapter {
  readonly mode = "evm" as const;
  readonly mock = false;
  constructor(private readonly delegate = new MockBlockchainAdapter({ contractAddress: DOMAIN.verifyingContract })) {}
  anchorSignedCommit(request: Parameters<BlockchainAdapter["anchorSignedCommit"]>[0]) { return this.delegate.anchorSignedCommit(request); }
  anchorSignedChallenge(request: Parameters<BlockchainAdapter["anchorSignedChallenge"]>[0]) { return this.delegate.anchorSignedChallenge(request); }
  anchorReviewedMerge(request: Parameters<BlockchainAdapter["anchorReviewedMerge"]>[0]) { return this.delegate.anchorReviewedMerge(request); }
  getCommitAnchor(hash: string) { return this.delegate.getCommitAnchor(hash); }
  getTransactionStatus(hash: string) { return this.delegate.getTransactionStatus(hash); }
  healthCheck() { return this.delegate.healthCheck(); }
  async verifyCommitAnchor(): Promise<AnchorVerificationResult> {
    return {
      status: "mismatch", chainId: DOMAIN.chainId, contractAddress: DOMAIN.verifyingContract,
      mock: false, mismatches: ["parentA"], message: "Injected reconciliation mismatch"
    };
  }
}

test("signed root, fork, challenge, and reviewed merge receive confirmed mock anchors", async () => {
  const store = new MemoryRealityStore();
  const app = await buildApp({ store, signatureDomain: DOMAIN, blockchainAdapter: new MockBlockchainAdapter(), reviewerApiToken: REVIEWER_TOKEN });
  const root = (await createSigned(app, store, input("1"), "1")).json().commit;
  assert.equal(root.blockchainAnchor.status, "confirmed");
  assert.equal(root.blockchainAnchor.mock, true);
  const fork = (await createSigned(app, store, input("2", [root.id]), "2", `/api/signed/commits/${root.id}/forks`)).json().commit;
  assert.equal(fork.blockchainAnchor.status, "confirmed");
  const challengeResponse = await app.inject({
    method: "POST", url: `/api/signed/commits/${fork.id}/challenges`, payload: await signedChallenge(fork.commitHash, "3")
  });
  assert.equal(challengeResponse.json().anchor.status, "confirmed");

  const secondParent = (await createSigned(app, store, input("3"), "4")).json().commit;
  const mergeResponse = await createSigned(app, store, input("4", [fork.id, secondParent.id]), "5", "/api/signed/merges");
  const merge = mergeResponse.json().commit;
  assert.equal(merge.blockchainAnchor.status, "confirmed");
  assert.equal(merge.status, "merged");
  assert.equal(store.get(fork.id)?.status, "superseded");
  assert.equal(store.get(secondParent.id)?.status, "superseded");
  await app.close();
});

test("pending and failed anchors preserve records and do not supersede merge parents", async () => {
  for (const outcome of ["pending", "failed"] as const) {
    const store = new MemoryRealityStore();
    const parentA = store.create(input("5"));
    const parentB = store.create(input("6"));
    const app = await buildApp({ store, signatureDomain: DOMAIN, blockchainAdapter: new MockBlockchainAdapter({ outcome }), reviewerApiToken: REVIEWER_TOKEN });
    const response = await createSigned(app, store, input("7", [parentA.id, parentB.id]), outcome === "pending" ? "6" : "7", "/api/signed/merges");
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().anchor.status, outcome);
    assert.equal(store.get(parentA.id)?.status, "active");
    assert.equal(store.get(parentB.id)?.status, "active");
    assert.ok(store.get(response.json().commit.id));
    await app.close();
  }
});

test("reviewed merge creation and retry require reviewer API authorization", async () => {
  const store = new MemoryRealityStore();
  const parentA = store.create(input("b"));
  const parentB = store.create(input("c"));
  const body = await signedCommit(store, input("d", [parentA.id, parentB.id]), "11");
  const unconfigured = await buildApp({
    store, signatureDomain: DOMAIN, blockchainAdapter: new MockBlockchainAdapter({ outcome: "pending" })
  });
  const unavailable = await unconfigured.inject({ method: "POST", url: "/api/signed/merges", payload: body });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().code, "REVIEWER_AUTH_CONFIGURATION_MISSING");
  await unconfigured.close();

  const app = await buildApp({
    store,
    signatureDomain: DOMAIN,
    blockchainAdapter: new MockBlockchainAdapter({ outcome: "pending" }),
    reviewerApiToken: REVIEWER_TOKEN
  });
  const missing = await app.inject({ method: "POST", url: "/api/signed/merges", payload: body });
  assert.equal(missing.statusCode, 403);
  assert.equal(missing.json().code, "REVIEWER_AUTH_REQUIRED");
  const wrong = await app.inject({ method: "POST", url: "/api/signed/merges", headers: { "x-reviewer-token": "wrong" }, payload: body });
  assert.equal(wrong.statusCode, 403);

  const created = await app.inject({
    method: "POST", url: "/api/signed/merges", headers: { "x-reviewer-token": REVIEWER_TOKEN }, payload: body
  });
  assert.equal(created.statusCode, 201);
  const mergeId = created.json().commit.id;
  assert.equal((await app.inject({ method: "POST", url: `/api/commits/${mergeId}/blockchain-anchor` })).statusCode, 403);
  assert.equal((await app.inject({
    method: "POST", url: `/api/commits/${mergeId}/blockchain-anchor`, headers: { "x-reviewer-token": REVIEWER_TOKEN }
  })).statusCode, 200);
  await app.close();
});

test("failed commit and challenge anchors can retry, while confirmed retries are blocked and duplicates coalesce", async () => {
  const store = new MemoryRealityStore();
  const adapter = new MockBlockchainAdapter({ outcome: "failed" });
  const app = await buildApp({ store, signatureDomain: DOMAIN, blockchainAdapter: adapter });
  const failed = await createSigned(app, store, input("8"), "8");
  const commit = failed.json().commit;
  assert.equal(commit.blockchainAnchor.status, "failed");
  assert.ok(store.get(commit.id));

  adapter.setOutcome("confirmed");
  const [retryA, retryB] = await Promise.all([
    app.inject({ method: "POST", url: `/api/commits/${commit.id}/blockchain-anchor` }),
    app.inject({ method: "POST", url: `/api/commits/${commit.id}/blockchain-anchor` })
  ]);
  assert.equal(retryA.json().anchor.status, "confirmed");
  assert.equal(retryB.json().anchor.status, "confirmed");
  const blocked = await app.inject({ method: "POST", url: `/api/commits/${commit.id}/blockchain-anchor` });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().code, "ANCHOR_ALREADY_CONFIRMED");

  adapter.setOutcome("failed");
  const challengeResponse = await app.inject({
    method: "POST", url: `/api/signed/commits/${commit.id}/challenges`, payload: await signedChallenge(commit.commitHash, "9")
  });
  const challenge = challengeResponse.json().challenge;
  assert.equal(challenge.blockchainAnchor.status, "failed");
  adapter.setOutcome("confirmed");
  const challengeRetry = await app.inject({ method: "POST", url: `/api/challenges/${challenge.id}/blockchain-anchor` });
  assert.equal(challengeRetry.json().anchor.status, "confirmed");
  await app.close();
});

test("EVM mode rejects unsigned writes and treats post-confirmation verification mismatch as failed", async () => {
  const store = new MemoryRealityStore();
  const adapter = new EvmMismatchAdapter();
  const app = await buildApp({ store, signatureDomain: DOMAIN, blockchainAdapter: adapter, allowUnsignedDemoMode: true });
  const unsigned = await app.inject({ method: "POST", url: "/api/commits", payload: input("9") });
  assert.equal(unsigned.statusCode, 403);

  const response = await createSigned(app, store, input("a"), "10");
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().anchor.status, "failed");
  assert.equal(response.json().anchor.errorCode, "ANCHOR_VERIFICATION_MISMATCH");
  assert.deepEqual(response.json().anchor.verificationMismatches, ["parentA"]);
  assert.ok(store.get(response.json().commit.id));
  await app.close();
});
