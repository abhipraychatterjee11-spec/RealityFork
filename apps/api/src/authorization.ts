import { z } from "zod";
import {
  ChallengeSchema,
  CreateCommitSchema,
  buildCanonicalChallengeV1,
  buildChallengeAuthorizationTypedData,
  buildCommitAuthorizationTypedData,
  hashCanonicalChallengeV1,
  normalizeNonce,
  normalizeWalletAddress,
  recoverChallengeAuthorizationSigner,
  recoverCommitAuthorizationSigner,
  type ChallengeInput,
  type CreateCommitInput,
  type SignatureDomainConfig,
  type SignatureMetadata
} from "@realityfork/shared";

const DecimalIntegerSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const WalletAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const LowercaseWalletAddressSchema = z.string().regex(/^0x[a-f0-9]{40}$/);
const SignatureSchema = z.string().regex(/^0x[a-fA-F0-9]{130}$/);

export const AuthorizationEnvelopeSchema = z.object({
  signerAddress: WalletAddressSchema,
  signature: SignatureSchema,
  nonce: DecimalIntegerSchema,
  expiresAt: z.number().int().nonnegative().safe(),
  chainId: z.number().int().positive().safe(),
  registryContractAddress: WalletAddressSchema
}).strict();

export const SignedCommitRequestSchema = z.object({
  input: CreateCommitSchema.extend({ authorId: LowercaseWalletAddressSchema }).strict(),
  authorization: AuthorizationEnvelopeSchema
}).strict();

export const SignedChallengeRequestSchema = z.object({
  input: ChallengeSchema.extend({ challengerId: LowercaseWalletAddressSchema }).strict(),
  authorization: AuthorizationEnvelopeSchema
}).strict();

export type AuthorizationEnvelope = z.infer<typeof AuthorizationEnvelopeSchema>;

export interface PreparedCommitAuthorization {
  commitHash: string;
  evidenceRoot: string;
  parentA: string;
  parentB: string;
}

export interface PreparedChallengeAuthorization {
  targetCommitHash: string;
  challengeHash: string;
  challengeEvidenceRoot: string;
}

export class AuthorizationError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message);
  }
}

function validateRequestDomain(envelope: AuthorizationEnvelope, configured: SignatureDomainConfig): SignatureDomainConfig {
  if (envelope.chainId !== configured.chainId) {
    throw new AuthorizationError("CHAIN_ID_MISMATCH", "Signature chain ID does not match the configured chain", 400);
  }
  let requestedContract: string;
  let configuredContract: string;
  try {
    requestedContract = normalizeWalletAddress(envelope.registryContractAddress);
    configuredContract = normalizeWalletAddress(configured.verifyingContract);
  } catch {
    throw new AuthorizationError("INVALID_CONTRACT_ADDRESS", "Registry contract address is invalid", 400);
  }
  if (requestedContract !== configuredContract) {
    throw new AuthorizationError("CONTRACT_ADDRESS_MISMATCH", "Signature registry address does not match configuration", 400);
  }
  return { chainId: configured.chainId, verifyingContract: configuredContract };
}

function validateFreshness(envelope: AuthorizationEnvelope, nowSeconds: number): void {
  if (envelope.expiresAt <= nowSeconds) {
    throw new AuthorizationError("SIGNATURE_EXPIRED", "Signature authorization has expired", 410);
  }
  try {
    normalizeNonce(envelope.nonce);
  } catch (error) {
    throw new AuthorizationError("INVALID_NONCE", error instanceof Error ? error.message : "Nonce is invalid", 400);
  }
}

function metadata(envelope: AuthorizationEnvelope, signerAddress: string): SignatureMetadata {
  return {
    signerAddress,
    signature: envelope.signature,
    nonce: normalizeNonce(envelope.nonce).toString(10),
    expiresAt: envelope.expiresAt,
    chainId: envelope.chainId,
    registryContractAddress: normalizeWalletAddress(envelope.registryContractAddress),
    verifiedAt: new Date().toISOString()
  };
}

