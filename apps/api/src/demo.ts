import { createHash } from "node:crypto";
import {
  buildChallengeAuthorizationTypedData,
  buildCommitAuthorizationTypedData,
  type ChallengeInput,
  type CreateCommitInput,
  type RealityCommit,
  type SignatureDomainConfig
} from "@realityfork/shared";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { BlockchainAdapter } from "./blockchain/types.js";
import { buildApp } from "./app.js";
import { prepareChallengeAuthorization } from "./authorization.js";
import { MemoryRealityStore } from "./store.js";

export const DEMO_SUBJECT_ID = "synthetic-road-a17";
export const HISTORY_NOT_TRUTH_NOTICE = "Anchoring proves this record history, not that any real-world observation is true.";

export interface DemoTransactionProof {
  transactionHash: string;
  blockNumber?: string;
  status: string;
  events: string[];
}

export interface DemoProofReader {
  read(transactionHash: string): Promise<DemoTransactionProof>;
}

export interface DemoRunOptions {
  adapter: BlockchainAdapter;
  signatureDomain: SignatureDomainConfig;
  reviewerToken?: string;
  proofReader?: DemoProofReader;
  write?: (line: string) => void;
}

export interface DemoRunResult {
  mode: "mock" | "evm";
  simulated: boolean;
  root: RealityCommit;
  fork: RealityCommit;
  merge: RealityCommit;
  challenge: Record<string, unknown>;
  history: RealityCommit[];
  verification: Record<string, unknown>;
  parentStatusesBeforeMerge: [string, string];
  parentStatusesAfterMerge: [string, string];
  transactionProofs: DemoTransactionProof[];
  output: string[];
}

class DemoFailure extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
}

const digest = (value: string) => createHash("sha256").update(`realityfork-demo:${value}`, "utf8").digest("hex");
const expiresAt = () => Math.floor(Date.now() / 1000) + 3_600;

function evidence(seed: string, id: string, kind: "photo" | "document" = "photo") {
  return {
    id,
    kind,
    uri: `synthetic://realityfork-demo/${seed}`,
    sha256: digest(seed),
    capturedAt: "2026-09-27T09:00:00.000Z",
    aiRiskScore: seed === "citizen-damage" ? 0.42 : 0.08
  } as const;
}

function commitInput(
  authorId: string,
  authorRole: CreateCommitInput["authorRole"],
  value: string,
  message: string,
  evidenceSeed: string,
  evidenceId: string,
  parentIds: string[] = []
): CreateCommitInput {
  return {
    parentIds,
    authorId: authorId.toLowerCase(),
    authorRole,
    claim: {
      subjectId: DEMO_SUBJECT_ID,
      field: "surfaceCondition",
      value,
      observedAt: "2026-09-27T09:00:00.000Z",
      locationLabel: "Synthetic demonstration corridor A17"
    },
    evidence: [evidence(evidenceSeed, evidenceId)],
    message
  };
}

async function signedCommitBody(
  store: MemoryRealityStore,
  input: CreateCommitInput,
  account: ReturnType<typeof privateKeyToAccount>,
  nonce: string,
  domain: SignatureDomainConfig
) {
  const prepared = store.prepare(input);
  const expiry = expiresAt();
  const signature = await account.signTypedData(buildCommitAuthorizationTypedData(domain, {
    ...prepared,
    author: account.address,
    nonce,
    expiresAt: expiry
  }));
  return {
    input,
    authorization: {
      signerAddress: account.address.toLowerCase(), signature, nonce, expiresAt: expiry,
      chainId: domain.chainId, registryContractAddress: domain.verifyingContract
    }
  };
}

async function signedChallengeBody(
  targetCommitHash: string,
  input: ChallengeInput,
  account: ReturnType<typeof privateKeyToAccount>,
  nonce: string,
  domain: SignatureDomainConfig
) {
  const expiry = expiresAt();
  const envelope = {
    signerAddress: account.address.toLowerCase(), signature: `0x${"0".repeat(130)}`,
    nonce, expiresAt: expiry, chainId: domain.chainId, registryContractAddress: domain.verifyingContract
  };
  const prepared = prepareChallengeAuthorization(input, targetCommitHash, envelope);
  const signature = await account.signTypedData(buildChallengeAuthorizationTypedData(domain, {
    ...prepared, challenger: account.address, nonce, expiresAt: expiry
  }));
  return { input, authorization: { ...envelope, signature } };
}

