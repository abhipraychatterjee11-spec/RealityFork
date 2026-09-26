import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildCanonicalCommitV1,
  buildCanonicalEvidenceV1,
  calculateEvidenceRootV1,
  canonicalize,
  hashCanonicalCommitV1,
  hashEvidenceLeafV1,
  type CreateCommitInput,
  type Evidence
} from "@realityfork/shared";
import { MemoryRealityStore } from "../src/store.js";

const evidenceA: Evidence = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "photo",
  uri: "ipfs://evidence/root-photo",
  sha256: "1".repeat(64),
  capturedAt: "2026-09-26T14:30:00+05:30",
  latitude: 22.5726,
  longitude: 88.3639,
  deviceSignature: "device-signature-a",
  aiRiskScore: 0.12
};

const evidenceB: Evidence = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "document",
  uri: "ipfs://evidence/inspection",
  sha256: "2".repeat(64),
  capturedAt: "2026-09-26T09:10:00.000Z"
};

const rootInput: CreateCommitInput = {
  parentIds: [],
  authorId: "official-ward-17",
  authorRole: "official",
  claim: {
    subjectId: "road-a17",
    field: "condition",
    value: "good",
    observedAt: "2026-09-26T14:35:00+05:30",
    locationLabel: "Ward 17"
  },
  evidence: [evidenceA],
  message: "Routine inspection"
};

const EXPECTED = {
  evidenceLeafA: "f120c7dd46b76623dc3ad81d4fb39f00299aa41686d28282c4852aa4624fdf27",
  evidenceLeafB: "b19bbb4be0c48bb7331423bbc2280ae5ee9debdf9c0c5d14b0f61a81a41600aa",
  evidenceRootA: "f120c7dd46b76623dc3ad81d4fb39f00299aa41686d28282c4852aa4624fdf27",
  evidenceRootAB: "db7f3ec197cc1812190471c6d2515923b4f5a45bb831321c139af724f8b733e9",
  rootCommit: "4be70e86f5c78d3f2418e5abc231b817ba733a112c729bc5e083f6f42bd7afd2",
  forkCommit: "8aa99fd475546272a3b28ecb8025bb299974b0bc98a0c514aa42a245a2af0e50",
  mergeCommit: "8f97bf3670988e5d1ed150358012dcd41e7943d5a45c993c9eeabe6eda3beb77"
} as const;

function commitFor(input: CreateCommitInput, parentCommitHashes: string[]) {
  const evidenceRoot = calculateEvidenceRootV1(input.evidence).hex;
  return buildCanonicalCommitV1({
    claim: input.claim,
    authorId: input.authorId,
    authorRole: input.authorRole,
    message: input.message,
    parentCommitHashes,
    evidenceRoot
  });
}

test("golden vector: root commit with one evidence item", () => {
  const leaf = hashEvidenceLeafV1(evidenceA);
  const root = calculateEvidenceRootV1([evidenceA]);
  const payload = commitFor(rootInput, []);
  const commit = hashCanonicalCommitV1(payload);

  assert.equal(canonicalize(payload), "{\"authorId\":\"official-ward-17\",\"authorRole\":\"official\",\"evidenceRoot\":\"f120c7dd46b76623dc3ad81d4fb39f00299aa41686d28282c4852aa4624fdf27\",\"field\":\"condition\",\"locationLabel\":\"Ward 17\",\"message\":\"Routine inspection\",\"observedAt\":\"2026-09-26T09:05:00.000Z\",\"parentCommitHashes\":[],\"schemaVersion\":\"realityfork.commit.v1\",\"subjectId\":\"road-a17\",\"value\":\"good\"}");
  assert.equal(leaf.hex, EXPECTED.evidenceLeafA);
  assert.equal(root.hex, EXPECTED.evidenceRootA);
  assert.equal(commit.hex, EXPECTED.rootCommit);
  assert.equal(commit.bytes32, `0x${EXPECTED.rootCommit}`);
});

test("golden vector: fork with one parent", () => {
  const fork = {
    ...rootInput,
    authorId: "citizen-wallet-1",
    authorRole: "citizen" as const,
    claim: { ...rootInput.claim, value: "damaged", observedAt: "2026-09-26T09:25:00.000Z" },
    evidence: [evidenceB],
    message: "Surface damage observed"
  };
  assert.equal(hashCanonicalCommitV1(commitFor(fork, [EXPECTED.rootCommit])).hex, EXPECTED.forkCommit);
});

test("golden vector: merge parent order is normalized", () => {
  const merge = { ...rootInput, evidence: [evidenceA, evidenceB], message: "Reviewed merge" };
  const first = commitFor(merge, ["b".repeat(64), "a".repeat(64)]);
  const second = commitFor(merge, ["a".repeat(64), "b".repeat(64)]);
  assert.deepEqual(first.parentCommitHashes, ["a".repeat(64), "b".repeat(64)]);
  assert.equal(hashCanonicalCommitV1(first).hex, EXPECTED.mergeCommit);
  assert.equal(hashCanonicalCommitV1(first).hex, hashCanonicalCommitV1(second).hex);
});