export async function verifyCommitAuthorization(
  input: CreateCommitInput,
  prepared: PreparedCommitAuthorization,
  envelope: AuthorizationEnvelope,
  configured: SignatureDomainConfig,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<SignatureMetadata> {
  validateFreshness(envelope, nowSeconds);
  const domain = validateRequestDomain(envelope, configured);
  let signer: string;
  let author: string;
  try {
    signer = normalizeWalletAddress(envelope.signerAddress);
    author = normalizeWalletAddress(input.authorId);
  } catch {
    throw new AuthorizationError("AUTHOR_IDENTITY_MISMATCH", "authorId and signerAddress must be valid matching wallet addresses", 401);
  }
  if (signer !== author || input.authorId !== author) {
    throw new AuthorizationError("AUTHOR_IDENTITY_MISMATCH", "authorId must equal the lowercased signer wallet address", 401);
  }

  try {
    buildCommitAuthorizationTypedData(domain, {
      commitHash: prepared.commitHash,
      evidenceRoot: prepared.evidenceRoot,
      parentA: prepared.parentA,
      parentB: prepared.parentB,
      author: signer,
      nonce: envelope.nonce,
      expiresAt: envelope.expiresAt
    });
    const recovered = await recoverCommitAuthorizationSigner(domain, {
      commitHash: prepared.commitHash,
      evidenceRoot: prepared.evidenceRoot,
      parentA: prepared.parentA,
      parentB: prepared.parentB,
      author: signer,
      nonce: envelope.nonce,
      expiresAt: envelope.expiresAt
    }, envelope.signature);
    if (recovered !== signer || recovered !== author) throw new Error("Recovered wallet mismatch");
  } catch {
    throw new AuthorizationError("INVALID_SIGNATURE", "Commit signature is invalid", 401);
  }
  return metadata(envelope, signer);
}

export function prepareChallengeAuthorization(
  input: ChallengeInput,
  targetCommitHash: string,
  envelope: AuthorizationEnvelope
): PreparedChallengeAuthorization {
  const canonical = buildCanonicalChallengeV1({
    targetCommitHash,
    challenger: input.challengerId,
    reason: input.reason,
    note: input.note,
    evidence: input.evidence,
    nonce: envelope.nonce,
    expiresAt: envelope.expiresAt
  });
  return {
    targetCommitHash,
    challengeHash: hashCanonicalChallengeV1(canonical).hex,
    challengeEvidenceRoot: canonical.challengeEvidenceRoot
  };
}

export async function verifyChallengeAuthorization(
  input: ChallengeInput,
  prepared: PreparedChallengeAuthorization,
  envelope: AuthorizationEnvelope,
  configured: SignatureDomainConfig,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<SignatureMetadata> {
  validateFreshness(envelope, nowSeconds);
  const domain = validateRequestDomain(envelope, configured);
  let signer: string;
  let challenger: string;
  try {
    signer = normalizeWalletAddress(envelope.signerAddress);
    challenger = normalizeWalletAddress(input.challengerId);
  } catch {
    throw new AuthorizationError("CHALLENGER_IDENTITY_MISMATCH", "challengerId and signerAddress must be valid matching wallet addresses", 401);
  }
  if (signer !== challenger || input.challengerId !== challenger) {
    throw new AuthorizationError("CHALLENGER_IDENTITY_MISMATCH", "challengerId must equal the lowercased signer wallet address", 401);
  }

  try {
    buildChallengeAuthorizationTypedData(domain, {
      ...prepared,
      challenger,
      nonce: envelope.nonce,
      expiresAt: envelope.expiresAt
    });
    const recovered = await recoverChallengeAuthorizationSigner(domain, {
      ...prepared,
      challenger,
      nonce: envelope.nonce,
      expiresAt: envelope.expiresAt
    }, envelope.signature);
    if (recovered !== signer || recovered !== challenger) throw new Error("Recovered wallet mismatch");
  } catch {
    throw new AuthorizationError("INVALID_SIGNATURE", "Challenge signature is invalid", 401);
  }
  return metadata(envelope, signer);
}
