import { readFile } from "node:fs/promises";
import path from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { connectDatabase, type AgentDocument, type CallDocument, type Database, type PhoneNumberDocument, type UserDocument } from "./db.js";
import { defaultEmailPolicy, defaultPhonePolicy } from "./policies.js";
import { estimateCallCostCents } from "./phone-post-call.js";

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
  CALL_COST_CENTS_PER_MINUTE: 15,
  API_RATE_LIMIT_MAX: 1000
} as unknown as AppConfig;

let mongoServer: MongoMemoryServer;
let database: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
let fixturePayload: Record<string, unknown>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);
  fixturePayload = JSON.parse(await readFile(path.join(process.cwd(), "src/webhooks/__fixtures__/post-call-completed.json"), "utf8")) as Record<string, unknown>;
}, 60_000);

beforeEach(async () => {
  await Promise.all([
    database.collections.users.deleteMany({}),
    database.collections.agents.deleteMany({}),
    database.collections.phoneNumbers.deleteMany({}),
    database.collections.calls.deleteMany({}),
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

describe("ElevenLabs post-call webhook", () => {
  it("finalizes a call matched by conversation id", async () => {
    const { agent, call } = await insertFixture({ elevenLabsConversationId: "conv_fixture_completed" });

    const response = await deliver({ ...fixturePayload, event_id: "evt_match_conversation" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, call_id: call._id.toHexString() });
    const updated = await database.collections.calls.findOne({ _id: call._id });
    expect(updated).toMatchObject({
      status: "completed",
      durationSecs: 61,
      summary: "Caller asked Maya to call back tomorrow; follow-up scheduled.",
      costCents: 30,
      transcript: [
        { role: "agent", message: "Hi, this is Maya calling from Barkan.", timeInCallSecs: 1 },
        { role: "user", message: "Great, please call back tomorrow.", timeInCallSecs: 22 }
      ]
    });
    const audit = await database.collections.auditLogs.findOne({ agentId: agent._id, action: "phone.call.outbound" });
    expect(audit).toMatchObject({ status: "allowed", resourceId: call._id.toHexString() });
    const usage = await database.collections.usageEvents.findOne({ agentId: agent._id, meter: "call_minutes" });
    expect(usage).toMatchObject({ quantity: 2, stripeReported: false });
  });

  it("falls back to dynamic_variables.barkan_call_id and stores conversation id", async () => {
    const { call } = await insertFixture();
    const payload = withCallId({ ...fixturePayload, event_id: "evt_match_barkan_id" }, call._id);

    const response = await deliver(payload);

    expect(response.statusCode).toBe(200);
    const updated = await database.collections.calls.findOne({ _id: call._id });
    expect(updated).toMatchObject({ status: "completed", elevenLabsConversationId: "conv_fixture_completed" });
  });

  it("falls back to metadata.call_sid for inbound calls", async () => {
    const { agent, call } = await insertFixture({ direction: "inbound", providerCallId: "CA_fixture_123" });
    const payload = withCallId({ ...fixturePayload, event_id: "evt_match_call_sid" }, new ObjectId());

    const response = await deliver(payload);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, call_id: call._id.toHexString() });
    const audit = await database.collections.auditLogs.findOne({ agentId: agent._id, action: "phone.call.inbound" });
    expect(audit).toMatchObject({ status: "allowed", resourceId: call._id.toHexString() });
  });

  it("marks unmatched post-call events skipped", async () => {
    const response = await deliver({ ...fixturePayload, event_id: "evt_unmatched" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ skipped: true, reason: "call not found" });
    const event = await database.collections.webhookEvents.findOne({ providerEventId: "evt_unmatched" });
    expect(event).toMatchObject({ status: "skipped" });
  });

  it("discards transcript turns when phone policy disables transcript storage", async () => {
    const { call } = await insertFixture({ elevenLabsConversationId: "conv_fixture_completed", storeTranscripts: false });

    const response = await deliver({ ...fixturePayload, event_id: "evt_no_transcript_storage" });

    expect(response.statusCode).toBe(200);
    const updated = await database.collections.calls.findOne({ _id: call._id });
    expect(updated).toMatchObject({
      status: "completed",
      durationSecs: 61,
      summary: "Caller asked Maya to call back tomorrow; follow-up scheduled.",
      transcript: []
    });
  });

  it("processes duplicate webhook delivery once", async () => {
    const { call } = await insertFixture({ elevenLabsConversationId: "conv_fixture_completed" });
    const payload = { ...fixturePayload, event_id: "evt_duplicate_post_call" };

    const first = await deliver(payload);
    const second = await deliver(payload);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ skipped: true });
    expect(await database.collections.auditLogs.countDocuments({ resourceId: call._id.toHexString() })).toBe(1);
  });

  it("computes duration-based call cost per started minute", () => {
    expect(estimateCallCostCents(0, 15)).toBe(0);
    expect(estimateCallCostCents(59, 15)).toBe(15);
    expect(estimateCallCostCents(61, 15)).toBe(30);
  });
});

async function deliver(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/webhooks/elevenlabs/post-call",
    headers: { "content-type": "application/json", "x-mock-signature": "allow" },
    payload: JSON.stringify(payload)
  });
}

async function insertFixture(input: {
  direction?: CallDocument["direction"];
  elevenLabsConversationId?: string;
  providerCallId?: string;
  storeTranscripts?: boolean;
} = {}): Promise<{ user: UserDocument; agent: AgentDocument; phoneNumber: PhoneNumberDocument; call: CallDocument }> {
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
    approvalMode: "policy",
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
  const call: CallDocument = {
    _id: new ObjectId(),
    agentId: agent._id,
    phoneNumberId: phoneNumber._id,
    direction: input.direction ?? "outbound",
    counterpartyE164: "+33612345678",
    providerCallId: input.providerCallId,
    elevenLabsConversationId: input.elevenLabsConversationId,
    task: "Book appointment",
    status: "in_progress",
    createdAt: now,
    updatedAt: now
  };

  await database.collections.users.insertOne(user);
  await database.collections.agents.insertOne(agent);
  await database.collections.phoneNumbers.insertOne(phoneNumber);
  await database.collections.calls.insertOne(call);
  await database.collections.policies.insertOne({
    _id: new ObjectId(),
    agentId: agent._id,
    email: defaultEmailPolicy(agent.approvalMode),
    phone: { ...defaultPhonePolicy(), storeTranscripts: input.storeTranscripts ?? true },
    createdAt: now,
    updatedAt: now
  });

  return { user, agent, phoneNumber, call };
}

function withCallId(payload: Record<string, unknown>, callId: ObjectId): Record<string, unknown> {
  const next = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  const data = next.data as { conversation_initiation_client_data: { dynamic_variables: { barkan_call_id: string } } };
  data.conversation_initiation_client_data.dynamic_variables.barkan_call_id = callId.toHexString();
  return next;
}
