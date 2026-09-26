import { randomUUID } from "node:crypto";
import {
  buildCanonicalCommitV1,
  calculateEvidenceRootV1,
  hashCanonicalCommitV1,
  type ChallengeInput,
  type ChallengeRecord,
  type CreateCommitInput,
  type RealityCommit,
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
      authorization
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
      authorization
    };
    this.challenges.set(challenge.id, challenge);
    return challenge;
  }

  history(subjectId: string): RealityCommit[] {
    return this.list().filter((commit) => commit.claim.subjectId === subjectId);
  }
}
