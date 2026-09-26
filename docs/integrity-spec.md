# RealityFork integrity specification

Status: implemented commitment format  
Version: `realityfork.commit.v1` and `realityfork.evidence.v1`

This document defines the bytes RealityFork hashes. Implementations must reproduce these rules exactly. Database identifiers, scoring, moderation state and blockchain receipt data are deliberately outside the commitment.

## Digest representation

All digests use SHA-256. The application form is 64 lowercase hexadecimal characters without a prefix. The Solidity form contains the same 32 bytes represented as `0x` followed by those 64 characters. Inputs using uppercase, a prefix or any other length are invalid.

## Canonical JSON

`canonicalize(value)` recursively constructs JSON using these rules:

1. Object keys are sorted lexicographically by JavaScript/Unicode UTF-16 code-unit order at every depth.
2. Array order is preserved unless a format-specific rule below requires sorting.
3. Strings, booleans and `null` use standard JSON encoding.
4. Finite numbers use JavaScript `JSON.stringify` number encoding; negative zero is normalized to zero.
5. `undefined`, non-finite numbers, functions, symbols, bigint values, symbol-keyed objects, sparse arrays, cyclic structures and non-plain objects are rejected.
6. The resulting JSON string is encoded as UTF-8 before hashing.

Object insertion order never affects the encoded bytes. Optional properties are omitted, not encoded as `null`.

## Evidence V1

Each evidence leaf is this object:

```ts
interface CanonicalEvidenceV1 {
  schemaVersion: "realityfork.evidence.v1";
  sha256: string;
  kind: "photo" | "video" | "document" | "sensor" | "testimony";
  uri: string;
  capturedAt: string;
  latitude?: number;
  longitude?: number;
  deviceSignature?: string;
}
```

`capturedAt` is normalized to ISO 8601 UTC using the form `YYYY-MM-DDTHH:mm:ss.sssZ`. Evidence UUIDs, AI-risk scores, evidence-strength scores and other analysis are excluded.

The leaf hash is `SHA256(UTF8(canonicalize(leaf)))`.

### Evidence Merkle root

1. Reject an empty evidence list.
2. Reject repeated evidence content digests (`sha256`) and repeated leaf hashes.
3. Calculate every leaf hash and sort the 32-byte hashes by their lowercase hexadecimal representation.
4. Pair nodes from left to right.
5. If a level has an odd node count, duplicate its final node.
6. Calculate each parent as `SHA256(leftRaw32Bytes || rightRaw32Bytes)`.
7. Repeat until one node remains.

For a single leaf, no pair hashing occurs: the evidence root is exactly the leaf hash. Because leaves are sorted, evidence input order does not affect the root. Hexadecimal text is never concatenated when calculating parent nodes.

## RealityCommit V1

The canonical commit payload is:

```ts
interface CanonicalCommitV1 {
  schemaVersion: "realityfork.commit.v1";
  subjectId: string;
  field: string;
  value: string;
  observedAt: string;
  locationLabel?: string;
  authorId: string;
  authorRole: "citizen" | "official" | "reviewer" | "sensor";
  message: string;
  parentCommitHashes: string[];
  evidenceRoot: string;
}
```

`observedAt` is normalized to ISO 8601 UTC. The commit hash is:

```text
SHA256(UTF8(canonicalize(canonicalCommitV1)))
```

A root has zero parent hashes, a fork has one and a merge has exactly two. Two merge parents are sorted lexicographically before canonicalization. Duplicate parents and more than two parents are invalid. Consequently, reversing merge parents cannot produce another logical merge.

The database may use UUIDs for relationships, but UUIDs never enter this payload. Before building it, the store resolves every parent UUID and copies the parent's canonical `commitHash` into `parentCommitHashes`.

The following are excluded because they are storage details, blockchain receipt data, derived analysis or mutable workflow state:

- database UUID and server creation time;
- transaction hash, block data and confirmation status;
- evidence strength, source reputation, contradiction flags and AI-risk score;
- commit lifecycle status and all other derived or mutable fields.

## Golden vectors

The executable vectors are in `apps/api/test/integrity.test.ts`. The primary values are:

| Value | SHA-256 |
|---|---|
| Evidence leaf A / single-leaf root | `f120c7dd46b76623dc3ad81d4fb39f00299aa41686d28282c4852aa4624fdf27` |
| Evidence leaf B | `b19bbb4be0c48bb7331423bbc2280ae5ee9debdf9c0c5d14b0f61a81a41600aa` |
| Evidence A+B root | `db7f3ec197cc1812190471c6d2515923b4f5a45bb831321c139af724f8b733e9` |
| Root commit | `4be70e86f5c78d3f2418e5abc231b817ba733a112c729bc5e083f6f42bd7afd2` |
| Fork commit | `8aa99fd475546272a3b28ecb8025bb299974b0bc98a0c514aa42a245a2af0e50` |
| Two-parent merge | `8f97bf3670988e5d1ed150358012dcd41e7943d5a45c993c9eeabe6eda3beb77` |

The Solidity representation of the root commit is `0x4be70e86f5c78d3f2418e5abc231b817ba733a112c729bc5e083f6f42bd7afd2`.

## Compatibility and migration

Hashes produced by the earlier top-level JSON replacer are not V1 hashes and cannot be silently reinterpreted. Existing records must either be explicitly marked legacy or recomputed from their original complete inputs and re-anchored under an intentional migration policy. The present MVP store is in memory, so it has no durable records to migrate.

Prisma's `RealityCommit.id` remains the relationship identifier and `commitHash` remains the integrity identifier. No Prisma schema change is needed for this separation, although any future persisted API must resolve parent edges before calculating the canonical payload.
