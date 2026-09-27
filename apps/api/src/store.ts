import { randomUUID } from "node:crypto";
import {
  buildCanonicalCommitV1,
  calculateEvidenceRootV1,
  hashCanonicalCommitV1,
  ZERO_DIGEST,
  type ChallengeInput,
  type ChallengeRecord,
  type CreateCommitInput,
  type RealityCommit,
  type BlockchainAnchorMetadata,
  type SignatureMetadata
} from "@realityfork/shared";
import { detectContradictions, initialReputation, scoreEvidence } from "./scoring.js";

export class MemoryRealityStore {
  private commits = new Map<string, RealityCommit>();
  private challenges = new Map<string, ChallengeRecord>();

  list(): RealityCommit[] {
    return [...this.commits.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): RealityCommit | undefined {
    return this.commits.get(id);
  }

  getChallenge(id: string): ChallengeRecord | undefined {
    return this.challenges.get(id);
  }

  prepare(input: CreateCommitInput) {
    const parents = input.parentIds.map((parentId) => {
      const parent = this.commits.get(parentId);
      if (!parent) throw new Error(`Parent commit ${parentId} does not exist`);
      return parent;
    });
    const evidenceRoot = calculateEvidenceRootV1(input.evidence).hex;
    const parentCommitHashes = parents.map((parent) => parent.commitHash);
    const canonicalCommit = buildCanonicalCommitV1({
      claim: input.claim,
      authorId: input.authorId,
      authorRole: input.authorRole,
      message: input.message,
      parentCommitHashes,
      evidenceRoot
    });
    return {
      evidenceRoot,
      parentCommitHashes: canonicalCommit.parentCommitHashes,
      parentA: canonicalCommit.parentCommitHashes[0] ?? ZERO_DIGEST,
      parentB: canonicalCommit.parentCommitHashes[1] ?? ZERO_DIGEST,
      commitHash: hashCanonicalCommitV1(canonicalCommit).hex
    };
  }

  create(input: CreateCommitInput, authorization?: SignatureMetadata): RealityCommit {
    const prepared = this.prepare(input);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const contradictionFlags = detectContradictions(input, this.list());
    const commit: RealityCommit = {
      ...input,
      id,
      createdAt,
      evidenceRoot: prepared.evidenceRoot,
      parentCommitHashes: prepared.parentCommitHashes,
      commitHash: prepared.commitHash,
      status: contradictionFlags.length ? "challenged" : "active",
      evidenceStrength: scoreEvidence(input.evidence),
      sourceReputation: initialReputation(input.authorRole),
      contradictionFlags,
      authorization,
      blockchainAnchor: { status: "not_requested", mock: true }
    };
    this.commits.set(id, commit);
    return commit;
  }

  challenge(
    commitId: string,
    input: ChallengeInput,
    integrity?: { challengeHash: string; challengeEvidenceRoot: string },
    authorization?: SignatureMetadata
  ): ChallengeRecord {
    const commit = this.commits.get(commitId);
    if (!commit) throw new Error("Commit not found");
    commit.status = "challenged";
    const challenge: ChallengeRecord = {
      ...input,
      id: randomUUID(),
      commitId,
      createdAt: new Date().toISOString(),
      status: "open",
      ...integrity,
      authorization,
      blockchainAnchor: { status: "not_requested", mock: true }
    };
    this.challenges.set(challenge.id, challenge);
    return challenge;
  }

  updateCommitAnchor(id: string, anchor: BlockchainAnchorMetadata): RealityCommit {
    const commit = this.commits.get(id);
    if (!commit) throw new Error("Commit not found");
    commit.blockchainAnchor = anchor;
    commit.chainTxHash = anchor.transactionHash;
    return commit;
  }

  updateChallengeAnchor(id: string, anchor: BlockchainAnchorMetadata): ChallengeRecord {
    const challenge = this.challenges.get(id);
    if (!challenge) throw new Error("Challenge not found");
    challenge.blockchainAnchor = anchor;
    return challenge;
  }

  confirmReviewedMerge(id: string): RealityCommit {
    const merge = this.commits.get(id);
    if (!merge || merge.parentIds.length !== 2) throw new Error("Reviewed merge not found");
    const parents = merge.parentIds.map((parentId) => this.commits.get(parentId));
    if (parents.some((parent) => !parent)) throw new Error("Merge parent not found");
    merge.status = "merged";
    for (const parent of parents) parent!.status = "superseded";
    return merge;
  }

  history(subjectId: string): RealityCommit[] {
    return this.list().filter((commit) => commit.claim.subjectId === subjectId);
  }
}