function parseSuccess(response: { statusCode: number; json(): unknown }, step: string): Record<string, any> {
  const body = response.json() as Record<string, any>;
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new DemoFailure(String(body.code ?? "DEMO_REQUEST_FAILED"), `${step} failed with HTTP ${response.statusCode}: ${String(body.error ?? "unknown error")}`);
  }
  return body;
}

function describeCommit(label: string, commit: RealityCommit, output: (line: string) => void): void {
  output(`${label}: id=${commit.id}`);
  output(`  commitHash=${commit.commitHash}`);
  output(`  parentHashes=${commit.parentCommitHashes.length ? commit.parentCommitHashes.join(",") : "none"}`);
  output(`  evidenceRoot=${commit.evidenceRoot}`);
  output(`  contradictions=${commit.contradictionFlags.length ? commit.contradictionFlags.join(" | ") : "none"}`);
  output(`  anchor=${commit.blockchainAnchor.status} mock=${commit.blockchainAnchor.mock} tx=${commit.blockchainAnchor.transactionHash ?? "none"}`);
}

export async function runDemoWorkflow(options: DemoRunOptions): Promise<DemoRunResult> {
  const lines: string[] = [];
  const output = (line: string) => { lines.push(line); options.write?.(line); };
  if (!options.reviewerToken) throw new DemoFailure("REVIEWER_AUTH_CONFIGURATION_MISSING", "REVIEWER_API_TOKEN is required and is never printed");
  if (Buffer.byteLength(options.reviewerToken, "utf8") < 32) throw new DemoFailure("REVIEWER_AUTH_TOKEN_TOO_SHORT", "REVIEWER_API_TOKEN must contain at least 32 bytes");
  if (options.adapter.mode === "evm" && options.adapter.mock) throw new DemoFailure("INVALID_ADAPTER_MODE", "EVM demo cannot use a mock adapter");

  output("=== RealityFork deterministic local demo ===");
  output(options.adapter.mock
    ? "MODE: MOCK FALLBACK — all transaction hashes are SIMULATED; no blockchain is contacted."
    : "MODE: LOCAL EVM — loopback Hardhat RPC and validated deployment manifest required.");
  output(`Chain ID: ${options.signatureDomain.chainId}`);
  output(`Contract address: ${options.signatureDomain.verifyingContract}`);
  output("Dataset: synthetic Road A17 metadata only; no real people, media, coordinates, or government records.");

  const official = privateKeyToAccount(generatePrivateKey());
  const citizen = privateKeyToAccount(generatePrivateKey());
  const challenger = privateKeyToAccount(generatePrivateKey());
  const mergeAuthor = privateKeyToAccount(generatePrivateKey());
  const store = new MemoryRealityStore();
  const app = await buildApp({
    store,
    signatureDomain: options.signatureDomain,
    blockchainAdapter: options.adapter,
    reviewerApiToken: options.reviewerToken
  });
  const proofs: DemoTransactionProof[] = [];

  try {
    const rootInput = commitInput(
      official.address, "official", "serviceable", "Synthetic official baseline for Road A17",
      "official-baseline", "11111111-1111-4111-8111-111111111111"
    );
    const rootBody = await signedCommitBody(store, rootInput, official, "1001", options.signatureDomain);
    const rootResponse = parseSuccess(await app.inject({ method: "POST", url: "/api/signed/commits", payload: rootBody }), "root commit");
    const root = rootResponse.commit as RealityCommit;
    describeCommit("1. Official root", root, output);

    const forkInput = commitInput(
      citizen.address, "citizen", "damaged", "Synthetic citizen observation conflicts with baseline",
      "citizen-damage", "22222222-2222-4222-8222-222222222222", [root.id]
    );
    const forkBody = await signedCommitBody(store, forkInput, citizen, "2001", options.signatureDomain);
    const forkResponse = parseSuccess(await app.inject({
      method: "POST", url: `/api/signed/commits/${root.id}/forks`, payload: forkBody
    }), "citizen fork");
    const fork = forkResponse.commit as RealityCommit;
    describeCommit("2. Conflicting citizen fork", fork, output);

    const challengeInput: ChallengeInput = {
      challengerId: challenger.address.toLowerCase(),
      reason: "contradictory_evidence",
      note: "Synthetic challenge: baseline and citizen observation conflict and require review.",
      evidence: [evidence("challenge-note", "33333333-3333-4333-8333-333333333333", "document")]
    };
    const challengeBody = await signedChallengeBody(root.commitHash, challengeInput, challenger, "3001", options.signatureDomain);
    const challengeResponse = parseSuccess(await app.inject({
      method: "POST", url: `/api/signed/commits/${root.id}/challenges`, payload: challengeBody
    }), "signed challenge");
    const challenge = challengeResponse.challenge as Record<string, any>;
    output(`3. Signed challenge: id=${String(challenge.id)} hash=${String(challenge.challengeHash)}`);
    output(`  anchor=${String(challenge.blockchainAnchor.status)} mock=${String(challenge.blockchainAnchor.mock)} tx=${String(challenge.blockchainAnchor.transactionHash ?? "none")}`);

    const before: [string, string] = [store.get(root.id)!.status, store.get(fork.id)!.status];
    output(`4. Before reviewed merge: root=${before[0]} fork=${before[1]} (neither is superseded)`);
    const mergeInput = commitInput(
      mergeAuthor.address, "reviewer", "review-required", "Synthetic reviewed merge preserves both competing branches",
      "review-resolution", "44444444-4444-4444-8444-444444444444", [root.id, fork.id]
    );
    const mergeBody = await signedCommitBody(store, mergeInput, mergeAuthor, "4001", options.signatureDomain);
    const mergeResponse = parseSuccess(await app.inject({
      method: "POST",
      url: "/api/signed/merges",
      headers: { "x-reviewer-token": options.reviewerToken },
      payload: mergeBody
    }), "reviewed merge");
    const merge = mergeResponse.commit as RealityCommit;
    describeCommit("5. Reviewed merge", merge, output);
    const after: [string, string] = [store.get(root.id)!.status, store.get(fork.id)!.status];
    output(`  after merge confirmation: root=${after[0]} fork=${after[1]}`);

    const verificationResponse = parseSuccess(await app.inject({
      method: "GET", url: `/api/commits/${merge.id}/blockchain-verification`
    }), "final anchor verification");
    const verification = verificationResponse.verification as Record<string, unknown>;
    output(`6. Final anchor verification: status=${String(verification.status)} mock=${String(verification.mock)}`);

    const historyResponse = parseSuccess(await app.inject({
      method: "GET", url: `/api/records/${DEMO_SUBJECT_ID}/history`
    }), "Reality history");
    const history = historyResponse.commits as RealityCommit[];
    output(`7. Reality history: ${history.length} commits preserved (root, fork, merge); disagreement was not erased.`);

    if (options.proofReader) {
      for (const record of [root, fork, { blockchainAnchor: challenge.blockchainAnchor }, merge]) {
        const transactionHash = record.blockchainAnchor.transactionHash as string | undefined;
        if (!transactionHash) continue;
        const proof = await options.proofReader.read(transactionHash);
        proofs.push(proof);
        output(`  receipt tx=${proof.transactionHash} block=${proof.blockNumber ?? "pending"} status=${proof.status} events=${proof.events.join(",") || "none"}`);
      }
    }

    output(HISTORY_NOT_TRUTH_NOTICE);
    return {
      mode: options.adapter.mode,
      simulated: options.adapter.mock,
      root,
      fork,
      merge,
      challenge,
      history,
      verification,
      parentStatusesBeforeMerge: before,
      parentStatusesAfterMerge: after,
      transactionProofs: proofs,
      output: lines
    };
  } finally {
    await app.close();
  }
}
