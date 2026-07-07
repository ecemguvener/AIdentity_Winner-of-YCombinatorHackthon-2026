import type { FastifyRequest } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { connectDatabase, type AgentDocument, type Database } from "./db.js";
import { hashApiKey } from "./security.js";
import { authenticateAgentRequest, issueIdentityToken } from "./agent-auth.js";

let mongoServer: MongoMemoryServer;
let database: Database;

function requestWithAuthorization(authorization?: string): FastifyRequest {
  return { headers: authorization ? { authorization } : {}, ip: "203.0.113.10" } as FastifyRequest;
}

async function createAgent(status: AgentDocument["status"] = "active"): Promise<AgentDocument> {
  const now = new Date();
  const agent: AgentDocument = {
    _id: new ObjectId(),
    ownerUserId: null,
    name: "Test Agent",
    slug: `test-agent-${new ObjectId().toHexString()}`,
    status,
    capabilities: { email: true, phone: true },
    approvalMode: "always",
    createdAt: now,
    updatedAt: now
  };
  await database.collections.agents.insertOne(agent);
  return agent;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  database = await connectDatabase({ MONGODB_URI: mongoServer.getUri() } as AppConfig);
}, 60_000);

afterAll(async () => {
  await database?.client.close();
  await mongoServer?.stop();
});

describe("issueIdentityToken", () => {
  it("returns a brk_live_ plaintext once and stores only hash + prefix", async () => {
    const agent = await createAgent();
    const { plaintext, tokenDoc } = await issueIdentityToken(database.collections, agent._id, "default");
    expect(plaintext).toMatch(/^brk_live_[A-Za-z0-9_-]{43}$/);
    expect(tokenDoc.tokenHash).toBe(hashApiKey(plaintext));
    expect(tokenDoc.prefix).toBe(plaintext.slice(0, 12));
    const stored = await database.collections.identityTokens.findOne({ _id: tokenDoc._id });
    expect(stored?.tokenHash).toBe(hashApiKey(plaintext));
    expect(JSON.stringify(stored)).not.toContain(plaintext);
  });

  it("supports test mode prefixes", async () => {
    const agent = await createAgent();
    const { plaintext } = await issueIdentityToken(database.collections, agent._id, "default", { mode: "test" });
    expect(plaintext).toMatch(/^brk_test_/);
  });
});

describe("authenticateAgentRequest", () => {
  it("authenticates a valid token and stamps lastUsedAt", async () => {
    const agent = await createAgent();
    const { plaintext, tokenDoc } = await issueIdentityToken(database.collections, agent._id, "default");
    const context = await authenticateAgentRequest(requestWithAuthorization(`Bearer ${plaintext}`), database.collections);
    expect(context?.agent._id.equals(agent._id)).toBe(true);
    expect(context?.token._id.equals(tokenDoc._id)).toBe(true);
    const stored = await database.collections.identityTokens.findOne({ _id: tokenDoc._id });
    expect(stored?.lastUsedAt).toBeInstanceOf(Date);
    expect(stored?.lastUsedIp).toBe("203.0.113.10");
  });

  it("rejects a missing header and a non-bearer scheme", async () => {
    expect(await authenticateAgentRequest(requestWithAuthorization(), database.collections)).toBeNull();
    expect(await authenticateAgentRequest(requestWithAuthorization("Basic abc"), database.collections)).toBeNull();
  });

  it("rejects an unknown token", async () => {
    const context = await authenticateAgentRequest(
      requestWithAuthorization("Bearer brk_live_unknown-token"),
      database.collections
    );
    expect(context).toBeNull();
  });

  it("rejects a revoked token", async () => {
    const agent = await createAgent();
    const { plaintext, tokenDoc } = await issueIdentityToken(database.collections, agent._id, "default");
    await database.collections.identityTokens.updateOne({ _id: tokenDoc._id }, { $set: { status: "revoked" } });
    expect(await authenticateAgentRequest(requestWithAuthorization(`Bearer ${plaintext}`), database.collections)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const agent = await createAgent();
    const { plaintext } = await issueIdentityToken(database.collections, agent._id, "default", {
      expiresAt: new Date(Date.now() - 1000)
    });
    expect(await authenticateAgentRequest(requestWithAuthorization(`Bearer ${plaintext}`), database.collections)).toBeNull();
  });

  it("rejects a token whose agent is not active", async () => {
    const agent = await createAgent("paused");
    const { plaintext } = await issueIdentityToken(database.collections, agent._id, "default");
    expect(await authenticateAgentRequest(requestWithAuthorization(`Bearer ${plaintext}`), database.collections)).toBeNull();
  });

  it("authenticates legacy migrated api keys (same hash function)", async () => {
    const agent = await createAgent();
    const legacyPlaintextKey = "ck_legacy-plaintext-key";
    const now = new Date();
    await database.collections.identityTokens.insertOne({
      _id: new ObjectId(),
      agentId: agent._id,
      ownerUserId: null,
      tokenHash: hashApiKey(legacyPlaintextKey),
      prefix: legacyPlaintextKey.slice(0, 12),
      name: "legacy key",
      status: "active",
      createdAt: now,
      updatedAt: now
    });
    const context = await authenticateAgentRequest(
      requestWithAuthorization(`Bearer ${legacyPlaintextKey}`),
      database.collections
    );
    expect(context?.agent._id.equals(agent._id)).toBe(true);
  });
});
