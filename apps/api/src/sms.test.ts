import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { issueIdentityToken } from "./agent-auth.js";
import type { AppConfig } from "./config.js";
import { connectDatabase, type AgentDocument, type Database, type PhoneNumberDocument, type UserDocument } from "./db.js";
import { defaultEmailPolicy, defaultPhonePolicy } from "./policies.js";
import { findLatestSmsCode, sendAgentSms } from "./sms-service.js";
import { sendSms, type TwilioSmsClient } from "./providers/twilio-sms.js";

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

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);
}, 60_000);

beforeEach(async () => {
  await Promise.all([
    database.collections.users.deleteMany({}),
    database.collections.agents.deleteMany({}),
    database.collections.identityTokens.deleteMany({}),
    database.collections.phoneNumbers.deleteMany({}),
    database.collections.smsMessages.deleteMany({}),
    database.collections.policies.deleteMany({}),
    database.collections.auditLogs.deleteMany({}),
    database.collections.webhookEvents.deleteMany({}),
    database.collections.usageEvents.deleteMany({})
  ]);
});

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("SMS provider and service", () => {
  it("sends live SMS through Twilio messages.create shape", async () => {
    const create = vi.fn(async () => ({ sid: "SM123" }));
    const result = await sendSms({
      ...config,
      PROVIDER_MODE_PHONE: "live",
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "token"
    }, {
      from: "+15005550001",
      to: "+33612345678",
      body: "Hello",
      statusCallback: "https://api.example.com/webhooks/twilio/status"
    }, { messages: { create } } as TwilioSmsClient);

    expect(result).toEqual({ twilioMessageSid: "SM123" });
    expect(create).toHaveBeenCalledWith({
      from: "+15005550001",
      to: "+33612345678",
      body: "Hello",
      statusCallback: "https://api.example.com/webhooks/twilio/status"
    });
  });

  it("sends agent SMS, stores it, audits it, and lists conversation chronologically", async () => {
    const { agent, token } = await insertFixture();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/phone/sms",
      headers: { authorization: `Bearer ${token}` },
      payload: { to: "+33 6 12 34 56 78", body: "Hi, Maya here.", idempotencyKey: "sms-1" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().message).toMatchObject({
      direction: "outbound",
      counterparty_e164: "+33612345678",
      body: "Hi, Maya here.",
      status: "sent",
      twilio_message_sid: expect.stringMatching(/^SMmock/)
    });
    expect(await database.collections.auditLogs.findOne({ action: "sms.send" })).toMatchObject({ status: "allowed" });
    expect(await database.collections.usageEvents.findOne({ agentId: agent._id, meter: "sms_messages" })).toMatchObject({ quantity: 1 });

    const repeat = await app.inject({
      method: "POST",
      url: "/api/v1/agent/phone/sms",
      headers: { authorization: `Bearer ${token}` },
      payload: { to: "+33612345678", body: "Hi, Maya here.", idempotencyKey: "sms-1" }
    });
    expect(repeat.statusCode).toBe(200);
    expect(await database.collections.smsMessages.countDocuments({ agentId: agent._id })).toBe(1);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/agent/phone/sms?with=%2B33612345678",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().messages).toHaveLength(1);
  });

  it("ingests inbound SMS as TwiML and dedupes MessageSid retries", async () => {
    const { agent } = await insertFixture();
    const params = { MessageSid: "SMinbound1", From: "+33612345678", To: "+15005550001", Body: "Your code is 482913" };

    const first = await deliverTwilioForm("/webhooks/twilio/sms", params);
    const second = await deliverTwilioForm("/webhooks/twilio/sms", params);

    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toContain("text/xml");
    expect(first.payload).toBe("<Response/>");
    expect(second.payload).toBe("<Response/>");
    expect(await database.collections.smsMessages.countDocuments({ agentId: agent._id, twilioMessageSid: "SMinbound1" })).toBe(1);
    expect(await database.collections.auditLogs.findOne({ action: "sms.receive" })).toMatchObject({ status: "allowed" });
  });

  it("returns TwiML for unknown numbers without storing a message", async () => {
    await insertFixture();

    const response = await deliverTwilioForm("/webhooks/twilio/sms", {
      MessageSid: "SMunknown",
      From: "+33612345678",
      To: "+15005559999",
      Body: "Hello?"
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toBe("<Response/>");
    expect(await database.collections.smsMessages.countDocuments()).toBe(0);
  });

  it("updates outbound delivery status and audits failures", async () => {
    const { agent } = await insertFixture();
    await sendAgentSms(database.collections, config, { agent, to: "+33612345678", body: "Hello" });
    const message = await database.collections.smsMessages.findOne({ direction: "outbound" });
    expect(message?.twilioMessageSid).toBeTruthy();

    const delivered = await deliverTwilioForm("/webhooks/twilio/status", {
      MessageSid: message!.twilioMessageSid!,
      MessageStatus: "delivered"
    });
    expect(delivered.statusCode).toBe(200);
    expect(await database.collections.smsMessages.findOne({ _id: message!._id })).toMatchObject({ status: "delivered" });

    const failed = await deliverTwilioForm("/webhooks/twilio/status", {
      MessageSid: message!.twilioMessageSid!,
      MessageStatus: "undelivered",
      ErrorCode: "30007"
    });
    expect(failed.statusCode).toBe(200);
    expect(await database.collections.smsMessages.findOne({ _id: message!._id })).toMatchObject({ status: "undelivered" });
    expect(await database.collections.auditLogs.findOne({ status: "blocked", action: "sms.send" })).toMatchObject({ detail: "SMS undelivered (30007)." });
  });

  it("rejects unsigned Twilio webhooks", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/sms",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ MessageSid: "SMbad", From: "+33612345678", To: "+15005550001", Body: "Hi" }).toString()
    });
    expect(response.statusCode).toBe(401);
  });

  it("extracts the newest recent SMS verification code", async () => {
    const { agent, token, phoneNumber } = await insertFixture();
    await insertInbound(agent, phoneNumber, "+15550100", "Noise only", new Date("2026-07-07T10:00:00Z"));
    await insertInbound(agent, phoneNumber, "+15550100", "Your code is 111111", new Date("2026-07-07T10:01:00Z"));
    await insertInbound(agent, phoneNumber, "+15550100", "Use 482913 to sign in", new Date("2026-07-07T10:02:00Z"));

    await expect(findLatestSmsCode(database.collections, agent, { from: "+15550100" })).resolves.toMatchObject({ code: "482913" });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agent/phone/sms/latest-code?from=%2B15550100&since=2026-07-07T10%3A00%3A30.000Z",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ code: "482913", from: "+15550100" });
  });
});