test("evidence order does not change a multi-item Merkle root", () => {
  assert.equal(hashEvidenceLeafV1(evidenceB).hex, EXPECTED.evidenceLeafB);
  assert.equal(calculateEvidenceRootV1([evidenceA, evidenceB]).hex, EXPECTED.evidenceRootAB);
  assert.equal(calculateEvidenceRootV1([evidenceB, evidenceA]).hex, EXPECTED.evidenceRootAB);
});

test("canonicalization recursively sorts keys and rejects unsupported values", () => {
  const reorderedA = canonicalize({ z: { b: 2, a: 1 }, a: [{ d: 4, c: 3 }] });
  const reorderedB = canonicalize({ a: [{ c: 3, d: 4 }], z: { a: 1, b: 2 } });
  assert.equal(reorderedA, "{\"a\":[{\"c\":3,\"d\":4}],\"z\":{\"a\":1,\"b\":2}}");
  assert.equal(reorderedA, reorderedB);
  assert.equal(createHash("sha256").update(reorderedA).digest("hex"), createHash("sha256").update(reorderedB).digest("hex"));
  assert.throws(() => canonicalize({ invalid: undefined }), /does not support undefined/);
  assert.throws(() => canonicalize({ invalid: Number.NaN }), /NaN or Infinity/);
  assert.throws(() => canonicalize({ invalid: Number.POSITIVE_INFINITY }), /NaN or Infinity/);
  assert.throws(() => canonicalize({ invalid: () => true }), /does not support function/);
});

test("optional committed fields are present only when supplied", () => {
  const withoutLocation = commitFor({ ...rootInput, claim: { ...rootInput.claim, locationLabel: undefined } }, []);
  assert.equal("locationLabel" in withoutLocation, false);
  assert.equal("deviceSignature" in buildCanonicalEvidenceV1({ ...evidenceA, deviceSignature: undefined }), false);
});

test("altering committed claim fields changes the commit hash", () => {
  const base = hashCanonicalCommitV1(commitFor(rootInput, [])).hex;
  const changedValue = hashCanonicalCommitV1(commitFor({ ...rootInput, claim: { ...rootInput.claim, value: "damaged" } }, [])).hex;
  const changedTime = hashCanonicalCommitV1(commitFor({ ...rootInput, claim: { ...rootInput.claim, observedAt: "2026-09-26T09:06:00.000Z" } }, [])).hex;
  assert.notEqual(changedValue, base);
  assert.notEqual(changedTime, base);
});

test("altering committed evidence metadata changes its leaf, root and commit", () => {
  const changed = { ...evidenceA, uri: "ipfs://evidence/replacement" };
  assert.notEqual(hashEvidenceLeafV1(changed).hex, hashEvidenceLeafV1(evidenceA).hex);
  assert.notEqual(calculateEvidenceRootV1([changed]).hex, calculateEvidenceRootV1([evidenceA]).hex);
  assert.notEqual(hashCanonicalCommitV1(commitFor({ ...rootInput, evidence: [changed] }, [])).hex, EXPECTED.rootCommit);
});

test("derived fields do not affect evidence or commit hashes", () => {
  const changedRisk = { ...evidenceA, aiRiskScore: 0.99 };
  assert.equal(calculateEvidenceRootV1([changedRisk]).hex, EXPECTED.evidenceRootA);
  assert.equal(hashCanonicalCommitV1(commitFor({ ...rootInput, evidence: [changedRisk] }, [])).hex, EXPECTED.rootCommit);
  const baseArguments = {
    claim: rootInput.claim,
    authorId: rootInput.authorId,
    authorRole: rootInput.authorRole,
    message: rootInput.message,
    parentCommitHashes: [],
    evidenceRoot: EXPECTED.evidenceRootA
  };
  const withDerivedScores = { ...baseArguments, evidenceStrength: 0.01, sourceReputation: 0.99, contradictionFlags: ["mutable"] };
  assert.equal(hashCanonicalCommitV1(buildCanonicalCommitV1(withDerivedScores)).hex, EXPECTED.rootCommit);
});

test("invalid digests and duplicates are rejected", () => {
  assert.throws(() => calculateEvidenceRootV1([{ ...evidenceA, sha256: "ABC" }]), /lowercase 64-character/);
  assert.throws(() => calculateEvidenceRootV1([evidenceA, { ...evidenceB, sha256: evidenceA.sha256 }]), /Duplicate evidence sha256/);
  assert.throws(() => commitFor(rootInput, ["a".repeat(64), "a".repeat(64)]), /Duplicate parent/);
  assert.throws(() => commitFor(rootInput, ["not-a-digest"]), /lowercase 64-character/);
});

test("memory store resolves parent UUIDs to canonical hashes", () => {
  const store = new MemoryRealityStore();
  const root = store.create(rootInput);
  const fork = store.create({
    ...rootInput,
    parentIds: [root.id],
    claim: { ...rootInput.claim, value: "damaged" },
    evidence: [evidenceB]
  });
  assert.deepEqual(root.parentCommitHashes, []);
  assert.deepEqual(fork.parentIds, [root.id]);
  assert.deepEqual(fork.parentCommitHashes, [root.commitHash]);
  assert.equal(root.commitHash, EXPECTED.rootCommit);
});
