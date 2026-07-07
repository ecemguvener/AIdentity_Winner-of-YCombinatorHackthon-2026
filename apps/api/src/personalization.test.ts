import { performance } from "node:perf_hooks";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { connectDatabase, type AgentDocument, type Database, type PhoneNumberDocument, type UserDocument } from "./db.js";
import { defaultEmailPolicy, defaultPhonePolicy } from "./policies.js";

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
    database.collections.sessions.deleteMany({}),
    database.collections.agents.deleteMany({}),
    database.collections.phoneNumbers.deleteMany({}),
    database.collections.calls.deleteMany({}),
    database.collections.policies.deleteMany({}),
    database.collections.auditLogs.deleteMany({}),
    database.collections.webhookEvents.deleteMany({})
  ]);
});

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("ElevenLabs personalization webhook", () => {
  it("returns per-agent initiation data and creates an inbound call row", async () => {
    const fixture = await insertFixture();

    const response = await deliver({
      caller_id: "+33612345678",
      called_number: fixture.phoneNumber.e164,
      call_sid: "CA_personalized_1",
      agent_id: "el-agent"
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    body.dynamic_variables.barkan_call_id = "CALL_ID";
    expect(body).toMatchInlineSnapshot(`
      {
        "conversation_config_override": {
          "agent": {
            "first_message": "Hi, this is Maya, Maxence's assistant. How can I help?",
          },
        },
        "dynamic_variables": {
          "agent_identity_name": "Maya",
          "agent_role": "recruiting concierge",
          "barkan_call_id": "CALL_ID",
          "inbound_guidance": "Collect caller details and offer a callback.",
          "owner_name": "Maxence",
        },
        "type": "conversation_initiation_client_data",
      }
    `);

    const call = await database.collections.calls.findOne({ providerCallId: "CA_personalized_1" });
    expect(call).toMatchObject({
      agentId: fixture.agent._id,
      phoneNumberId: fixture.phoneNumber._id,
      direction: "inbound",
      counterpartyE164: "+33612345678",
      status: "in_progress"
    });
    const audit = await database.collections.auditLogs.findOne({ action: "phone.call.inbound" });
    expect(audit).toMatchObject({ status: "allowed", resourceId: call?._id.toHexString() });
  });

  it("returns neutral decline for unknown called numbers", async () => {
    const response = await deliver({
      caller_id: "+33612345678",
      called_number: "+15005559999",
      call_sid: "CA_unknown_1"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      dynamic_variables: {
        agent_identity_name: "Barkan",
        inbound_guidance: "This number is not in service.",
        barkan_call_id: ""
      },
      conversation_config_override: { agent: { first_message: "This number is not in service." } }
    });
    expect(await database.collections.calls.countDocuments()).toBe(0);
  });

  it("blocks callers on the phone policy blocklist", async () => {
    const fixture = await insertFixture({ blockedCallers: ["+33612345678"] });

    const response = await deliver({
      caller_id: "+33 6 12 34 56 78",
      called_number: fixture.phoneNumber.e164,
      call_sid: "CA_blocked_1"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().conversation_config_override.agent.first_message).toBe("This assistant is not available for this call.");
    const call = await database.collections.calls.findOne({ providerCallId: "CA_blocked_1" });
    expect(call?.counterpartyE164).toBe("+33612345678");
    const audit = await database.collections.auditLogs.findOne({ action: "phone.call.inbound" });
    expect(audit).toMatchObject({ status: "blocked", detail: "Inbound call from +33612345678 blocked." });
  });

  it("declines calls when inbound phone policy is disabled", async () => {
    const fixture = await insertFixture({ inboundEnabled: false });

    const response = await deliver({
      caller_id: "+33612345678",
      called_number: fixture.phoneNumber.e164,
      call_sid: "CA_disabled_1"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().conversation_config_override.agent.first_message).toBe("This assistant is not available for this call.");
    const audit = await database.collections.auditLogs.findOne({ action: "phone.call.inbound" });
    expect(audit).toMatchObject({ status: "blocked", detail: "Inbound call from +33612345678 blocked: inbound disabled." });
  });

  it("rejects unsigned and malformed payloads before processing", async () => {
    const unsigned = await app.inject({
      method: "POST",
      url: "/webhooks/elevenlabs/personalization",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ caller_id: "+33612345678", called_number: "+15005550001", call_sid: "CA_unsigned" })
    });
    expect(unsigned.statusCode).toBe(401);

    const malformed = await deliver({
      caller_id: "not-a-number",
      called_number: "+15005550001",
      call_sid: "CA_malformed"
    });
    expect(malformed.statusCode).toBe(400);
    expect(await database.collections.calls.countDocuments()).toBe(0);
  });

  it("dedupes duplicate call_sid deliveries while returning initiation data", async () => {
    const fixture = await insertFixture();
    const payload = {
      caller_id: "+33612345678",
      called_number: fixture.phoneNumber.e164,
      call_sid: "CA_duplicate_1"
    };

    const first = await deliver(payload);
    const second = await deliver(payload);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await database.collections.calls.countDocuments({ providerCallId: "CA_duplicate_1" })).toBe(1);
    expect(await database.collections.webhookEvents.countDocuments({ provider: "elevenlabs", providerEventId: "CA_duplicate_1" })).toBe(1);
  });

  it("keeps personalization p50 latency under 300ms for indexed memory lookups", async () => {
    const fixture = await insertFixture();
    const durations: number[] = [];
    for (let index = 0; index < 100; index++) {
      const startedAt = performance.now();
      const response = await deliver({
        caller_id: "+33612345678",
        called_number: fixture.phoneNumber.e164,
        call_sid: `CA_bench_${index}`
      });
      expect(response.statusCode).toBe(200);
      durations.push(performance.now() - startedAt);
    }

    const p50 = durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)] ?? Number.POSITIVE_INFINITY;
    expect(p50).toBeLessThan(300);
  });
});

async function deliver(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/webhooks/elevenlabs/personalization",
    headers: { "content-type": "application/json", "x-mock-signature": "allow" },
    payload: JSON.stringify(payload)
  });
}

async function insertFixture(phonePolicy: Partial<ReturnType<typeof defaultPhonePolicy>> = {}): Promise<{
  user: UserDocument;
  agent: AgentDocument;
  phoneNumber: PhoneNumberDocument;
}> {
  const now = new Date();
  const user: UserDocument = {
    _id: new ObjectId(),
    email: `owner-${Math.random().toString(36).slice(2)}@example.com`,
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
    description: "recruiting concierge",
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

  await database.collections.users.insertOne(user);
  await database.collections.agents.insertOne(agent);
  await database.collections.phoneNumbers.insertOne(phoneNumber);
  await database.collections.policies.insertOne({
    _id: new ObjectId(),
    agentId: agent._id,
    email: defaultEmailPolicy(agent.approvalMode),
    phone: {
      ...defaultPhonePolicy(),
      inboundInstructions: "Collect caller details and offer a callback.",
      ...phonePolicy
    },
    createdAt: now,
    updatedAt: now
  });

  return { user, agent, phoneNumber };
}
