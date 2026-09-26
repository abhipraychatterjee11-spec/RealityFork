import assert from "node:assert/strict";
import test from "node:test";
import type { CreateCommitInput, RealityCommit } from "@realityfork/shared";
import { detectContradictions, scoreEvidence } from "../src/scoring.js";

const input: CreateCommitInput = {
  parentIds: [],
  authorId: "citizen-test",
  authorRole: "citizen",
  claim: {
    subjectId: "road-a17",
    field: "condition",
    value: "damaged",
    observedAt: "2026-09-26T09:25:00.000Z"
  },
  evidence: [{
    id: "41d44df1-8086-4fdb-bc4c-36db22089070",
    kind: "photo",
    uri: "ipfs://test",
    sha256: "b".repeat(64),
    capturedAt: "2026-09-26T09:23:00.000Z",
    latitude: 22.5726,
    longitude: 88.3639,
    aiRiskScore: 0.1
  }],
  message: "Test observation"
};

test("evidence score stays inside the documented range", () => {
  const value = scoreEvidence(input.evidence);
  assert.ok(value >= 0 && value <= 1);
});

test("contradictory field values are flagged", () => {
  const existing = [{
    ...input,
    id: "3f317269-4b03-4919-85f8-e61e9ad5b870",
    claim: { ...input.claim, value: "good", observedAt: "2026-09-26T09:00:00.000Z" },
    commitHash: "a".repeat(64),
    parentCommitHashes: [],
    evidenceRoot: "c".repeat(64),
    createdAt: "2026-09-26T09:01:00.000Z",
    status: "active",
    evidenceStrength: 0.8,
    sourceReputation: 0.7,
    contradictionFlags: []
  } satisfies RealityCommit];
  assert.ok(detectContradictions(input, existing).length > 0);
});
