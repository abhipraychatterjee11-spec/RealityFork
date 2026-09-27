import { timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  ChallengeSchema,
  CreateCommitSchema,
  ZERO_DIGEST,
  type BlockchainAnchorMetadata,
  type ChallengeRecord,
  type RealityCommit,
  type SignatureDomainConfig
} from "@realityfork/shared";
import {
  AuthorizationError,
  SignedChallengeRequestSchema,
  SignedCommitRequestSchema,
  prepareChallengeAuthorization,
  verifyChallengeAuthorization,
  verifyCommitAuthorization
} from "./authorization.js";
import { MemoryNonceRepository, NonceReplayError, type NonceRepository } from "./nonce.js";
import { MemoryRealityStore } from "./store.js";
import { createBlockchainAdapterFromEnvironment } from "./blockchain/factory.js";
import type { BlockchainAdapter, SignedChallengeAnchorRequest, SignedCommitAnchorRequest, TransactionMetadata } from "./blockchain/types.js";

export interface BuildAppOptions {
  store?: MemoryRealityStore;
  nonceRepository?: NonceRepository;
  signatureDomain?: SignatureDomainConfig;
  allowUnsignedDemoMode?: boolean;
  logger?: boolean;
  blockchainAdapter?: BlockchainAdapter;
  reviewerApiToken?: string;
}

export function signatureDomainFromEnvironment(): SignatureDomainConfig | undefined {
  const chainId = Number(process.env.SIGNATURE_CHAIN_ID);
  const verifyingContract = process.env.REGISTRY_CONTRACT_ADDRESS;
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !verifyingContract) return undefined;
  return { chainId, verifyingContract };
}

function sendOperationError(reply: FastifyReply, error: unknown, fallback: string, fallbackStatus: number) {
  if (error instanceof AuthorizationError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  }
  if (error instanceof NonceReplayError) {
    return reply.code(409).send({ error: error.message, code: error.code });
  }
  return reply.code(fallbackStatus).send({ error: error instanceof Error ? error.message : fallback });
}

function anchorMetadata(transaction: TransactionMetadata, submittedAt: string): BlockchainAnchorMetadata {
  return {
    status: transaction.status,
    transactionHash: transaction.transactionHash,
    chainId: transaction.chainId,
    contractAddress: transaction.contractAddress,
    blockNumber: transaction.blockNumber,
    errorCode: transaction.errorCode,
    errorMessage: transaction.errorMessage,
    submittedAt,
    confirmedAt: transaction.status === "confirmed" ? new Date().toISOString() : undefined,
    mock: transaction.mock
  };
}

function failedAnchor(blockchain: BlockchainAdapter, error: unknown, submittedAt: string): BlockchainAnchorMetadata {
  return {
    status: "failed",
    errorCode: "BLOCKCHAIN_ADAPTER_ERROR",
    errorMessage: error instanceof Error ? error.message : "Blockchain adapter submission failed",
    submittedAt,
    mock: blockchain.mock
  };
}

function commitAnchorRequest(commit: RealityCommit): SignedCommitAnchorRequest {
  const authorization = commit.authorization;
  if (!authorization) throw new Error("Signed authorization metadata is missing");
  return {
    commitHash: commit.commitHash,
    evidenceRoot: commit.evidenceRoot,
    parentA: commit.parentCommitHashes[0] ?? ZERO_DIGEST,
    parentB: commit.parentCommitHashes[1] ?? ZERO_DIGEST,
    author: authorization.signerAddress,
    nonce: authorization.nonce,
    expiresAt: authorization.expiresAt,
    authorSignature: authorization.signature
  };
}

