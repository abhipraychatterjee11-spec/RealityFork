import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { ChallengeSchema, CreateCommitSchema, type SignatureDomainConfig } from "@realityfork/shared";
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

export interface BuildAppOptions {
  store?: MemoryRealityStore;
  nonceRepository?: NonceRepository;
  signatureDomain?: SignatureDomainConfig;
  allowUnsignedDemoMode?: boolean;
  logger?: boolean;
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

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const store = options.store ?? new MemoryRealityStore();
  const nonces = options.nonceRepository ?? new MemoryNonceRepository();
  const signatureDomain = options.signatureDomain ?? signatureDomainFromEnvironment();
  const allowUnsignedDemoMode = options.allowUnsignedDemoMode ?? process.env.ALLOW_UNSIGNED_DEMO_MODE === "true";

  await app.register(cors, { origin: true });

  app.get("/health", async () => ({ ok: true, service: "realityfork-api" }));
  app.get("/api/commits", async () => ({ commits: store.list() }));

  app.post("/api/commits", async (request, reply) => {
    if (!allowUnsignedDemoMode) {
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
    if (!allowUnsignedDemoMode) {
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
    if (!allowUnsignedDemoMode) {
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
    try {
      const prepared = store.prepare(parsed.data.input);
      const authorization = await verifyCommitAuthorization(parsed.data.input, prepared, parsed.data.authorization, signatureDomain);
      const commit = nonces.consumeWith(authorization.signerAddress, authorization.nonce, () =>
        store.create(parsed.data.input, authorization)
      );
      return reply.code(201).send({ commit });
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
      return reply.code(201).send({ commit });
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
      return reply.code(201).send({ challenge });
    } catch (error) {
      return sendOperationError(reply, error, "Signed challenge failed", 409);
    }
  });

  app.get("/api/records/:subjectId/history", async (request) => {
    const { subjectId } = request.params as { subjectId: string };
    return { subjectId, commits: store.history(subjectId) };
  });

  return app;
}
