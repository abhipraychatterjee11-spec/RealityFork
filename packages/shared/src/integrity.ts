import { createHash } from "node:crypto";
import type { Claim, CreateCommitInput, Evidence } from "./index.js";

export const COMMIT_SCHEMA_VERSION = "realityfork.commit.v1" as const;
export const EVIDENCE_SCHEMA_VERSION = "realityfork.evidence.v1" as const;

export type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

export interface CanonicalEvidenceV1 {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  sha256: string;
  kind: Evidence["kind"];
  uri: string;
  capturedAt: string;
  latitude?: number;
  longitude?: number;
  deviceSignature?: string;
}

export interface CanonicalCommitV1 {
  schemaVersion: typeof COMMIT_SCHEMA_VERSION;
  subjectId: string;
  field: string;
  value: string;
  observedAt: string;
  locationLabel?: string;
  authorId: string;
  authorRole: CreateCommitInput["authorRole"];
  message: string;
  parentCommitHashes: string[];
  evidenceRoot: string;
}

export interface CanonicalCommitV1Input {
  claim: Claim;
  authorId: string;
  authorRole: CreateCommitInput["authorRole"];
  message: string;
  parentCommitHashes: string[];
  evidenceRoot: string;
}

export interface Sha256Digest {
  hex: string;
  bytes32: `0x${string}`;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

function assertDigest(value: string, label: string): void {
  if (!SHA256_HEX.test(value)) throw new TypeError(`${label} must be a lowercase 64-character SHA-256 digest`);
}

function normalizeTimestamp(value: string, label: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return timestamp.toISOString();
}

function normalizeCanonicalValue(value: unknown, ancestors: Set<object>): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support NaN or Infinity");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new TypeError(`Canonical JSON does not support ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError("Canonical JSON does not support cyclic values");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: CanonicalValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new TypeError("Canonical JSON does not support sparse arrays");
        result.push(normalizeCanonicalValue(value[index], ancestors));
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON supports only plain objects and arrays");
    }
    const source = value as Record<string, unknown>;
    if (Object.getOwnPropertySymbols(source).length > 0) {
      throw new TypeError("Canonical JSON does not support symbol keys");
    }
    const result: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(source).sort()) {
      result[key] = normalizeCanonicalValue(source[key], ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(normalizeCanonicalValue(value, new Set()));
}

function sha256Bytes(bytes: Uint8Array): Sha256Digest {
  const hex = createHash("sha256").update(bytes).digest("hex");
  return { hex, bytes32: `0x${hex}` };
}

function hashCanonicalValue(value: unknown): Sha256Digest {
  return sha256Bytes(Buffer.from(canonicalize(value), "utf8"));
}

export function buildCanonicalEvidenceV1(evidence: Evidence): CanonicalEvidenceV1 {
  assertDigest(evidence.sha256, "Evidence sha256");
  const payload: CanonicalEvidenceV1 = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    sha256: evidence.sha256,
    kind: evidence.kind,
    uri: evidence.uri,
    capturedAt: normalizeTimestamp(evidence.capturedAt, "Evidence capturedAt")
  };
  if (evidence.latitude !== undefined) payload.latitude = evidence.latitude;
  if (evidence.longitude !== undefined) payload.longitude = evidence.longitude;
  if (evidence.deviceSignature !== undefined) payload.deviceSignature = evidence.deviceSignature;
  return payload;
}

export function hashEvidenceLeafV1(evidence: Evidence): Sha256Digest {
  return hashCanonicalValue(buildCanonicalEvidenceV1(evidence));
}

export function calculateEvidenceRootV1(evidence: Evidence[]): Sha256Digest {
  if (evidence.length === 0) throw new TypeError("Evidence collection must not be empty");
  const contentDigests = new Set<string>();
  let level = evidence.map((item) => {
    if (contentDigests.has(item.sha256)) throw new TypeError(`Duplicate evidence sha256: ${item.sha256}`);
    contentDigests.add(item.sha256);
    return hashEvidenceLeafV1(item).hex;
  }).sort();

  if (new Set(level).size !== level.length) throw new TypeError("Duplicate evidence leaf hash");
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]!);
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = Buffer.from(level[index]!, "hex");
      const right = Buffer.from(level[index + 1]!, "hex");
      next.push(sha256Bytes(Buffer.concat([left, right])).hex);
    }
    level = next;
  }
  const hex = level[0]!;
  return { hex, bytes32: `0x${hex}` };
}

export function buildCanonicalCommitV1(input: CanonicalCommitV1Input): CanonicalCommitV1 {
  assertDigest(input.evidenceRoot, "Evidence root");
  if (input.parentCommitHashes.length > 2) throw new TypeError("A commit may have at most two parents");
  for (const hash of input.parentCommitHashes) assertDigest(hash, "Parent commit hash");
  if (new Set(input.parentCommitHashes).size !== input.parentCommitHashes.length) {
    throw new TypeError("Duplicate parent commit hashes are not allowed");
  }
  const parentCommitHashes = input.parentCommitHashes.length === 2
    ? [...input.parentCommitHashes].sort()
    : [...input.parentCommitHashes];
  const payload: CanonicalCommitV1 = {
    schemaVersion: COMMIT_SCHEMA_VERSION,
    subjectId: input.claim.subjectId,
    field: input.claim.field,
    value: input.claim.value,
    observedAt: normalizeTimestamp(input.claim.observedAt, "Claim observedAt"),
    authorId: input.authorId,
    authorRole: input.authorRole,
    message: input.message,
    parentCommitHashes,
    evidenceRoot: input.evidenceRoot
  };
  if (input.claim.locationLabel !== undefined) payload.locationLabel = input.claim.locationLabel;
  return payload;
}

export function hashCanonicalCommitV1(payload: CanonicalCommitV1): Sha256Digest {
  if (payload.schemaVersion !== COMMIT_SCHEMA_VERSION) throw new TypeError("Unsupported commit schema version");
  assertDigest(payload.evidenceRoot, "Evidence root");
  if (payload.observedAt !== normalizeTimestamp(payload.observedAt, "Claim observedAt")) {
    throw new TypeError("Canonical commit observedAt must be normalized to ISO 8601 UTC");
  }
  if (payload.parentCommitHashes.length > 2) throw new TypeError("A commit may have at most two parents");
  for (const hash of payload.parentCommitHashes) assertDigest(hash, "Parent commit hash");
  if (new Set(payload.parentCommitHashes).size !== payload.parentCommitHashes.length) {
    throw new TypeError("Duplicate parent commit hashes are not allowed");
  }
  if (payload.parentCommitHashes.length === 2 && payload.parentCommitHashes[0]! > payload.parentCommitHashes[1]!) {
    throw new TypeError("Merge parent hashes must be sorted lexicographically");
  }
  return hashCanonicalValue(payload);
}