async function deliverTwilioForm(url: string, params: Record<string, string>) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded", "x-mock-signature": "allow" },
    payload: new URLSearchParams(params).toString()
  });
}

async function insertFixture(): Promise<{ user: UserDocument; agent: AgentDocument; phoneNumber: PhoneNumberDocument; token: string }> {
  const now = new Date();
  const user: UserDocument = {
    _id: new ObjectId(),
    email: "owner@example.com",
    displayName: "Maxence",
    passwordHash: "hash",
    createdAt: now,
    updatedAt: now
  };
  const agent: AgentDocument = {
    _id: new ObjectId(),
    ownerUserId: user._id,
    name: "Maya",
    slug: `maya-${Math.random().toString(36).slice(2)}`,
    status: "active",
    capabilities: { email: false, phone: true },
    approvalMode: "autonomous",
    createdAt: now,
    updatedAt: now
  };
  const phoneNumber: PhoneNumberDocument = {
    _id: new ObjectId(),
    agentId: agent._id,
    e164: "+15005550001",
    country: "US",
    twilioSid: "PN123",
    elevenLabsPhoneNumberId: "el-phone-1",
    capabilitiesVoice: true,
    capabilitiesSms: true,
    status: "active",
    createdAt: now,
    updatedAt: now
  };
  await database.collections.users.insertOne(user);
  await database.collections.agents.insertOne(agent);
  await database.collections.phoneNumbers.insertOne(phoneNumber);
  await database.collections.policies.insertOne({
    _id: new ObjectId(),
    agentId: agent._id,
    email: defaultEmailPolicy(agent.approvalMode),
    phone: defaultPhonePolicy(),
    createdAt: now,
    updatedAt: now
  });
  const { plaintext } = await issueIdentityToken(database.collections, agent._id, "default", { mode: "test" });
  return { user, agent, phoneNumber, token: plaintext };
}

async function insertInbound(agent: AgentDocument, phoneNumber: PhoneNumberDocument, from: string, body: string, createdAt: Date) {
  await database.collections.smsMessages.insertOne({
    _id: new ObjectId(),
    agentId: agent._id,
    phoneNumberId: phoneNumber._id,
    direction: "inbound",
    counterpartyE164: from,
    body,
    twilioMessageSid: `SM${Math.random().toString(36).slice(2)}`,
    status: "received",
    createdAt,
    updatedAt: createdAt
  });
}
