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
import { MemoryNonceRepository } from "../src/nonce.js";
import { MemoryRealityStore } from "../src/store.js";

const DOMAIN: SignatureDomainConfig = {
  chainId: 31_337,
  verifyingContract: "0x1000000000000000000000000000000000000001"
};

const accountA = privateKeyToAccount(generatePrivateKey());
const accountB = privateKeyToAccount(generatePrivateKey());
const now = () => Math.floor(Date.now() / 1000);

function commitInput(address: string, seed = "5"): CreateCommitInput {
  return {
    parentIds: [],
    authorId: address.toLowerCase(),
    authorRole: "citizen",
    claim: {
      subjectId: `road-signed-${seed}`,
      field: "condition",
      value: "damaged",
      observedAt: "2026-09-26T09:25:00.000Z"
    },
    evidence: [{
      id: `${seed.repeat(8)}-${seed.repeat(4)}-4${seed.repeat(3)}-8${seed.repeat(3)}-${seed.repeat(12)}`,
      kind: "photo",
      uri: `ipfs://signed-${seed}`,
      sha256: seed.repeat(64),
      capturedAt: "2026-09-26T09:23:00.000Z"
    }],
    message: "Signed observation"
  };
}

async function signedCommitBody(
  store: MemoryRealityStore,
  input: CreateCommitInput,
  nonce: string,
  options: {
    signingAccount?: typeof accountA;
    signingDomain?: SignatureDomainConfig;
    envelopeSigner?: string;
    envelopeDomain?: SignatureDomainConfig;
    expiresAt?: number;
    commitHash?: string;
    evidenceRoot?: string;
    parentA?: string;
    parentB?: string;
  } = {}
) {
  const prepared = store.prepare(input);
  const signingAccount = options.signingAccount ?? accountA;
  const signingDomain = options.signingDomain ?? DOMAIN;
  const envelopeDomain = options.envelopeDomain ?? signingDomain;
  const expiresAt = options.expiresAt ?? now() + 3_600;
  const signerAddress = options.envelopeSigner ?? signingAccount.address.toLowerCase();
  const signature = await signingAccount.signTypedData(buildCommitAuthorizationTypedData(signingDomain, {
    commitHash: options.commitHash ?? prepared.commitHash,
    evidenceRoot: options.evidenceRoot ?? prepared.evidenceRoot,
    parentA: options.parentA ?? prepared.parentA,
    parentB: options.parentB ?? prepared.parentB,
    author: signerAddress,
    nonce,
    expiresAt
  }));
  return {
    input,
    authorization: {
      signerAddress,
      signature,
      nonce,
      expiresAt,
      chainId: envelopeDomain.chainId,
      registryContractAddress: envelopeDomain.verifyingContract
    }
  };
}

function challengeInput(address: string, note = "The timestamp is inconsistent"): ChallengeInput {
  return {
    challengerId: address.toLowerCase(),
    reason: "wrong_time",
    note,
    evidence: []
  };
}

async function signedChallengeBody(
  targetHash: string,
  input: ChallengeInput,
  nonce: string,
  options: {
    signingAccount?: typeof accountA;
    expiresAt?: number;
    challengeHash?: string;
    challengeEvidenceRoot?: string;
  } = {}
) {
  const expiresAt = options.expiresAt ?? now() + 3_600;
  const signingAccount = options.signingAccount ?? accountA;
  const envelope = {
    signerAddress: signingAccount.address.toLowerCase(),
    signature: "",
    nonce,
    expiresAt,
    chainId: DOMAIN.chainId,
    registryContractAddress: DOMAIN.verifyingContract
  };
  const prepared = prepareChallengeAuthorization(input, targetHash, { ...envelope, signature: `0x${"0".repeat(130)}` });
  const signature = await signingAccount.signTypedData(buildChallengeAuthorizationTypedData(DOMAIN, {
    challengeHash: options.challengeHash ?? prepared.challengeHash,
    targetCommitHash: prepared.targetCommitHash,
    challengeEvidenceRoot: options.challengeEvidenceRoot ?? prepared.challengeEvidenceRoot,
    challenger: envelope.signerAddress,
    nonce,
    expiresAt
  }));
  return { input, authorization: { ...envelope, signature } };
}

async function signedV1CommitBody(store: MemoryRealityStore, input: CreateCommitInput, nonce: string) {
  const prepared = store.prepare(input);
  const expiresAt = now() + 3_600;
  const signature = await accountA.signTypedData({
    domain: { name: "RealityFork", version: "1", ...DOMAIN },
    primaryType: "RealityCommitAuthorization",
    types: {
      RealityCommitAuthorization: [
        { name: "commitHash", type: "bytes32" },
        { name: "evidenceRoot", type: "bytes32" },
        { name: "author", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "expiresAt", type: "uint64" }
      ]
    },
    message: {
      commitHash: `0x${prepared.commitHash}` as `0x${string}`,
      evidenceRoot: `0x${prepared.evidenceRoot}` as `0x${string}`,
      author: accountA.address,
      nonce: BigInt(nonce),
      expiresAt: BigInt(expiresAt)
    }
  });
  return {
    input,
    authorization: {
      signerAddress: accountA.address.toLowerCase(), signature, nonce, expiresAt,
      chainId: DOMAIN.chainId, registryContractAddress: DOMAIN.verifyingContract
    }
  };
}

