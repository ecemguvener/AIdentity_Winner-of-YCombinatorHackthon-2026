import Fastify from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { connectDatabase, type Database } from "./db.js";
import { registerIdentityRoutes } from "./identity.js";

const config = {
  PUBLIC_API_URL: "http://localhost:4001",
  PROVIDER_MODE_EMAIL: "mock",
  PROVIDER_MODE_PHONE: "mock",
  EMAIL_AGENT_DOMAIN: "agents.barkan.dev"
} as AppConfig;

let mongoServer: MongoMemoryServer;
let database: Database;

function buildApp() {
  const app = Fastify({ logger: false });
  registerIdentityRoutes(app, database.collections, config);
  return app;
}

async function initAgent(app: ReturnType<typeof buildApp>) {
  const response = await app.inject({
    method: "POST",
    url: "/api/identity/init",
    payload: {
      agent_name: "Maya",
      agent_runtime: "openclaw",
      use_case: "customer_discovery",
      tools: ["email", "phone", "calendar"]
    }
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ agent_id: string; identity_token: string; email: string; phone: null }>();
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  database = await connectDatabase({ MONGODB_URI: mongoServer.getUri() } as AppConfig);
}, 60_000);

afterAll(async () => {
  await database?.client.close();
  await mongoServer?.stop();
});

describe("identity layer routes (Mongo-backed)", () => {
  it("initializes a persisted agent with a hashed token and provisioned email", async () => {
    const app = buildApp();
    const init = await initAgent(app);

    expect(ObjectId.isValid(init.agent_id)).toBe(true);
    expect(init.identity_token).toMatch(/^brk_test_[A-Za-z0-9_-]{43}$/);
    expect(init.email).toBe("maya@agents.barkan.dev");
    expect(init.phone).toBeNull();
    expect(init).not.toHaveProperty("calendar_url");

    const agent = await database.collections.agents.findOne({ _id: new ObjectId(init.agent_id) });
    expect(agent?.status).toBe("active");
    expect(agent?.ownerUserId).toBeNull();
    expect(agent?.capabilities).toEqual({ email: true, phone: true });

    const policy = await database.collections.policies.findOne({ agentId: new ObjectId(init.agent_id) });
    expect(policy).not.toBeNull();

    const token = await database.collections.identityTokens.findOne({ agentId: new ObjectId(init.agent_id) });
    expect(token?.prefix).toBe(init.identity_token.slice(0, 12));
    expect(token?.tokenHash).not.toContain(init.identity_token);

    await app.close();
  });

  it("gates and audits tool actions", async () => {
    const app = buildApp();
    const init = await initAgent(app);

    const blocked = await app.inject({
      method: "POST",
      url: "/api/tools/phone/call",
      headers: { authorization: `Bearer ${init.identity_token}` },
      payload: { to: "+1 555 0100", script: "Hi, can we talk?" }
    });
    expect(blocked.statusCode).toBe(409);

    await database.collections.phoneNumbers.insertOne({
      _id: new ObjectId(),
      agentId: new ObjectId(init.agent_id),
      e164: "+15005550001",
      country: "US",
      twilioSid: "PN123",
      elevenLabsPhoneNumberId: "el-phone-1",
      capabilitiesVoice: true,
      capabilitiesSms: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date()
    });
    await database.collections.policies.updateOne(
      { agentId: new ObjectId(init.agent_id) },
      { $set: { "phone.requireApprovalOutboundCall": "never" } }
    );

    const allowed = await app.inject({
      method: "POST",
      url: "/api/tools/phone/call",
      headers: { authorization: `Bearer ${init.identity_token}` },
      payload: { to: "+1 555 0100", script: "Hi, can we talk?", approved: true }
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json<{ ok: boolean; from: string; transcript?: unknown }>())
      .toMatchObject({ ok: true, from: "+15005550001", to: "+15550100" });
    expect(allowed.json()).not.toHaveProperty("transcript");

    const audit = await app.inject({
      method: "GET",
      url: `/api/identity/${init.agent_id}/audit-log`,
      headers: { authorization: `Bearer ${init.identity_token}` }
    });
    expect(audit.statusCode).toBe(200);
    const actions = audit.json<{ audit_log: Array<{ action: string }> }>().audit_log.map((entry) => entry.action);
    expect(actions).toContain("identity.init");
    expect(actions).toContain("phone.call.outbound");

    await app.close();
  });

  it("keeps tokens working across a process restart (new app, same database)", async () => {
    const app = buildApp();
    const init = await initAgent(app);
    await app.close();

    const restartedApp = buildApp();
    const audit = await restartedApp.inject({
      method: "GET",
      url: `/api/identity/${init.agent_id}/audit-log`,
      headers: { authorization: `Bearer ${init.identity_token}` }
    });
    expect(audit.statusCode).toBe(200);
    const actions = audit.json<{ audit_log: Array<{ action: string }> }>().audit_log.map((entry) => entry.action);
    expect(actions).toContain("identity.init");

    await restartedApp.close();
  });

  it("rotates tokens: old token 401s, new token works", async () => {
    const app = buildApp();
    const init = await initAgent(app);

    const rotate = await app.inject({
      method: "POST",
      url: "/api/identity/tokens/rotate",
      headers: { authorization: `Bearer ${init.identity_token}` }
    });
    expect(rotate.statusCode).toBe(200);
    const rotated = rotate.json<{ identity_token: string; token_prefix: string }>();
    expect(rotated.identity_token).toMatch(/^brk_test_/);
    expect(rotated.identity_token).not.toBe(init.identity_token);

    const oldTokenResponse = await app.inject({
      method: "GET",
      url: `/api/identity/${init.agent_id}/audit-log`,
      headers: { authorization: `Bearer ${init.identity_token}` }
    });
    expect(oldTokenResponse.statusCode).toBe(401);

    const newTokenResponse = await app.inject({
      method: "GET",
      url: `/api/identity/${init.agent_id}/audit-log`,
      headers: { authorization: `Bearer ${rotated.identity_token}` }
    });
    expect(newTokenResponse.statusCode).toBe(200);

    await app.close();
  });

  it("revokes the presented token: 401 afterwards plus an audit row", async () => {
    const app = buildApp();
    const init = await initAgent(app);

    const revoke = await app.inject({
      method: "POST",
      url: "/api/identity/revoke",
      headers: { authorization: `Bearer ${init.identity_token}` }
    });
    expect(revoke.statusCode).toBe(200);

    const afterRevoke = await app.inject({
      method: "GET",
      url: `/api/identity/${init.agent_id}/audit-log`,
      headers: { authorization: `Bearer ${init.identity_token}` }
    });
    expect(afterRevoke.statusCode).toBe(401);

    const auditRow = await database.collections.auditLogs.findOne({
      agentId: new ObjectId(init.agent_id),
      action: "identity.revoke"
    });
    expect(auditRow?.status).toBe("allowed");

    await app.close();
  });
});
