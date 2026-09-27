import { z } from "zod";

export const EvidenceSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["photo", "video", "document", "sensor", "testimony"]),
  uri: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  capturedAt: z.string().datetime({ offset: true }),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  deviceSignature: z.string().optional(),
  aiRiskScore: z.number().min(0).max(1).optional()
}).strict();

export const ClaimSchema = z.object({
  subjectId: z.string().min(1),
  field: z.string().min(1),
  value: z.string().min(1),
  observedAt: z.string().datetime({ offset: true }),
  locationLabel: z.string().optional()
}).strict();

export const CreateCommitSchema = z.object({
  parentIds: z.array(z.string().uuid()).max(2).default([]),
  authorId: z.string().min(1),
  authorRole: z.enum(["citizen", "official", "reviewer", "sensor"]),
  claim: ClaimSchema,
  evidence: z.array(EvidenceSchema).min(1),
  message: z.string().min(1).max(240)
}).strict();

export const ChallengeSchema = z.object({
  challengerId: z.string().min(1),
  reason: z.enum(["contradictory_evidence", "wrong_location", "wrong_time", "synthetic_media", "other"]),
  note: z.string().min(1).max(500),
  evidence: z.array(EvidenceSchema).default([])
}).strict();

export type Evidence = z.infer<typeof EvidenceSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type CreateCommitInput = z.infer<typeof CreateCommitSchema>;
export type ChallengeInput = z.infer<typeof ChallengeSchema>;

export type CommitStatus = "active" | "challenged" | "merged" | "superseded";
export type BlockchainAnchorStatus = "not_requested" | "pending" | "confirmed" | "failed";
export type BlockchainVerificationStatus = "verified" | "not_found" | "mismatch" | "pending" | "network_unavailable";

export interface BlockchainAnchorMetadata {
  status: BlockchainAnchorStatus;
  transactionHash?: string;
  chainId?: number;
  contractAddress?: string;
  blockNumber?: string;
  errorCode?: string;
  errorMessage?: string;
  submittedAt?: string;
  confirmedAt?: string;
  mock: boolean;
  verificationStatus?: BlockchainVerificationStatus;
  verificationMessage?: string;
  verificationMismatches?: string[];
}

export interface RealityCommit extends CreateCommitInput {
  id: string;
  commitHash: string;
  parentCommitHashes: string[];
  evidenceRoot: string;
  createdAt: string;
  status: CommitStatus;
  evidenceStrength: number;
  sourceReputation: number;
  contradictionFlags: string[];
  authorization?: SignatureMetadata;
  chainTxHash?: string;
  blockchainAnchor: BlockchainAnchorMetadata;
}

export * from "./integrity.js";
export * from "./signatures.js";

export interface SignatureMetadata {
  signerAddress: string;
  signature: string;
  nonce: string;
  expiresAt: number;
  chainId: number;
  registryContractAddress: string;
  verifiedAt: string;
}

export interface ChallengeRecord extends ChallengeInput {
  id: string;
  commitId: string;
  createdAt: string;
  status: "open" | "accepted" | "rejected";
  challengeHash?: string;
  challengeEvidenceRoot?: string;
  authorization?: SignatureMetadata;
  blockchainAnchor: BlockchainAnchorMetadata;
}
