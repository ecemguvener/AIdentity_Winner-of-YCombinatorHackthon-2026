import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { connectDatabase, type Database } from "./db.js";
import { decideApproval, requestApproval, waitForDecision } from "./approvals.js";

const config = {
  NODE_ENV: "test",
  API_PORT: 0,
  PUBLIC_APP_URL: "http://localhost:4888",
  PUBLIC_API_URL: "http://localhost:4001",
  MONGODB_URI: "set-by-beforeAll",
  SESSION_COOKIE_NAME: "barkan_session",
  SESSION_SECRET: "test-barkan-session-secret",
  PROVIDER_MODE_EMAIL: "mock",
  PROVIDER_MODE_PHONE: "mock",
  TWILIO_NUMBER_COUNTRY: "US",
  ELEVENLABS_VOICE_ID: "voice",
  OPENAI_DASHBOARD_CHAT_MODEL: "gpt-5.4-2026-03-05",
  EMAIL_AGENT_DOMAIN: "agents.barkan.dev",
  EMAIL_PLATFORM_FROM: "Barkan <no-reply@barkan.dev>",
  API_RATE_LIMIT_MAX: 1000
} as unknown as AppConfig;

let mongoServer: MongoMemoryServer;
let database: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
let ownerCookie: string;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);
  ownerCookie = await signup("owner-approvals@example.com");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("approvals", () => {
  it("lists owner-scoped pending approvals", async () => {
    const created = await createAgent("Pending");
    const approval = await requestApproval(database.collections, {
      agentId: created.agent.id,
      ownerUserId: created.ownerUserId,
      kind: "email.send",
      payloadSummary: "Send email to alice@example.com",
      payload: { to: "alice@example.com", subject: "Hi" }
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/approvals?status=pending",
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().approvals[0]).toMatchObject({
      id: approval._id.toHexString(),
      status: "pending",
      payloadSummary: "Send email to alice@example.com",
      agentName: "Pending"
    });
  });

  it("allows exactly one concurrent decision", async () => {
    const created = await createAgent("Race");
    const approval = await requestApproval(database.collections, {
      agentId: created.agent.id,
      ownerUserId: created.ownerUserId,
      kind: "phone.call",
      payloadSummary: "Call +15550100",
      payload: { to: "+15550100" }
    });

    const [approved, rejected] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/approvals/${approval._id.toHexString()}/approve`,
        cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/approvals/${approval._id.toHexString()}/reject`,
        cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
      })
    ]);

    expect([approved.statusCode, rejected.statusCode].sort()).toEqual([200, 409]);
    const stored = await database.collections.approvals.findOne({ _id: approval._id });
    expect(["approved", "rejected"]).toContain(stored?.status);
  });

  it("exposes bearer-token approval status only to the owning agent", async () => {
    const created = await createAgent("Bearer");
    const other = await createAgent("Other");
    const approval = await requestApproval(database.collections, {
      agentId: created.agent.id,
      ownerUserId: created.ownerUserId,
      kind: "sms.send",
      payloadSummary: "Send SMS",
      payload: { to: "+15550123", body: "Hi" }
    });

    const own = await app.inject({
      method: "GET",
      url: `/api/v1/agent/approvals/${approval._id.toHexString()}`,
      headers: { authorization: `Bearer ${created.identityToken.secret}` }
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().approval.status).toBe("pending");

    const blocked = await app.inject({
      method: "GET",
      url: `/api/v1/agent/approvals/${approval._id.toHexString()}`,
      headers: { authorization: `Bearer ${other.identityToken.secret}` }
    });
    expect(blocked.statusCode).toBe(404);
  });

  it("waitForDecision resolves from DB poll fallback when emitter is bypassed", async () => {
    const created = await createAgent("Poll");
    const approval = await requestApproval(database.collections, {
      agentId: created.agent.id,
      ownerUserId: created.ownerUserId,
      kind: "email.send",
      payloadSummary: "Send follow-up",
      payload: { to: "bob@example.com" }
    });
    const waiter = waitForDecision(database.collections, approval._id, { timeoutMs: 6_500 });
    setTimeout(() => {
      void database.collections.approvals.updateOne(
        { _id: approval._id },
        { $set: { status: "approved", decidedAt: new Date(), updatedAt: new Date() } }
      );
    }, 20);

    await expect(waiter).resolves.toBe("approved");
  }, 8_000);

  it("decideApproval records audit and waiter resolves through emitter", async () => {
    const created = await createAgent("Emitter");
    const approval = await requestApproval(database.collections, {
      agentId: created.agent.id,
      ownerUserId: created.ownerUserId,
      kind: "phone.call",
      payloadSummary: "Call customer",
      payload: { to: "+15550100" }
    });
    const waiter = waitForDecision(database.collections, approval._id, { timeoutMs: 1_000 });
    await decideApproval(database.collections, created.ownerUserId, approval._id, "approved", "ok");

    await expect(waiter).resolves.toBe("approved");
    const audit = await database.collections.auditLogs.findOne({
      agentId: new ObjectId(created.agent.id),
      action: "approval.approved"
    });
    expect(audit?.resourceId).toBe(approval._id.toHexString());
  });
});

async function signup(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email, password: "password12345" }
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((candidate) => candidate.name === config.SESSION_COOKIE_NAME);
  expect(cookie).toBeDefined();
  return cookie!.value;
}

async function createAgent(name: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agents",
    cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie },
    payload: { name, capabilities: { email: true, phone: false } }
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{
    agent: { id: string; name: string };
    identityToken: { secret: string };
  }>();
  const agent = await database.collections.agents.findOne({ _id: new ObjectId(body.agent.id) });
  expect(agent?.ownerUserId).toBeDefined();
  return { ...body, ownerUserId: agent!.ownerUserId! };
}
