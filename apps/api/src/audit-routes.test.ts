import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { buildApp } from "./app.js";
import { recordAudit } from "./audit.js";
import { connectDatabase, type AgentDocument, type Database, type SessionDocument, type UserDocument } from "./db.js";
import { createSessionExpiry, hashPassword, hashSessionToken } from "./security.js";

const config: AppConfig = {
  NODE_ENV: "test",
  API_PORT: 0,
  PUBLIC_APP_URL: "http://localhost:4888",
  PUBLIC_API_URL: "http://localhost:4001",
  MONGODB_URI: "mongodb://127.0.0.1:27017/barkan-test",
  SESSION_COOKIE_NAME: "barkan_session",
  SESSION_SECRET: "test-barkan-session-secret",
  PROVIDER_MODE_EMAIL: "mock",
  PROVIDER_MODE_PHONE: "mock",
  TWILIO_NUMBER_COUNTRY: "US",
  ELEVENLABS_VOICE_ID: "voice",
  OPENAI_DASHBOARD_CHAT_MODEL: "gpt-5.4-2026-03-05",
  EMAIL_AGENT_DOMAIN: "agents.barkan.dev",
  EMAIL_PLATFORM_FROM: "Barkan <no-reply@barkan.dev>",
  API_RATE_LIMIT_MAX: 300
} as AppConfig;

let mongoServer: MongoMemoryServer;
let database: Database;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  database = await connectDatabase({ MONGODB_URI: mongoServer.getUri() } as AppConfig);
}, 60_000);

afterAll(async () => {
  await database?.client.close();
  await mongoServer?.stop();
});

describe("owner audit routes", () => {
  it("scopes rows to the signed-in owner and supports action prefix filtering", async () => {
    const ownerA = await createUser("owner-a@example.test");
    const ownerB = await createUser("owner-b@example.test");
    const sessionA = await createSession(ownerA, "session-a");
    const agentA1 = await createAgent(ownerA._id, "A one");
    const agentA2 = await createAgent(ownerA._id, "A two");
    const agentB1 = await createAgent(ownerB._id, "B one");
    const agentB2 = await createAgent(ownerB._id, "B two");

    await Promise.all([
      recordAudit(database.collections, {
        agentId: agentA1._id,
        ownerUserId: ownerA._id,
        actor: "agent",
        action: "email.send",
        status: "allowed",
        detail: "A sent"
      }),
      recordAudit(database.collections, {
        agentId: agentA2._id,
        ownerUserId: ownerA._id,
        actor: "agent",
        action: "email.receive",
        status: "allowed",
        detail: "A received"
      }),
      recordAudit(database.collections, {
        agentId: agentB1._id,
        ownerUserId: ownerB._id,
        actor: "agent",
        action: "email.send",
        status: "allowed",
        detail: "B sent"
      }),
      recordAudit(database.collections, {
        agentId: agentB2._id,
        ownerUserId: ownerB._id,
        actor: "agent",
        action: "phone.call.outbound",
        status: "allowed",
        detail: "B called"
      })
    ]);

    const app = await buildApp(config, database.collections);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/audit?action=email.",
      cookies: { [config.SESSION_COOKIE_NAME]: sessionA }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ entries: Array<{ agent_id: string; action: string }>; next_cursor: string | null }>();
    expect(body.entries).toHaveLength(2);
    expect(body.entries.map((entry) => entry.action).sort()).toEqual(["email.receive", "email.send"]);
    expect(body.entries.every((entry) => [agentA1._id.toHexString(), agentA2._id.toHexString()].includes(entry.agent_id))).toBe(true);

    await app.close();
  });

  it("paginates by cursor and exports matching rows as CSV", async () => {
    const owner = await createUser("csv-owner@example.test");
    const session = await createSession(owner, "session-csv");
    const agent = await createAgent(owner._id, "CSV Agent");

    for (let index = 0; index < 5; index += 1) {
      await recordAudit(database.collections, {
        agentId: agent._id,
        ownerUserId: owner._id,
        actor: "agent",
        action: "email.send",
        status: "allowed",
        detail: `Sent, row "${index}"`
      });
    }

    const app = await buildApp(config, database.collections);
    const firstPage = await app.inject({
      method: "GET",
      url: "/api/v1/audit?limit=2",
      cookies: { [config.SESSION_COOKIE_NAME]: session }
    });
    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json<{ entries: Array<{ id: string }>; next_cursor: string }>();
    expect(firstBody.entries).toHaveLength(2);
    expect(firstBody.next_cursor).toBe(firstBody.entries[1].id);

    const secondPage = await app.inject({
      method: "GET",
      url: `/api/v1/audit?limit=2&cursor=${firstBody.next_cursor}`,
      cookies: { [config.SESSION_COOKIE_NAME]: session }
    });
    expect(secondPage.statusCode).toBe(200);
    const secondBody = secondPage.json<{ entries: Array<{ id: string }> }>();
    expect(secondBody.entries.map((entry) => entry.id)).not.toContain(firstBody.entries[0].id);

    const csv = await app.inject({
      method: "GET",
      url: "/api/v1/audit/export.csv?action=email.",
      cookies: { [config.SESSION_COOKIE_NAME]: session }
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.payload.split("\n")[0]).toBe("id,agent_id,owner_user_id,actor,action,status,detail,resource_type,resource_id,metadata,created_at");
    expect(csv.payload).toContain('"Sent, row ""0"""');

    await app.close();
  });
});

async function createUser(email: string): Promise<UserDocument> {
  const now = new Date();
  const user: UserDocument = {
    _id: new ObjectId(),
    email,
    passwordHash: await hashPassword("demo-password"),
    createdAt: now
  };
  await database.collections.users.insertOne(user);
  return user;
}

async function createSession(user: UserDocument, token: string): Promise<string> {
  const session: SessionDocument = {
    _id: new ObjectId(),
    userId: user._id,
    tokenHash: hashSessionToken(token, config.SESSION_SECRET),
    expiresAt: createSessionExpiry(),
    createdAt: new Date()
  };
  await database.collections.sessions.insertOne(session);
  return token;
}

async function createAgent(ownerUserId: ObjectId, name: string): Promise<AgentDocument> {
  const now = new Date();
  const agent: AgentDocument = {
    _id: new ObjectId(),
    ownerUserId,
    name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${new ObjectId().toHexString()}`,
    status: "active",
    capabilities: { email: true, phone: true },
    approvalMode: "always",
    createdAt: now,
    updatedAt: now
  };
  await database.collections.agents.insertOne(agent);
  return agent;
}