test("valid signed commit stores verified signature metadata", async () => {
  const store = new MemoryRealityStore();
  const app = await buildApp({ store, signatureDomain: DOMAIN });
  const body = await signedCommitBody(store, commitInput(accountA.address), "1");
  const response = await app.inject({ method: "POST", url: "/api/signed/commits", payload: body });
  assert.equal(response.statusCode, 201);
  const commit = response.json().commit;
  assert.equal(commit.authorization.signerAddress, accountA.address.toLowerCase());
  assert.equal(commit.authorization.nonce, "1");
  assert.equal(commit.authorization.signature, body.authorization.signature);
  await app.close();
});

test("altered commit hash and evidence root invalidate signatures without consuming nonce", async () => {
  const store = new MemoryRealityStore();
  const nonces = new MemoryNonceRepository();
  const app = await buildApp({ store, nonceRepository: nonces, signatureDomain: DOMAIN });
  const input = commitInput(accountA.address, "6");
  const badHash = await signedCommitBody(store, input, "20", { commitHash: "a".repeat(64) });
  assert.equal((await app.inject({ method: "POST", url: "/api/signed/commits", payload: badHash })).statusCode, 401);
  assert.equal(nonces.isUsed(accountA.address, "20"), false);
  const badRoot = await signedCommitBody(store, input, "20", { evidenceRoot: "b".repeat(64) });
  assert.equal((await app.inject({ method: "POST", url: "/api/signed/commits", payload: badRoot })).statusCode, 401);
  assert.equal(nonces.isUsed(accountA.address, "20"), false);
  const valid = await signedCommitBody(store, input, "20");
  assert.equal((await app.inject({ method: "POST", url: "/api/signed/commits", payload: valid })).statusCode, 201);
  await app.close();
});

test("V2 commit authorization binds canonical parents resolved from parent IDs", async () => {
  const store = new MemoryRealityStore();
  const firstParent = store.create(commitInput(accountB.address, "1"));
  const secondParent = store.create(commitInput(accountB.address, "2"));
  const app = await buildApp({ store, signatureDomain: DOMAIN });
  const forkInput = { ...commitInput(accountA.address, "3"), parentIds: [firstParent.id] };
  const wrongParent = await signedCommitBody(store, forkInput, "70", { parentA: secondParent.commitHash });
  const rejected = await app.inject({ method: "POST", url: `/api/signed/commits/${firstParent.id}/forks`, payload: wrongParent });
  assert.equal(rejected.statusCode, 401);
  assert.equal(rejected.json().code, "INVALID_SIGNATURE");
  const valid = await signedCommitBody(store, forkInput, "70");
  assert.equal((await app.inject({ method: "POST", url: `/api/signed/commits/${firstParent.id}/forks`, payload: valid })).statusCode, 201);
  await app.close();
});

test("V1 commit authorization and domain version 1 are rejected by the V2 API verifier", async () => {
  const store = new MemoryRealityStore();
  const app = await buildApp({ store, signatureDomain: DOMAIN });
  const body = await signedV1CommitBody(store, commitInput(accountA.address, "4"), "71");
  const response = await app.inject({ method: "POST", url: "/api/signed/commits", payload: body });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, "INVALID_SIGNATURE");
  await app.close();
});

test("wrong wallet and authorId mismatch are rejected", async () => {
  const store = new MemoryRealityStore();
  const app = await buildApp({ store, signatureDomain: DOMAIN });
  const inputForB = commitInput(accountB.address, "7");
  const wrongWallet = await signedCommitBody(store, inputForB, "21", {
    signingAccount: accountA,
    envelopeSigner: accountB.address.toLowerCase()
  });
  assert.equal((await app.inject({ method: "POST", url: "/api/signed/commits", payload: wrongWallet })).json().code, "INVALID_SIGNATURE");

  const inputWithWrongAuthor = commitInput(accountB.address, "8");
  const wrongAuthor = await signedCommitBody(store, inputWithWrongAuthor, "22", { signingAccount: accountA });
  assert.equal((await app.inject({ method: "POST", url: "/api/signed/commits", payload: wrongAuthor })).json().code, "AUTHOR_IDENTITY_MISMATCH");
  await app.close();
});

