import { createHash } from "node:crypto";
import { getAddress, isAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { calculateEvidenceRootV1, canonicalize, type Sha256Digest } from "./integrity.js";
import type { ChallengeInput, Evidence } from "./index.js";

export const CHALLENGE_SCHEMA_VERSION = "realityfork.challenge.v1" as const;
export const EIP712_DOMAIN_NAME = "RealityFork" as const;
export const EIP712_DOMAIN_VERSION = "1" as const;

export interface SignatureDomainConfig {
  chainId: number;
  verifyingContract: string;
}

export interface CommitAuthorizationMessage {
  commitHash: string;
  evidenceRoot: string;
  author: string;
  nonce: string | bigint | number;
  expiresAt: string | bigint | number;
}

export interface CanonicalChallengeV1 {
  schemaVersion: typeof CHALLENGE_SCHEMA_VERSION;
  targetCommitHash: string;
  challenger: string;
  reason: ChallengeInput["reason"];
  note: string;
  challengeEvidenceRoot: string;
  nonce: string;
  expiresAt: number;
}

export interface CanonicalChallengeV1Input {
  targetCommitHash: string;
  challenger: string;
  reason: ChallengeInput["reason"];
  note: string;
  evidence: Evidence[];
  nonce: string | bigint | number;
  expiresAt: number;
}

export interface ChallengeAuthorizationMessage {
  challengeHash: string;
  targetCommitHash: string;
  challengeEvidenceRoot: string;
  challenger: string;
  nonce: string | bigint | number;
  expiresAt: string | bigint | number;
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const UINT256_MAX = (1n << 256n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;

function assertDigest(value: string, label: string): void {
  if (!DIGEST_PATTERN.test(value)) throw new TypeError(`${label} must be a lowercase 64-character SHA-256 digest`);
}

function digestUtf8(value: string): Sha256Digest {
  const hex = createHash("sha256").update(value, "utf8").digest("hex");
  return { hex, bytes32: `0x${hex}` };
}

export function normalizeWalletAddress(value: string): string {
  if (!isAddress(value)) throw new TypeError("Invalid EVM wallet address");
  return getAddress(value).toLowerCase();
}

export function digestToBytes32(value: string): `0x${string}` {
  assertDigest(value, "Digest");
  return `0x${value}`;
}

export function normalizeNonce(value: string | bigint | number): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError("Nonce number must be a non-negative safe integer");
  }
  if (typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError("Nonce must be an unsigned base-10 integer");
  }
  const nonce = BigInt(value);
  if (nonce < 0n || nonce > UINT256_MAX) throw new TypeError("Nonce is outside uint256 range");
  return nonce;
}

export function normalizeExpiry(value: string | bigint | number): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError("Expiry number must be a non-negative safe integer");
  }
  if (typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError("Expiry must be an unsigned base-10 integer");
  }
  const expiry = BigInt(value);
  if (expiry < 0n || expiry > UINT64_MAX) throw new TypeError("Expiry is outside uint64 range");
  return expiry;
}

export function buildRealityForkDomain(config: SignatureDomainConfig) {
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) throw new TypeError("chainId must be a positive safe integer");
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId: config.chainId,
    verifyingContract: normalizeWalletAddress(config.verifyingContract) as Address
  } as const;
}

export function buildCommitAuthorizationTypedData(config: SignatureDomainConfig, message: CommitAuthorizationMessage) {
  return {
    domain: buildRealityForkDomain(config),
    primaryType: "RealityCommitAuthorization" as const,
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
      commitHash: digestToBytes32(message.commitHash),
      evidenceRoot: digestToBytes32(message.evidenceRoot),
      author: normalizeWalletAddress(message.author) as Address,
      nonce: normalizeNonce(message.nonce),
      expiresAt: normalizeExpiry(message.expiresAt)
    }
  } as const;
}

export function calculateChallengeEvidenceRootV1(evidence: Evidence[]): Sha256Digest {
  return evidence.length === 0 ? digestUtf8(canonicalize([])) : calculateEvidenceRootV1(evidence);
}

export function buildCanonicalChallengeV1(input: CanonicalChallengeV1Input): CanonicalChallengeV1 {
  assertDigest(input.targetCommitHash, "Target commit hash");
  const expiresAt = normalizeExpiry(input.expiresAt);
  if (expiresAt > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("Challenge expiry exceeds JSON safe-integer range");
  return {
    schemaVersion: CHALLENGE_SCHEMA_VERSION,
    targetCommitHash: input.targetCommitHash,
    challenger: normalizeWalletAddress(input.challenger),
    reason: input.reason,
    note: input.note,
    challengeEvidenceRoot: calculateChallengeEvidenceRootV1(input.evidence).hex,
    nonce: normalizeNonce(input.nonce).toString(10),
    expiresAt: Number(expiresAt)
  };
}

export function hashCanonicalChallengeV1(payload: CanonicalChallengeV1): Sha256Digest {
  if (payload.schemaVersion !== CHALLENGE_SCHEMA_VERSION) throw new TypeError("Unsupported challenge schema version");
  assertDigest(payload.targetCommitHash, "Target commit hash");
  assertDigest(payload.challengeEvidenceRoot, "Challenge evidence root");
  normalizeWalletAddress(payload.challenger);
  normalizeNonce(payload.nonce);
  normalizeExpiry(payload.expiresAt);
  return digestUtf8(canonicalize(payload));
}

export function buildChallengeAuthorizationTypedData(config: SignatureDomainConfig, message: ChallengeAuthorizationMessage) {
  return {
    domain: buildRealityForkDomain(config),
    primaryType: "RealityChallengeAuthorization" as const,
    types: {
      RealityChallengeAuthorization: [
        { name: "challengeHash", type: "bytes32" },
        { name: "targetCommitHash", type: "bytes32" },
        { name: "challengeEvidenceRoot", type: "bytes32" },
        { name: "challenger", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "expiresAt", type: "uint64" }
      ]
    },
    message: {
      challengeHash: digestToBytes32(message.challengeHash),
      targetCommitHash: digestToBytes32(message.targetCommitHash),
      challengeEvidenceRoot: digestToBytes32(message.challengeEvidenceRoot),
      challenger: normalizeWalletAddress(message.challenger) as Address,
      nonce: normalizeNonce(message.nonce),
      expiresAt: normalizeExpiry(message.expiresAt)
    }
  } as const;
}

export async function recoverCommitAuthorizationSigner(
  config: SignatureDomainConfig,
  message: CommitAuthorizationMessage,
  signature: string
): Promise<string> {
  const typedData = buildCommitAuthorizationTypedData(config, message);
  const recovered = await recoverTypedDataAddress({ ...typedData, signature: signature as Hex });
  return normalizeWalletAddress(recovered);
}

export async function recoverChallengeAuthorizationSigner(
  config: SignatureDomainConfig,
  message: ChallengeAuthorizationMessage,
  signature: string
): Promise<string> {
  const typedData = buildChallengeAuthorizationTypedData(config, message);
  const recovered = await recoverTypedDataAddress({ ...typedData, signature: signature as Hex });
  return normalizeWalletAddress(recovered);
}
