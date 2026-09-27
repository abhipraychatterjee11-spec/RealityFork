import { createHash } from "node:crypto";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import type { RealityCommit } from "@realityfork/shared";
import type {
  AnchorVerificationResult,
  BlockchainAdapter,
  BlockchainHealth,
  CommitAnchor,
  ReviewedMergeAnchorRequest,
  SignedChallengeAnchorRequest,
  SignedCommitAnchorRequest,
  TransactionMetadata,
  TransactionState
} from "./types.js";

const ZERO_DIGEST = "0".repeat(64);

export interface MockBlockchainAdapterOptions {
  outcome?: TransactionState;
  chainId?: number;
  contractAddress?: Address;
  failureCode?: string;
  failureMessage?: string;
}

function fakeHash(kind: string, key: string): Hex {
  return `0x${createHash("sha256").update(`realityfork:mock:${kind}:${key}`).digest("hex")}`;
}

function normalizeDigest(value: string): string {
  return value.toLowerCase().replace(/^0x/, "");
}

export class MockBlockchainAdapter implements BlockchainAdapter {
  readonly mode = "mock" as const;
  readonly mock = true;
  private readonly anchors = new Map<string, CommitAnchor>();
  private readonly transactions = new Map<string, TransactionMetadata>();
  private readonly submissions = new Map<string, Promise<TransactionMetadata>>();
  private outcome: TransactionState;
  private readonly failureCode: string;
  private readonly failureMessage: string;
  readonly chainId: number;
  readonly contractAddress: Address;

  constructor(options: MockBlockchainAdapterOptions = {}) {
    this.outcome = options.outcome ?? "confirmed";
    this.failureCode = options.failureCode ?? "MOCK_FAILURE";
    this.failureMessage = options.failureMessage ?? "Mock blockchain submission failed";
    this.chainId = options.chainId ?? 31_337;
    this.contractAddress = options.contractAddress ?? "0x1000000000000000000000000000000000000001";
  }

  setOutcome(outcome: TransactionState): void {
    this.outcome = outcome;
  }

  anchorSignedCommit(request: SignedCommitAnchorRequest): Promise<TransactionMetadata> {
    return this.submit("commit", request.commitHash, () => {
      if (this.outcome === "confirmed") this.storeAnchor(request, "active", zeroAddress, this.contractAddress);
    });
  }

  anchorReviewedMerge(request: ReviewedMergeAnchorRequest): Promise<TransactionMetadata> {
    return this.submit("commit", request.commitHash, () => {
      if (this.outcome === "confirmed") this.storeAnchor(request, "merged", zeroAddress, this.contractAddress);
    });
  }

  anchorSignedChallenge(request: SignedChallengeAnchorRequest): Promise<TransactionMetadata> {
    return this.submit("challenge", request.challengeHash, () => {
      if (this.outcome === "confirmed") {
        const target = this.anchors.get(normalizeDigest(request.targetCommitHash));
        if (target?.status === "active") target.status = "challenged";
      }
    });
  }

  async getCommitAnchor(commitHash: string): Promise<CommitAnchor | undefined> {
    return this.anchors.get(normalizeDigest(commitHash));
  }

  async getTransactionStatus(transactionHash: string): Promise<TransactionMetadata | undefined> {
    return this.transactions.get(transactionHash.toLowerCase());
  }

  async verifyCommitAnchor(commit: RealityCommit): Promise<AnchorVerificationResult> {
    const anchor = await this.getCommitAnchor(commit.commitHash);
    if (!anchor) return this.verification("not_found", "No mock anchor exists for this commit");
    const mismatches = compareCommitToAnchor(commit, anchor);
    return mismatches.length === 0
      ? this.verification("verified", "Stored commit matches its mock blockchain anchor")
      : { ...this.verification("mismatch", "Stored commit does not match its mock blockchain anchor"), mismatches };
  }

  async healthCheck(): Promise<BlockchainHealth> {
    return {
      ok: true,
      mode: "mock",
      chainId: this.chainId,
      contractAddress: this.contractAddress,
      mock: true,
      message: "Mock blockchain adapter is available; no RPC connection is used"
    };
  }

  private submit(kind: string, key: string, onConfirmed: () => void): Promise<TransactionMetadata> {
    const idempotencyKey = `${kind}:${normalizeDigest(key)}`;
    const existing = this.submissions.get(idempotencyKey);
    if (existing) return existing;
    const operation = Promise.resolve().then(() => {
      const transactionHash = fakeHash(kind, normalizeDigest(key));
      const metadata: TransactionMetadata = {
        transactionHash,
        chainId: this.chainId,
        contractAddress: this.contractAddress,
        status: this.outcome,
        ...(this.outcome === "confirmed" ? { blockNumber: "1" } : {}),
        ...(this.outcome === "failed" ? { errorCode: this.failureCode, errorMessage: this.failureMessage } : {}),
        mock: true
      };
      if (this.outcome === "confirmed") onConfirmed();
      this.transactions.set(transactionHash.toLowerCase(), metadata);
      return metadata;
    });
    this.submissions.set(idempotencyKey, operation);
    void operation.then((metadata) => {
      if (metadata.status === "failed") this.submissions.delete(idempotencyKey);
    });
    return operation;
  }

  private storeAnchor(
    request: SignedCommitAnchorRequest,
    status: RealityCommit["status"],
    relayer: Address,
    reviewer: Address
  ): void {
    const commitHash = normalizeDigest(request.commitHash);
    this.anchors.set(commitHash, {
      commitHash,
      evidenceRoot: normalizeDigest(request.evidenceRoot),
      parentA: normalizeDigest(request.parentA),
      parentB: normalizeDigest(request.parentB),
      author: getAddress(request.author),
      relayer,
      reviewer,
      createdAt: Math.floor(Date.now() / 1000),
      status,
      chainId: this.chainId,
      contractAddress: this.contractAddress,
      mock: true
    });
  }

  private verification(status: AnchorVerificationResult["status"], message: string): AnchorVerificationResult {
    return { status, chainId: this.chainId, contractAddress: this.contractAddress, mock: true, message };
  }
}

export function compareCommitToAnchor(commit: RealityCommit, anchor: CommitAnchor): string[] {
  const expectedParents = [commit.parentCommitHashes[0] ?? ZERO_DIGEST, commit.parentCommitHashes[1] ?? ZERO_DIGEST];
  const mismatches: string[] = [];
  if (normalizeDigest(commit.commitHash) !== anchor.commitHash) mismatches.push("commitHash");
  if (normalizeDigest(commit.evidenceRoot) !== anchor.evidenceRoot) mismatches.push("evidenceRoot");
  if (normalizeDigest(expectedParents[0]!) !== anchor.parentA) mismatches.push("parentA");
  if (normalizeDigest(expectedParents[1]!) !== anchor.parentB) mismatches.push("parentB");
  if (!commit.authorization || getAddress(commit.authorization.signerAddress) !== anchor.author) mismatches.push("author");
  if (commit.status !== anchor.status) mismatches.push("status");
  if (commit.authorization?.chainId !== anchor.chainId) mismatches.push("chainId");
  if (!commit.authorization || getAddress(commit.authorization.registryContractAddress) !== anchor.contractAddress) {
    mismatches.push("contractAddress");
  }
  return mismatches;
}