test("wrong chain and contract domains are rejected", async () => {
  const store = new MemoryRealityStore();
  const app = await buildApp({ store, signatureDomain: DOMAIN });
  const input = commitInput(accountA.address, "9");
  const wrongChainDomain = { ...DOMAIN, chainId: DOMAIN.chainId + 1 };
  const wrongChain = await signedCommitBody(store, input, "23", { signingDomain: wrongChainDomain, envelopeDomain: wrongChainDomain });
  assert.equal((await app.inject({ method: "POST", url: "/api/signed/commits", payload: wrongChain })).json().code, "CHAIN_ID_MISMATCH");

  const wrongContractDomain = { ...DOMAIN, verifyingContract: "0x2000000000000000000000000000000000000002" };
  const wrongContract = await signedCommitBody(store, input, "24", { signingDomain: wrongContractDomain, envelopeDomain: wrongContractDomain });
  assert.equal((await app.inject({ method: "POST", url: "/api/signed/commits", payload: wrongContract })).json().code, "CONTRACT_ADDRESS_MISMATCH");
  await app.close();
});

test("expired authorization is rejected without consuming its signer nonce", async () => {
  const store = new MemoryRealityStore();
  const nonces = new MemoryNonceRepository();
  const app = await buildApp({ store, nonceRepository: nonces, signatureDomain: DOMAIN });
  const input = commitInput(accountA.address, "a");
  const expired = await signedCommitBody(store, input, "25", { expiresAt: now() - 1 });
  const expiredResponse = await app.inject({ method: "POST", url: "/api/signed/commits", payload: expired });
  assert.equal(expiredResponse.json().code, "SIGNATURE_EXPIRED");
  assert.equal(nonces.isUsed(accountA.address, "25"), false);
  const fresh = await signedCommitBody(store, input, "25");
  assert.equal((await app.inject({ method: "POST", url: "/api/signed/commits", payload: fresh })).statusCode, 201);
  await app.close();
});

test("same signer cannot replay a nonce while different signers may use it", async () => {
  const store = new MemoryRealityStore();
  const app = await buildApp({ store, signatureDomain: DOMAIN });
  const first = await signedCommitBody(store, commitInput(accountA.address, "b"), "30");
  assert.equal((await app.inject({ method: "POST", url: "/api/signed/commits", payload: first })).statusCode, 201);
  const replay = await app.inject({ method: "POST", url: "/api/signed/commits", payload: first });
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.json().code, "NONCE_REPLAY");

  const secondSigner = await signedCommitBody(store, commitInput(accountB.address, "c"), "30", { signingAccount: accountB });
  assert.equal((await app.inject({ method: "POST", url: "/api/signed/commits", payload: secondSigner })).statusCode, 201);
  await app.close();
});

test("valid signed challenge is stored with its canonical proof", async () => {
  const store = new MemoryRealityStore();
  const target = store.create(commitInput(accountB.address, "d"));
  const app = await buildApp({ store, signatureDomain: DOMAIN });
  const input = challengeInput(accountA.address);
  const body = await signedChallengeBody(target.commitHash, input, "40");
  const response = await app.inject({ method: "POST", url: `/api/signed/commits/${target.id}/challenges`, payload: body });
  assert.equal(response.statusCode, 201);
  const challenge = response.json().challenge;
  assert.match(challenge.challengeHash, /^[a-f0-9]{64}$/);
  assert.match(challenge.challengeEvidenceRoot, /^[a-f0-9]{64}$/);
  assert.equal(challenge.authorization.signerAddress, accountA.address.toLowerCase());
  await app.close();
});

test("altered challenge note and evidence root invalidate the signature", async () => {
  const store = new MemoryRealityStore();
  const target = store.create(commitInput(accountB.address, "e"));
  const app = await buildApp({ store, signatureDomain: DOMAIN });
  const original = challengeInput(accountA.address);
  const alteredNoteBody = await signedChallengeBody(target.commitHash, original, "41");
  alteredNoteBody.input = { ...original, note: "A different note" };
  assert.equal((await app.inject({ method: "POST", url: `/api/signed/commits/${target.id}/challenges`, payload: alteredNoteBody })).json().code, "INVALID_SIGNATURE");

  const badRoot = await signedChallengeBody(target.commitHash, original, "42", { challengeEvidenceRoot: "f".repeat(64) });
  assert.equal((await app.inject({ method: "POST", url: `/api/signed/commits/${target.id}/challenges`, payload: badRoot })).json().code, "INVALID_SIGNATURE");
  await app.close();
});

test("unsigned submission is rejected unless demo mode is explicitly enabled", async () => {
  const input = commitInput(accountA.address, "f");
  const disabled = await buildApp({ allowUnsignedDemoMode: false });
  const rejected = await disabled.inject({ method: "POST", url: "/api/commits", payload: input });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.json().code, "UNSIGNED_DEMO_DISABLED");
  await disabled.close();

  const enabled = await buildApp({ allowUnsignedDemoMode: true });
  assert.equal((await enabled.inject({ method: "POST", url: "/api/commits", payload: input })).statusCode, 201);
  await enabled.close();
});