function challengeAnchorRequest(challenge: ChallengeRecord, target: RealityCommit): SignedChallengeAnchorRequest {
  const authorization = challenge.authorization;
  if (!authorization || !challenge.challengeHash || !challenge.challengeEvidenceRoot) {
    throw new Error("Signed challenge authorization metadata is missing");
  }
  return {
    challengeHash: challenge.challengeHash,
    targetCommitHash: target.commitHash,
    challengeEvidenceRoot: challenge.challengeEvidenceRoot,
    challenger: authorization.signerAddress,
    nonce: authorization.nonce,
    expiresAt: authorization.expiresAt,
    challengerSignature: authorization.signature
  };
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const store = options.store ?? new MemoryRealityStore();
  const nonces = options.nonceRepository ?? new MemoryNonceRepository();
  const signatureDomain = options.signatureDomain ?? signatureDomainFromEnvironment();
  const allowUnsignedDemoMode = options.allowUnsignedDemoMode ?? process.env.ALLOW_UNSIGNED_DEMO_MODE === "true";
  const blockchain = options.blockchainAdapter ?? await createBlockchainAdapterFromEnvironment();
  const reviewerApiToken = options.reviewerApiToken ?? (process.env.REVIEWER_API_TOKEN?.trim() || undefined);

  if (reviewerApiToken && Buffer.byteLength(reviewerApiToken, "utf8") < 32) {
    throw new Error("REVIEWER_API_TOKEN must contain at least 32 bytes");
  }

  function requireReviewerAccess(request: FastifyRequest, reply: FastifyReply): boolean {
    if (!reviewerApiToken) {
      void reply.code(503).send({ error: "Reviewer API authorization is not configured", code: "REVIEWER_AUTH_CONFIGURATION_MISSING" });
      return false;
    }
    const supplied = request.headers["x-reviewer-token"];
    const candidate = typeof supplied === "string" ? supplied : "";
    const expectedBytes = Buffer.from(reviewerApiToken, "utf8");
    const candidateBytes = Buffer.from(candidate, "utf8");
    const authorized = candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
    if (!authorized) {
      void reply.code(403).send({ error: "Reviewer authorization failed", code: "REVIEWER_AUTH_REQUIRED" });
      return false;
    }
    return true;
  }

  const unsignedWritesAllowed = allowUnsignedDemoMode && blockchain.mock;

  async function anchorCommit(commit: RealityCommit): Promise<RealityCommit> {
    const submittedAt = new Date().toISOString();
    store.updateCommitAnchor(commit.id, { status: "pending", submittedAt, mock: blockchain.mock });
    const isMerge = commit.parentIds.length === 2;
    try {
      const transaction = await (isMerge
        ? blockchain.anchorReviewedMerge(commitAnchorRequest(commit))
        : blockchain.anchorSignedCommit(commitAnchorRequest(commit)));
      let metadata = anchorMetadata(transaction, submittedAt);
      store.updateCommitAnchor(commit.id, metadata);
      if (transaction.status !== "confirmed") return commit;

      if (!blockchain.mock) {
        const previousStatus = commit.status;
        if (isMerge) commit.status = "merged";
        const verification = await blockchain.verifyCommitAnchor(commit);
        metadata = {
          ...metadata,
          verificationStatus: verification.status,
          verificationMessage: verification.message,
          verificationMismatches: verification.mismatches
        };
        if (verification.status !== "verified") {
          if (isMerge) commit.status = previousStatus;
          metadata = {
            ...metadata,
            status: "failed",
            errorCode: "ANCHOR_VERIFICATION_MISMATCH",
            errorMessage: `Confirmed transaction could not be reconciled: ${verification.message}`,
            confirmedAt: undefined
          };
          store.updateCommitAnchor(commit.id, metadata);
          return commit;
        }
        store.updateCommitAnchor(commit.id, metadata);
      }
      if (isMerge) store.confirmReviewedMerge(commit.id);
      return commit;
    } catch (error) {
      store.updateCommitAnchor(commit.id, failedAnchor(blockchain, error, submittedAt));
      return commit;
    }
  }

  async function anchorChallenge(challenge: ChallengeRecord): Promise<ChallengeRecord> {
    const submittedAt = new Date().toISOString();
    store.updateChallengeAnchor(challenge.id, { status: "pending", submittedAt, mock: blockchain.mock });
    try {
      const target = store.get(challenge.commitId);
      if (!target) throw new Error("Challenge target commit is missing");
      const transaction = await blockchain.anchorSignedChallenge(challengeAnchorRequest(challenge, target));
      store.updateChallengeAnchor(challenge.id, anchorMetadata(transaction, submittedAt));
    } catch (error) {
      store.updateChallengeAnchor(challenge.id, failedAnchor(blockchain, error, submittedAt));
    }
    return challenge;
  }

  await app.register(cors, { origin: true });

  app.get("/health", async () => ({ ok: true, service: "realityfork-api" }));
  app.get("/api/blockchain/health", async () => blockchain.healthCheck());
  app.get("/api/commits", async () => ({ commits: store.list() }));
  app.get("/api/commits/:id/blockchain-verification", async (request, reply) => {
    const { id } = request.params as { id: string };
    const commit = store.get(id);
    if (!commit) return reply.code(404).send({ error: "Commit not found", code: "COMMIT_NOT_FOUND" });
    return { commitId: id, verification: await blockchain.verifyCommitAnchor(commit) };
  });
  app.get("/api/commits/:id/blockchain-anchor", async (request, reply) => {
    const { id } = request.params as { id: string };
    const commit = store.get(id);
    if (!commit) return reply.code(404).send({ error: "Commit not found", code: "COMMIT_NOT_FOUND" });
    return { commitId: id, anchor: commit.blockchainAnchor };
  });
  app.post("/api/commits/:id/blockchain-anchor", async (request, reply) => {
    const { id } = request.params as { id: string };
    const commit = store.get(id);
    if (!commit) return reply.code(404).send({ error: "Commit not found", code: "COMMIT_NOT_FOUND" });
    if (commit.parentIds.length === 2 && !requireReviewerAccess(request, reply)) return;
    if (!commit.authorization) return reply.code(409).send({ error: "Unsigned records cannot be anchored", code: "ANCHOR_AUTHORIZATION_MISSING" });
    if (commit.blockchainAnchor.status === "confirmed") {
      return reply.code(409).send({ error: "Commit anchor is already confirmed", code: "ANCHOR_ALREADY_CONFIRMED" });
    }
    await anchorCommit(commit);
    return { commit, anchor: commit.blockchainAnchor };
  });
  app.get("/api/challenges/:id/blockchain-anchor", async (request, reply) => {
    const { id } = request.params as { id: string };
    const challenge = store.getChallenge(id);
    if (!challenge) return reply.code(404).send({ error: "Challenge not found", code: "CHALLENGE_NOT_FOUND" });
    return { challengeId: id, anchor: challenge.blockchainAnchor };
  });
  app.post("/api/challenges/:id/blockchain-anchor", async (request, reply) => {
    const { id } = request.params as { id: string };
    const challenge = store.getChallenge(id);
    if (!challenge) return reply.code(404).send({ error: "Challenge not found", code: "CHALLENGE_NOT_FOUND" });
    if (!challenge.authorization) return reply.code(409).send({ error: "Unsigned records cannot be anchored", code: "ANCHOR_AUTHORIZATION_MISSING" });
    if (challenge.blockchainAnchor.status === "confirmed") {
      return reply.code(409).send({ error: "Challenge anchor is already confirmed", code: "ANCHOR_ALREADY_CONFIRMED" });
    }
    await anchorChallenge(challenge);
    return { challenge, anchor: challenge.blockchainAnchor };
  });

  app.post("/api/commits", async (request, reply) => {
    if (!unsignedWritesAllowed) {
      return reply.code(403).send({ error: "Unsigned demo mode is disabled", code: "UNSIGNED_DEMO_DISABLED" });
    }
    const parsed = CreateCommitSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid commit", details: parsed.error.flatten() });
    try {
      return reply.code(201).send({ commit: store.create(parsed.data) });
    } catch (error) {
      return sendOperationError(reply, error, "Commit failed", 409);
    }
  });

  app.post("/api/commits/:id/forks", async (request, reply) => {
    if (!unsignedWritesAllowed) {
      return reply.code(403).send({ error: "Unsigned demo mode is disabled", code: "UNSIGNED_DEMO_DISABLED" });
    }
    const { id } = request.params as { id: string };
    const parsed = CreateCommitSchema.safeParse({ ...(request.body as object), parentIds: [id] });
    if (!parsed.success) return reply.code(400).send({ error: "Invalid fork", details: parsed.error.flatten() });
    try {
      return reply.code(201).send({ commit: store.create(parsed.data) });
    } catch (error) {
      return sendOperationError(reply, error, "Fork failed", 409);
    }
  });

  app.post("/api/commits/:id/challenges", async (request, reply) => {
    if (!unsignedWritesAllowed) {
      return reply.code(403).send({ error: "Unsigned demo mode is disabled", code: "UNSIGNED_DEMO_DISABLED" });
    }
    const { id } = request.params as { id: string };
    const parsed = ChallengeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid challenge", details: parsed.error.flatten() });
    try {
      return reply.code(201).send({ challenge: store.challenge(id, parsed.data) });
    } catch (error) {
      return sendOperationError(reply, error, "Challenge failed", 404);
    }
  });

  app.post("/api/signed/commits", async (request, reply) => {
    if (!signatureDomain) {
      return reply.code(503).send({ error: "Signature verification is not configured", code: "SIGNATURE_CONFIGURATION_MISSING" });
    }
    const parsed = SignedCommitRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid signed commit", details: parsed.error.flatten() });
    if (parsed.data.input.parentIds.length !== 0) {
      return reply.code(400).send({ error: "Signed root commits cannot include parents; use the fork or merge route", code: "INVALID_ROOT_PARENTS" });
    }
    try {
      const prepared = store.prepare(parsed.data.input);
      const authorization = await verifyCommitAuthorization(parsed.data.input, prepared, parsed.data.authorization, signatureDomain);
      const commit = nonces.consumeWith(authorization.signerAddress, authorization.nonce, () =>
        store.create(parsed.data.input, authorization)
      );
      await anchorCommit(commit);
      return reply.code(201).send({ commit, anchor: commit.blockchainAnchor });
    } catch (error) {
      return sendOperationError(reply, error, "Signed commit failed", 409);
    }
  });

  app.post("/api/signed/commits/:id/forks", async (request, reply) => {
    if (!signatureDomain) {
      return reply.code(503).send({ error: "Signature verification is not configured", code: "SIGNATURE_CONFIGURATION_MISSING" });
    }
    const { id } = request.params as { id: string };
    const body = request.body as { input?: object } | undefined;
    const parsed = SignedCommitRequestSchema.safeParse({
      ...(body ?? {}),
      input: { ...(body?.input ?? {}), parentIds: [id] }
    });
    if (!parsed.success) return reply.code(400).send({ error: "Invalid signed fork", details: parsed.error.flatten() });
    try {
      const prepared = store.prepare(parsed.data.input);
      const authorization = await verifyCommitAuthorization(parsed.data.input, prepared, parsed.data.authorization, signatureDomain);
      const commit = nonces.consumeWith(authorization.signerAddress, authorization.nonce, () =>
        store.create(parsed.data.input, authorization)
      );
      await anchorCommit(commit);
      return reply.code(201).send({ commit, anchor: commit.blockchainAnchor });
    } catch (error) {
      return sendOperationError(reply, error, "Signed fork failed", 409);
    }
  });

  app.post("/api/signed/commits/:id/challenges", async (request, reply) => {
    if (!signatureDomain) {
      return reply.code(503).send({ error: "Signature verification is not configured", code: "SIGNATURE_CONFIGURATION_MISSING" });
    }
    const { id } = request.params as { id: string };
    const parsed = SignedChallengeRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid signed challenge", details: parsed.error.flatten() });
    try {
      const target = store.get(id);
      if (!target) return reply.code(404).send({ error: "Commit not found" });
      const prepared = prepareChallengeAuthorization(parsed.data.input, target.commitHash, parsed.data.authorization);
      const authorization = await verifyChallengeAuthorization(parsed.data.input, prepared, parsed.data.authorization, signatureDomain);
      const challenge = nonces.consumeWith(authorization.signerAddress, authorization.nonce, () =>
        store.challenge(id, parsed.data.input, {
          challengeHash: prepared.challengeHash,
          challengeEvidenceRoot: prepared.challengeEvidenceRoot
        }, authorization)
      );
      await anchorChallenge(challenge);
      return reply.code(201).send({ challenge, anchor: challenge.blockchainAnchor });
    } catch (error) {
      return sendOperationError(reply, error, "Signed challenge failed", 409);
    }
  });

  app.post("/api/signed/merges", async (request, reply) => {
    if (!requireReviewerAccess(request, reply)) return;
    if (!signatureDomain) {
      return reply.code(503).send({ error: "Signature verification is not configured", code: "SIGNATURE_CONFIGURATION_MISSING" });
    }
    const parsed = SignedCommitRequestSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.input.parentIds.length !== 2) {
      return reply.code(400).send({ error: "A reviewed merge requires exactly two parent IDs", code: "INVALID_MERGE_PARENTS" });
    }
    try {
      const prepared = store.prepare(parsed.data.input);
      const authorization = await verifyCommitAuthorization(parsed.data.input, prepared, parsed.data.authorization, signatureDomain);
      const commit = nonces.consumeWith(authorization.signerAddress, authorization.nonce, () =>
        store.create(parsed.data.input, authorization)
      );
      await anchorCommit(commit);
      return reply.code(201).send({ commit, anchor: commit.blockchainAnchor });
    } catch (error) {
      return sendOperationError(reply, error, "Signed merge failed", 409);
    }
  });

  app.get("/api/records/:subjectId/history", async (request) => {
    const { subjectId } = request.params as { subjectId: string };
    return { subjectId, commits: store.history(subjectId) };
  });

  return app;
}
