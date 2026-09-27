import type { RealityCommit } from "@realityfork/shared";
import type { Address, Hex } from "viem";

export type TransactionState = "pending" | "confirmed" | "failed";
export type AnchorVerificationState = "verified" | "not_found" | "mismatch" | "pending" | "network_unavailable";

export interface TransactionMetadata {
  transactionHash: Hex;
  chainId: number;
  contractAddress: Address;
  status: TransactionState;
  blockNumber?: string;
  errorCode?: string;
  errorMessage?: string;
  mock: boolean;
}

export interface SignedCommitAnchorRequest {
  commitHash: string;
  evidenceRoot: string;
  parentA: string;
  parentB: string;
  author: string;
  nonce: string | bigint;
  expiresAt: number | bigint;
  authorSignature: string;
}

export interface SignedChallengeAnchorRequest {
  challengeHash: string;
  targetCommitHash: string;
  challengeEvidenceRoot: string;
  challenger: string;
  nonce: string | bigint;
  expiresAt: number | bigint;
  challengerSignature: string;
}

export type ReviewedMergeAnchorRequest = SignedCommitAnchorRequest;

export interface CommitAnchor {
  commitHash: string;
  evidenceRoot: string;
  parentA: string;
  parentB: string;
  author: Address;
  relayer: Address;
  reviewer: Address;
  createdAt: number;
  status: RealityCommit["status"];
  chainId: number;
  contractAddress: Address;
  mock: boolean;
}

export interface AnchorVerificationResult {
  status: AnchorVerificationState;
  chainId: number;
  contractAddress: Address;
  mock: boolean;
  mismatches?: string[];
  message: string;
}

export interface BlockchainHealth {
  ok: boolean;
  mode: "mock" | "evm";
  chainId: number;
  contractAddress: Address;
  mock: boolean;
  message: string;
}

export interface BlockchainAdapter {
  readonly mode: "mock" | "evm";
  readonly mock: boolean;
  anchorSignedCommit(request: SignedCommitAnchorRequest): Promise<TransactionMetadata>;
  anchorSignedChallenge(request: SignedChallengeAnchorRequest): Promise<TransactionMetadata>;
  anchorReviewedMerge(request: ReviewedMergeAnchorRequest): Promise<TransactionMetadata>;
  getCommitAnchor(commitHash: string): Promise<CommitAnchor | undefined>;
  getTransactionStatus(transactionHash: string): Promise<TransactionMetadata | undefined>;
  verifyCommitAnchor(commit: RealityCommit): Promise<AnchorVerificationResult>;
  healthCheck(): Promise<BlockchainHealth>;
}
