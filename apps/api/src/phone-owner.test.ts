import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { connectDatabase, type Database } from "./db.js";
import { defaultPhonePolicy } from "./policies.js";

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
let otherCookie: string;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);
  ownerCookie = await signup("phone-owner@example.com");
  otherCookie = await signup("phone-other@example.com");
}, 60_000);

beforeEach(async () => {
  await Promise.all([
    database.collections.agents.deleteMany({}),
    database.collections.identityTokens.deleteMany({}),
    database.collections.phoneNumbers.deleteMany({}),
    database.collections.calls.deleteMany({}),
    database.collections.smsMessages.deleteMany({}),
    database.collections.policies.deleteMany({}),
    database.collections.auditLogs.deleteMany({})
  ]);
});

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("owner phone routes", () => {
  it("returns phone overview and enforces ownership", async () => {
    const created = await createPhoneAgent("Route Owner");
    const own = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${created.agentId}/phone`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ phone: { number: { e164: "+15005550001", status: "active" } } });

    const other = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${created.agentId}/phone`,
      cookies: { [config.SESSION_COOKIE_NAME]: otherCookie }
    });
    expect(other.statusCode).toBe(404);
  });

  it("lets owners place calls and send SMS with owner audit actor", async () => {
    const created = await createPhoneAgent("Owner Actions");
    const call = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${created.agentId}/phone/call`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie },
      payload: { to: "+33612345678", task: "Confirm dinner" }
    });
    expect(call.statusCode).toBe(200);

    const sms = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${created.agentId}/phone/sms`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie },
      payload: { to: "+33612345678", body: "Dinner confirmed" }
    });
    expect(sms.statusCode).toBe(200);

    expect(await database.collections.auditLogs.findOne({ action: "phone.call.outbound" })).toMatchObject({ actor: "owner" });
    expect(await database.collections.auditLogs.findOne({ action: "sms.send" })).toMatchObject({ actor: "owner" });
  });

  it("lists SMS conversations and ordered thread messages", async () => {
    const created = await createPhoneAgent("SMS List");
    const agentId = new ObjectId(created.agentId);
    const phoneNumberId = new ObjectId(created.phoneNumberId);
    await database.collections.smsMessages.insertMany([
      smsMessage(agentId, phoneNumberId, "inbound", "+33612345678", "first", new Date("2026-07-07T10:00:00Z")),
      smsMessage(agentId, phoneNumberId, "outbound", "+33612345678", "second", new Date("2026-07-07T10:01:00Z"))
    ]);

    const conversations = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${created.agentId}/phone/sms`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
    });
    expect(conversations.statusCode).toBe(200);
    expect(conversations.json().conversations[0]).toMatchObject({ counterparty_e164: "+33612345678", message_count: 2 });

    const thread = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${created.agentId}/phone/sms?with=%2B33612345678`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
    });
    expect(thread.statusCode).toBe(200);
    expect(thread.json().messages.map((message: { body: string }) => message.body)).toEqual(["first", "second"]);
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
  const agentId = response.json().agent.id as string;
  const phoneNumberId = new ObjectId();
  await database.collections.phoneNumbers.insertOne({
    _id: phoneNumberId,
    agentId: new ObjectId(agentId),
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
  await database.collections.agents.updateOne({ _id: new ObjectId(agentId) }, { $set: { "capabilities.phone": true } });
  await database.collections.policies.updateOne(
    { agentId: new ObjectId(agentId) },
    { $set: { phone: { ...defaultPhonePolicy(), requireApprovalOutboundCall: "never", requireApprovalSms: "never" } } }
  );
  return { agentId, phoneNumberId: phoneNumberId.toHexString() };
}

function smsMessage(
  agentId: ObjectId,
  phoneNumberId: ObjectId,
  direction: "inbound" | "outbound",
  counterpartyE164: string,
  body: string,
  createdAt: Date
) {
  return {
    _id: new ObjectId(),
    agentId,
    phoneNumberId,
    direction,
    counterpartyE164,
    body,
    twilioMessageSid: `SM${Math.random().toString(36).slice(2)}`,
    status: direction === "inbound" ? "received" : "sent",
    createdAt,
    updatedAt: createdAt
  };
}
