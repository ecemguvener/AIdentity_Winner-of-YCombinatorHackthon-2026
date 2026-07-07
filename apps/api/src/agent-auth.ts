import crypto from "node:crypto";
import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import { ObjectId } from "mongodb";
import type { AgentDocument, Collections, IdentityTokenDocument } from "./db.js";
import { hashApiKey } from "./security.js";

// ---------------------------------------------------------------------------
// Agent bearer-token authentication, backed by the `agents` + `identityTokens`
// collections. Tokens are stored hashed (sha256, same function as legacy api
// keys so migrated keys keep authenticating); only the prefix is kept for
// display.
// ---------------------------------------------------------------------------

export type IdentityTokenMode = "live" | "test";

export interface AgentAuthContext {
  agent: AgentDocument;
  token: IdentityTokenDocument;
}

declare module "fastify" {
  interface FastifyRequest {
    agentContext?: AgentAuthContext;
  }
}

const TOKEN_PREFIX_LENGTH = 12;
const LAST_USED_UPDATE_INTERVAL_MS = 60_000;

export function createIdentityTokenPlaintext(mode: IdentityTokenMode): string {
  return `brk_${mode}_${crypto.randomBytes(32).toString("base64url")}`;
}

export function identityTokenPrefix(plaintext: string): string {
  return plaintext.slice(0, TOKEN_PREFIX_LENGTH);
}

export async function issueIdentityToken(
  collections: Collections,
  agentId: ObjectId,
  name: string,
  options: { mode?: IdentityTokenMode; expiresAt?: Date } = {}
): Promise<{ plaintext: string; tokenDoc: IdentityTokenDocument }> {
  const agent = await collections.agents.findOne({ _id: agentId });
  if (!agent) {
    throw new Error("cannot issue identity token: agent not found");
  }
  const plaintext = createIdentityTokenPlaintext(options.mode ?? "live");
  const now = new Date();
  const tokenDoc: IdentityTokenDocument = {
    _id: new ObjectId(),
    agentId,
    ownerUserId: agent.ownerUserId,
    tokenHash: hashApiKey(plaintext),
    prefix: identityTokenPrefix(plaintext),
    name,
    status: "active",
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    createdAt: now,
    updatedAt: now
  };
  await collections.identityTokens.insertOne(tokenDoc);
  return { plaintext, tokenDoc };
}

function readBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return null;
  }
  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }
  return token.trim() || null;
}

export async function authenticateAgentRequest(
  request: FastifyRequest,
  collections: Collections
): Promise<AgentAuthContext | null> {
  const plaintext = readBearerToken(request);
  if (!plaintext) {
    return null;
  }
  const token = await collections.identityTokens.findOne({
    tokenHash: hashApiKey(plaintext),
    status: "active"
  });
  if (!token) {
    return null;
  }
  const now = new Date();
  if (token.expiresAt && token.expiresAt.getTime() <= now.getTime()) {
    return null;
  }
  const agent = await collections.agents.findOne({ _id: token.agentId, status: "active" });
  if (!agent) {
    return null;
  }
  if (!token.lastUsedAt || now.getTime() - token.lastUsedAt.getTime() >= LAST_USED_UPDATE_INTERVAL_MS) {
    token.lastUsedAt = now;
    await collections.identityTokens.updateOne({ _id: token._id }, { $set: { lastUsedAt: now } });
  }
  return { agent, token };
}

export function requireAgentAuth(collections: Collections): preHandlerHookHandler {
  return async (request, reply) => {
    const agentContext = await authenticateAgentRequest(request, collections);
    if (!agentContext) {
      return reply.code(401).send({ error: "missing or invalid identity token" });
    }
    request.agentContext = agentContext;
  };
}
