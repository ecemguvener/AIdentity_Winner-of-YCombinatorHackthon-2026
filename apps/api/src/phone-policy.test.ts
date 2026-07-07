import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { connectDatabase, type Database, type PhonePolicy } from "./db.js";
import { countryIsoForE164 } from "./lib/phone-country.js";
import { quietHoursBlockReason } from "./phone-policy.js";

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
let phoneSequence = 0;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);
  ownerCookie = await signup("phone-policy-owner@example.com");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("phone and SMS policies", () => {
  it("maps E.164 prefixes by longest match", () => {
    expect(countryIsoForE164("+33612345678")).toBe("FR");
    expect(countryIsoForE164("+14155550123")).toBe("US");
    expect(countryIsoForE164("+447911123456")).toBe("GB");
    expect(countryIsoForE164("+9991234")).toBeNull();
  });

  it("blocks outbound calls to non-allowlisted countries and audits the reason", async () => {
    const created = await createPhoneAgent("Country Block");
    await putPhonePolicy(created.agent.id, {
      allowedCountries: ["FR"],
      requireApprovalOutboundCall: "never"
    });

    const blocked = await callAgent(created.identityToken.secret, "+14155550123");
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().message).toMatch(/country US not allowed/i);
    const audit = await database.collections.auditLogs.findOne({ agentId: new ObjectId(created.agent.id), action: "phone.blocked" });
    expect(audit?.detail).toMatch(/country US not allowed/i);
  });

  it("evaluates quiet hours in policy timezone across midnight", () => {
    const policy = {
      quietHours: { start: "22:00", end: "08:00", timezone: "Europe/Paris" }
    } as PhonePolicy;
    expect(quietHoursBlockReason(policy, new Date("2026-07-07T19:59:00.000Z"))).toBeNull();
    expect(quietHoursBlockReason(policy, new Date("2026-07-07T20:00:00.000Z"))).toMatch(/Europe\/Paris/);
    expect(quietHoursBlockReason({
      ...policy,
      quietHours: { start: "22:00", end: "08:00", timezone: "America/Los_Angeles" }
    }, new Date("2026-07-07T20:00:00.000Z"))).toBeNull();
  });

  it("enforces daily SMS limit before sending", async () => {
    const created = await createPhoneAgent("SMS Cap");
    await putPhonePolicy(created.agent.id, {
      requireApprovalSms: "never",
      dailySmsLimit: 1
    });
    expect((await sendSms(created.identityToken.secret, "+33612345678")).statusCode).toBe(200);

    const capped = await sendSms(created.identityToken.secret, "+33612345678");
    expect(capped.statusCode).toBe(403);
    expect(capped.json().message).toMatch(/daily SMS limit of 1/i);
    const audit = await database.collections.auditLogs.findOne({ agentId: new ObjectId(created.agent.id), action: "sms.blocked" });
    expect(audit?.detail).toMatch(/daily SMS limit/i);
  });

  it("wait-mode phone approval dials after owner approval", async () => {
    const created = await createPhoneAgent("Wait Phone");
    await putPhonePolicy(created.agent.id, {
      requireApprovalOutboundCall: "always"
    });
    const pendingResponse = app.inject({
      method: "POST",
      url: "/api/v1/agent/phone/call?wait=3",
      headers: { authorization: `Bearer ${created.identityToken.secret}` },
      payload: { to: "+33612345678", task: "Confirm appointment" }
    });
    const approval = await waitForPendingApproval(new ObjectId(created.agent.id));
    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approval._id.toHexString()}/approve`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
    });
    expect(approve.statusCode).toBe(200);

    const final = await pendingResponse;
    expect(final.statusCode).toBe(200);
    expect(final.json()).toMatchObject({ status: "queued", to: "+33612345678" });
    expect(await database.collections.calls.countDocuments({ agentId: new ObjectId(created.agent.id), counterpartyE164: "+33612345678" })).toBe(1);
  });
});

async function signup(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email, password: "password12345" }
  });
  expect(response.statusCode).toBe(200);
  await database.collections.billingAccounts.updateOne(
    { ownerUserId: (await database.collections.users.findOne({ email }))!._id },
    { $set: { plan: "scale", subscriptionStatus: "active", updatedAt: new Date() } }
  );
  return response.cookies.find((candidate) => candidate.name === config.SESSION_COOKIE_NAME)!.value;
}

async function createPhoneAgent(name: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agents",
    cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie },
    payload: { name, capabilities: { phone: false }, approvalMode: "policy" }
  });
  expect(response.statusCode).toBe(201);
  const created = response.json<{
    agent: { id: string };
    identityToken: { secret: string };
  }>();
  phoneSequence += 1;
  await database.collections.phoneNumbers.insertOne({
    _id: new ObjectId(),
    agentId: new ObjectId(created.agent.id),
    e164: `+15005550${String(phoneSequence).padStart(3, "0")}`,
    country: "US",
    twilioSid: "PN123",
    elevenLabsPhoneNumberId: "el-phone-1",
    capabilitiesVoice: true,
    capabilitiesSms: true,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date()
  });
  return created;
}

async function putPhonePolicy(agentId: string, patch: Partial<PhonePolicy>) {
  const current = await app.inject({
    method: "GET",
    url: `/api/v1/agents/${agentId}/policies/phone`,
    cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
  });
  expect(current.statusCode).toBe(200);
  const response = await app.inject({
    method: "PUT",
    url: `/api/v1/agents/${agentId}/policies/phone`,
    cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie },
    payload: { ...current.json().policy, ...patch }
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function callAgent(token: string, to: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/agent/phone/call",
    headers: { authorization: `Bearer ${token}` },
    payload: { to, task: "Policy test" }
  });
}

async function sendSms(token: string, to: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/agent/phone/sms",
    headers: { authorization: `Bearer ${token}` },
    payload: { to, body: "Hello" }
  });
}

async function waitForPendingApproval(agentId: ObjectId) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const approval = await database.collections.approvals.findOne({ agentId, status: "pending" });
    if (approval) return approval;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("approval not created");
}
