import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { AgentDocument, Collections, PairingRequestDocument } from "./db.js";
import { ApiError } from "./errors.js";
import { requireAuth } from "./auth.js";
import { issueOwnerToken } from "./agents-routes.js";
import { recordAudit } from "./audit.js";

const pairingTtlMs = 10 * 60_000;
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const codeSchema = z.object({
  code: z.string().min(8).max(16)
});

const confirmSchema = z.object({
  agentId: z.string().min(1)
});

export function registerPairingRoutes(app: FastifyInstance, collections: Collections, config: AppConfig): void {
  const sweeper = setInterval(() => {
    void expirePairingRequests(collections).catch((error) => {
      app.log.error({ error }, "pairing expiry sweeper failed");
    });
  }, 60_000);
  app.addHook("onClose", (_instance, done) => {
    clearInterval(sweeper);
    done();
  });

  app.post(
    "/api/v1/pairing/start",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 hour",
          groupId: "pairing-start",
          keyGenerator: (request) => request.ip,
          errorResponseBuilder: (_request, context) =>
            new ApiError(429, "rate_limited", "rate limit exceeded", { retryAfter: context.after })
        }
      }
    },
    async () => {
      const code = await createUniquePairingCode(collections);
      const now = new Date();
      await collections.pairingRequests.insertOne({
        _id: new ObjectId(),
        code,
        status: "pending",
        expiresAt: new Date(now.getTime() + pairingTtlMs),
        createdAt: now,
        updatedAt: now
      });
      const displayCode = formatPairingCode(code);
      return {
        code: displayCode,
        expiresInSeconds: pairingTtlMs / 1000,
        confirmUrl: `${config.PUBLIC_APP_URL.replace(/\/$/, "")}/pair?code=${displayCode}`
      };
    }
  );

  app.post("/api/v1/pairing/poll", async (request) => {
    const payload = codeSchema.parse(request.body ?? {});
    const code = normalizePairingCode(payload.code);
    const pairing = await collections.pairingRequests.findOne({ code });
    if (!pairing) {
      throw new ApiError(404, "not_found", "pairing code not found");
    }
    if (await expireIfNeeded(collections, pairing)) {
      return { status: "expired" };
    }
    if (pairing.status === "pending") {
      return { status: "pending" };
    }
    if (pairing.status === "expired") {
      return { status: "expired" };
    }
    if (pairing.status === "claimed" || !pairing.identityTokenPlaintext || !pairing.agentId) {
      throw new ApiError(409, "already_claimed", "pairing token was already claimed");
    }

    const claimed = await collections.pairingRequests.findOneAndUpdate(
      { _id: pairing._id, status: "confirmed", identityTokenPlaintext: { $exists: true } },
      {
        $set: { status: "claimed", updatedAt: new Date() },
        $unset: { identityTokenPlaintext: "" }
      },
      { returnDocument: "before" }
    );
    if (!claimed?.identityTokenPlaintext || !claimed.agentId) {
      throw new ApiError(409, "already_claimed", "pairing token was already claimed");
    }

    return {
      status: "confirmed",
      identityToken: claimed.identityTokenPlaintext,
      agentId: claimed.agentId.toHexString(),
      apiUrl: config.PUBLIC_API_URL.replace(/\/$/, "")
    };
  });

  app.post("/api/v1/pairing/:code/confirm", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const params = codeSchema.parse(request.params ?? {});
    const payload = confirmSchema.parse(request.body ?? {});
    const code = normalizePairingCode(params.code);
    const pairing = await collections.pairingRequests.findOne({ code });
    if (!pairing) {
      throw new ApiError(404, "not_found", "pairing code not found");
    }
    if (await expireIfNeeded(collections, pairing)) {
      throw new ApiError(409, "validation_failed", "pairing code expired");
    }
    if (pairing.status !== "pending") {
      throw new ApiError(409, pairing.status === "claimed" ? "already_claimed" : "validation_failed", `pairing code is ${pairing.status}`);
    }

    const agent = await findOwnedAgent(collections, authContext.user._id, payload.agentId);
    const { plaintext, tokenDoc } = await issueOwnerToken(collections, config, agent, "Paired runtime");
    const now = new Date();
    const updated = await collections.pairingRequests.findOneAndUpdate(
      { _id: pairing._id, status: "pending" },
      {
        $set: {
          status: "confirmed",
          ownerUserId: authContext.user._id,
          agentId: agent._id,
          identityTokenPlaintext: plaintext,
          tokenIssuedAt: now,
          updatedAt: now
        }
      },
      { returnDocument: "after" }
    );
    if (!updated) {
      throw new ApiError(409, "validation_failed", "pairing code is no longer pending");
    }

    await recordAudit(collections, {
      agentId: agent._id,
      ownerUserId: authContext.user._id,
      actor: "owner",
      action: "agent.token.create",
      status: "allowed",
      detail: `Identity token ${tokenDoc.prefix}… (Paired runtime) created by pairing.`,
      metadata: { pairingCode: formatPairingCode(code) }
    });

    return {
      status: "confirmed",
      agentId: agent._id.toHexString(),
      tokenPrefix: tokenDoc.prefix
    };
  });
}

async function createUniquePairingCode(collections: Collections): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomPairingCode();
    const existing = await collections.pairingRequests.findOne({ code }, { projection: { _id: 1 } });
    if (!existing) {
      return code;
    }
  }
  throw new ApiError(500, "internal", "could not create pairing code");
}

function randomPairingCode(): string {
  let code = "";
  const bytes = crypto.randomBytes(8);
  for (const byte of bytes) {
    code += codeAlphabet[byte % codeAlphabet.length];
  }
  return code;
}

function normalizePairingCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

async function expireIfNeeded(collections: Collections, pairing: PairingRequestDocument): Promise<boolean> {
  if (pairing.status === "expired") {
    return true;
  }
  if (pairing.status !== "pending" || pairing.expiresAt.getTime() > Date.now()) {
    return false;
  }
  await collections.pairingRequests.updateOne(
    { _id: pairing._id, status: "pending" },
    { $set: { status: "expired", updatedAt: new Date() } }
  );
  return true;
}

async function expirePairingRequests(collections: Collections): Promise<number> {
  const result = await collections.pairingRequests.updateMany(
    { status: "pending", expiresAt: { $lte: new Date() } },
    { $set: { status: "expired", updatedAt: new Date() } }
  );
  return result.modifiedCount;
}

async function findOwnedAgent(collections: Collections, ownerUserId: ObjectId, agentId: string): Promise<AgentDocument> {
  if (!ObjectId.isValid(agentId)) {
    throw new ApiError(404, "not_found", "agent identity not found");
  }
  const agent = await collections.agents.findOne({
    _id: new ObjectId(agentId),
    ownerUserId,
    status: { $ne: "revoked" }
  });
  if (!agent) {
    throw new ApiError(404, "not_found", "agent identity not found");
  }
  return agent;
}
