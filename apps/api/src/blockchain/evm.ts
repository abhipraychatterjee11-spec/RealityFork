import type { RealityCommit } from "@realityfork/shared";
import { digestToBytes32 } from "@realityfork/shared";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Abi,
  type Address,
  type Hex
} from "viem";
import { compareCommitToAnchor } from "./mock.js";
import type { EvmAdapterConfig } from "./config.js";
import type {
  AnchorVerificationResult,
  BlockchainAdapter,
  BlockchainHealth,
  CommitAnchor,
  ReviewedMergeAnchorRequest,
  SignedChallengeAnchorRequest,
  SignedCommitAnchorRequest,
  TransactionMetadata
} from "./types.js";

interface Receipt { status: "success" | "reverted"; blockNumber: bigint; transactionHash: Hex }
interface EvmClients {
  getChainId(): Promise<number>;
  getAddresses(): Promise<Address[]>;
  readContract(args: Record<string, unknown>): Promise<unknown>;
  waitForTransactionReceipt(args: { hash: Hex; confirmations: number; timeout: number }): Promise<Receipt>;
  getTransactionReceipt(args: { hash: Hex }): Promise<Receipt>;
  relayerWrite(args: Record<string, unknown>): Promise<Hex>;
  reviewerWrite(args: Record<string, unknown>): Promise<Hex>;
}

const STATUS = ["active", "challenged", "merged", "superseded"] as const;

export class EvmBlockchainAdapter implements BlockchainAdapter {
  readonly mode = "evm" as const;
  readonly mock = false;
  private readonly submissions = new Map<string, Promise<TransactionMetadata>>();
  private readonly transactions = new Map<string, TransactionMetadata>();

  private constructor(private readonly config: EvmAdapterConfig, private readonly clients: EvmClients) {}

  static async create(config: EvmAdapterConfig, clients?: EvmClients): Promise<EvmBlockchainAdapter> {
    const resolvedClients = clients ?? createClients(config);
    const rpcChainId = await resolvedClients.getChainId();
    if (rpcChainId !== config.chainId) throw new Error("RPC_CHAIN_ID_MISMATCH: RPC chain ID does not match deployment manifest");
    const unlocked = (await resolvedClients.getAddresses()).map(getAddress);
    if (!unlocked.includes(config.relayerAddress)) throw new Error("RELAYER_NOT_UNLOCKED: manifest relayer is not unlocked by local RPC");
    if (!unlocked.includes(config.reviewerAddress)) throw new Error("REVIEWER_NOT_UNLOCKED: manifest reviewer is not unlocked by local RPC");
    const domain = await resolvedClients.readContract({
      address: config.contractAddress, abi: config.abi as Abi, functionName: "eip712Domain", args: []
    }) as readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]];
    if (domain[1] !== "RealityFork" || domain[2] !== "2" || Number(domain[3]) !== config.chainId || getAddress(domain[4]) !== config.contractAddress) {
      throw new Error("CONTRACT_DOMAIN_MISMATCH: deployed contract EIP-712 domain does not match the manifest");
    }
    return new EvmBlockchainAdapter(config, resolvedClients);
  }

  anchorSignedCommit(request: SignedCommitAnchorRequest): Promise<TransactionMetadata> {
    return this.submit(`commit:${normalizeDigest(request.commitHash)}`, "RELAYER", "anchorSignedCommit", [
      digestToBytes32(normalizeDigest(request.commitHash)), digestToBytes32(normalizeDigest(request.evidenceRoot)),
      digestToBytes32(normalizeDigest(request.parentA)), digestToBytes32(normalizeDigest(request.parentB)),
      getAddress(request.author), BigInt(request.nonce), BigInt(request.expiresAt), request.authorSignature as Hex
    ]);
  }

  anchorSignedChallenge(request: SignedChallengeAnchorRequest): Promise<TransactionMetadata> {
    return this.submit(`challenge:${normalizeDigest(request.challengeHash)}`, "RELAYER", "anchorSignedChallenge", [
      digestToBytes32(normalizeDigest(request.challengeHash)), digestToBytes32(normalizeDigest(request.targetCommitHash)),
      digestToBytes32(normalizeDigest(request.challengeEvidenceRoot)), getAddress(request.challenger),
      BigInt(request.nonce), BigInt(request.expiresAt), request.challengerSignature as Hex
    ]);
  }

  anchorReviewedMerge(request: ReviewedMergeAnchorRequest): Promise<TransactionMetadata> {
    return this.submit(`commit:${normalizeDigest(request.commitHash)}`, "REVIEWER", "anchorReviewedMerge", [
      digestToBytes32(normalizeDigest(request.commitHash)), digestToBytes32(normalizeDigest(request.evidenceRoot)),
      digestToBytes32(normalizeDigest(request.parentA)), digestToBytes32(normalizeDigest(request.parentB)),
      getAddress(request.author), BigInt(request.nonce), BigInt(request.expiresAt), request.authorSignature as Hex
    ]);
  }

  async getCommitAnchor(commitHash: string): Promise<CommitAnchor | undefined> {
    const hash = digestToBytes32(normalizeDigest(commitHash));
    const exists = await this.clients.readContract(this.readArgs("commitExists", [hash]));
    if (exists !== true) return undefined;
    const raw = await this.clients.readContract(this.readArgs("getCommit", [hash]));
    const value = Array.isArray(raw) ? {
      commitHash: raw[0], evidenceRoot: raw[1], parentA: raw[2], parentB: raw[3], author: raw[4],
      relayer: raw[5], reviewer: raw[6], createdAt: raw[7], status: raw[8]
    } : raw as Record<string, unknown>;
    const status = STATUS[Number(value.status)];
    if (!status) throw new Error("Contract returned an unknown commit status");
    return {
      commitHash: normalizeDigest(String(value.commitHash)), evidenceRoot: normalizeDigest(String(value.evidenceRoot)),
      parentA: normalizeDigest(String(value.parentA)), parentB: normalizeDigest(String(value.parentB)),
      author: getAddress(String(value.author)), relayer: getAddress(String(value.relayer)), reviewer: getAddress(String(value.reviewer)),
      createdAt: Number(value.createdAt), status, chainId: this.config.chainId,
      contractAddress: this.config.contractAddress, mock: false
    };
  }

  async getTransactionStatus(transactionHash: string): Promise<TransactionMetadata | undefined> {
    const key = transactionHash.toLowerCase();
    const existing = this.transactions.get(key);
    if (existing?.status !== "pending") return existing;
    try {
      const receipt = await this.clients.getTransactionReceipt({ hash: transactionHash as Hex });
      const updated = this.fromReceipt(receipt);
      this.transactions.set(key, updated);
      return updated;
    } catch {
      return existing;
    }
  }

  async verifyCommitAnchor(commit: RealityCommit): Promise<AnchorVerificationResult> {
    const base = { chainId: this.config.chainId, contractAddress: this.config.contractAddress, mock: false };
    try {
      if (commit.chainTxHash) {
        const transaction = await this.getTransactionStatus(commit.chainTxHash);
        if (transaction?.status === "pending") return { ...base, status: "pending", message: "Anchor transaction is pending confirmation" };
      }
      const anchor = await this.getCommitAnchor(commit.commitHash);
      if (!anchor) return { ...base, status: "not_found", message: "No on-chain anchor exists for this commit" };
      const mismatches = compareCommitToAnchor(commit, anchor);
      return mismatches.length === 0
        ? { ...base, status: "verified", message: "Stored record matches its blockchain anchor; this does not prove the claim is true" }
        : { ...base, status: "mismatch", mismatches, message: "Stored record differs from its blockchain anchor" };
    } catch {
      return { ...base, status: "network_unavailable", message: "Blockchain verification is temporarily unavailable" };
    }
  }

  async healthCheck(): Promise<BlockchainHealth> {
    try {
      const chainId = await this.clients.getChainId();
      return {
        ok: chainId === this.config.chainId, mode: "evm", chainId,
        contractAddress: this.config.contractAddress, mock: false,
        message: chainId === this.config.chainId ? "Local EVM adapter is available" : "RPC chain ID mismatch"
      };
    } catch {
      return { ok: false, mode: "evm", chainId: this.config.chainId, contractAddress: this.config.contractAddress, mock: false, message: "Local EVM RPC is unavailable" };
    }
  }

  private submit(key: string, role: "RELAYER" | "REVIEWER", functionName: string, args: readonly unknown[]): Promise<TransactionMetadata> {
    const existing = this.submissions.get(key);
    if (existing) return existing;
    const operation = this.performSubmission(role, functionName, args);
    this.submissions.set(key, operation);
    void operation.then((metadata) => {
      if (metadata.status === "failed") this.submissions.delete(key);
    });
    return operation;
  }

  private async performSubmission(role: "RELAYER" | "REVIEWER", functionName: string, args: readonly unknown[]): Promise<TransactionMetadata> {
    let transactionHash: Hex = `0x${"0".repeat(64)}`;
    try {
      const roleFunction = role === "RELAYER" ? "RELAYER_ROLE" : "REVIEWER_ROLE";
      const actor = role === "RELAYER" ? this.config.relayerAddress : this.config.reviewerAddress;
      const roleHash = await this.clients.readContract(this.readArgs(roleFunction, []));
      const allowed = await this.clients.readContract(this.readArgs("hasRole", [roleHash, actor]));
      if (allowed !== true) return this.failed(transactionHash, `${role}_ROLE_MISSING`, `Configured ${role.toLowerCase()} lacks the required contract role`);
      transactionHash = await (role === "RELAYER" ? this.clients.relayerWrite : this.clients.reviewerWrite)({
        address: this.config.contractAddress, abi: this.config.abi as Abi, functionName, args
      });
      const pending: TransactionMetadata = {
        transactionHash, chainId: this.config.chainId, contractAddress: this.config.contractAddress,
        status: "pending", mock: false
      };
      this.transactions.set(transactionHash.toLowerCase(), pending);
      try {
        const receipt = await this.clients.waitForTransactionReceipt({
          hash: transactionHash, confirmations: this.config.confirmations, timeout: this.config.receiptTimeoutMs
        });
        const final = this.fromReceipt(receipt);
        this.transactions.set(transactionHash.toLowerCase(), final);
        return final;
      } catch {
        const timedOut = { ...pending, errorCode: "RECEIPT_TIMEOUT", errorMessage: "Transaction submitted but confirmation receipt timed out" };
        this.transactions.set(transactionHash.toLowerCase(), timedOut);
        return timedOut;
      }
    } catch {
      const failed = this.failed(transactionHash, "RPC_OR_TRANSACTION_FAILURE", "Blockchain transaction failed or RPC was unavailable");
      if (transactionHash !== `0x${"0".repeat(64)}`) this.transactions.set(transactionHash.toLowerCase(), failed);
      return failed;
    }
  }

  private readArgs(functionName: string, args: readonly unknown[]): Record<string, unknown> {
    return { address: this.config.contractAddress, abi: this.config.abi as Abi, functionName, args };
  }

  private fromReceipt(receipt: Receipt): TransactionMetadata {
    return receipt.status === "success"
      ? { transactionHash: receipt.transactionHash, chainId: this.config.chainId, contractAddress: this.config.contractAddress, status: "confirmed", blockNumber: receipt.blockNumber.toString(10), mock: false }
      : this.failed(receipt.transactionHash, "TRANSACTION_REVERTED", "Blockchain transaction reverted");
  }

  private failed(hash: Hex, errorCode: string, errorMessage: string): TransactionMetadata {
    return { transactionHash: hash, chainId: this.config.chainId, contractAddress: this.config.contractAddress, status: "failed", errorCode, errorMessage, mock: false };
  }
}

function normalizeDigest(value: string): string { return value.toLowerCase().replace(/^0x/, ""); }

function createClients(config: EvmAdapterConfig): EvmClients {
  const transport = http(config.rpcUrl);
  const publicClient = createPublicClient({ transport });
  const relayer = createWalletClient({ account: config.relayerAddress, transport });
  const reviewer = createWalletClient({ account: config.reviewerAddress, transport });
  return {
    getChainId: () => publicClient.getChainId(),
    getAddresses: async () => (await relayer.getAddresses()).map(getAddress),
    readContract: (args) => publicClient.readContract(args as never),
    waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args) as Promise<Receipt>,
    getTransactionReceipt: (args) => publicClient.getTransactionReceipt(args) as Promise<Receipt>,
    relayerWrite: (args) => relayer.writeContract(args as never),
    reviewerWrite: (args) => reviewer.writeContract(args as never)
  };
}

export type { EvmClients };
