import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { connectDatabase, type AgentDocument, type Database, type PhoneNumberDocument } from "./db.js";
import { ApiError } from "./errors.js";
import {
  deprovisionAgentPhoneNumber,
  getAgentPhoneProvisioningStatus,
  provisionAgentPhoneNumber,
  retainAgentPhoneNumberForReuse,
  type PhoneProvisioningProviders
} from "./phone-provisioning.js";

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
    database.collections.identityTokens.deleteMany({}),
    database.collections.phoneNumbers.deleteMany({}),
    database.collections.auditLogs.deleteMany({}),
    database.collections.policies.deleteMany({}),
    database.collections.billingAccounts.deleteMany({})
  ]);
});

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("phone provisioner", () => {
  it("buys Twilio number, links ElevenLabs agent, activates row, and audits", async () => {
    const agent = await insertAgent();
    const providers = fakeProviders();

    const active = await provisionAgentPhoneNumber(database.collections, config, agent, providers);

    expect(providers.searches).toEqual([{ country: "US" }]);
    expect(providers.purchases).toEqual([{ e164: "+15005550001", friendlyName: `barkan:${agent._id.toHexString()}`, agentId: agent._id.toHexString() }]);
    expect(providers.imports).toEqual([{ e164: "+15005550001", label: "Phone Agent (+15005550001)" }]);
    expect(providers.assignments).toEqual(["el-phone-1"]);
    expect(active).toMatchObject({
      status: "active",
      e164: "+15005550001",
      twilioSid: "PN123",
      elevenLabsPhoneNumberId: "el-phone-1",
      provisioningDetail: undefined
    });

    const persisted = await database.collections.phoneNumbers.findOne({ _id: active._id });
    expect(persisted).toMatchObject({ status: "active", elevenLabsPhoneNumberId: "el-phone-1" });
    expect(persisted).not.toHaveProperty("provisioningDetail");
    const updatedAgent = await database.collections.agents.findOne({ _id: agent._id });
    expect(updatedAgent?.capabilities.phone).toBe(true);
    await expect(getAgentPhoneProvisioningStatus(database.collections, agent)).resolves.toEqual({ state: "active", detail: "+15005550001" });

    const actions = (await database.collections.auditLogs.find({ agentId: agent._id }).sort({ createdAt: 1 }).toArray()).map((row) => row.action);
    expect(actions).toEqual([
      "phone.number.reserve",
      "phone.number.purchased",
      "phone.number.active",
      "phone.provisioned"
    ]);
  });

  it("blocks number provisioning when the plan has no phone numbers", async () => {
    const agent = await insertAgent();
    await database.collections.billingAccounts.updateOne(
      { ownerUserId: agent.ownerUserId },
      { $set: { plan: "free", updatedAt: new Date() }, $unset: { subscriptionStatus: "" } }
    );
    const providers = fakeProviders();

    await expect(provisionAgentPhoneNumber(database.collections, config, agent, providers)).rejects.toMatchObject({
      statusCode: 402,
      code: "plan_limit"
    });
    expect(providers.searches).toEqual([]);
    expect(await database.collections.phoneNumbers.countDocuments({ agentId: agent._id })).toBe(0);
  });

  it("skips candidate numbers already reserved in the database", async () => {
    const existingAgent = await insertAgent();
    await insertPhoneNumber(existingAgent, { status: "active", twilioSid: "PNexisting", elevenLabsPhoneNumberId: "el-existing" });
    const agent = await insertAgent();
    const providers = fakeProviders({
      searchNumbers: async () => [
        { e164: "+15005550001", friendlyName: "Used", locality: null, region: null, country: "US", voiceEnabled: true, smsEnabled: true, monthlyPriceCents: 115 },
        { e164: "+15005550002", friendlyName: "Open", locality: null, region: null, country: "US", voiceEnabled: true, smsEnabled: true, monthlyPriceCents: 115 }
      ]
    });

    const active = await provisionAgentPhoneNumber(database.collections, config, agent, providers);

    expect(active.e164).toBe("+15005550002");
    expect(providers.purchases[0]?.e164).toBe("+15005550002");
  });

  it("reuses a retained number from a deleted agent before searching or buying", async () => {
    const deletedAgent = await insertAgent({ phone: false });
    await database.collections.agents.updateOne({ _id: deletedAgent._id }, { $set: { status: "revoked", updatedAt: new Date() } });
    const retained = await insertPhoneNumber(deletedAgent, { status: "active", twilioSid: "PNretained", elevenLabsPhoneNumberId: undefined });
    const agent = await insertAgent({ ownerUserId: deletedAgent.ownerUserId ?? undefined });
    const providers = fakeProviders();

    const active = await provisionAgentPhoneNumber(database.collections, config, agent, providers);

    expect(active._id).toEqual(retained._id);
    expect(active.agentId).toEqual(agent._id);
    expect(active.e164).toBe("+15005550001");
    expect(providers.searches).toEqual([]);
    expect(providers.purchases).toEqual([]);
    expect(providers.releases).toEqual([]);
    expect(providers.imports).toEqual([{ e164: "+15005550001", label: "Phone Agent (+15005550001)" }]);
    expect(providers.assignments).toEqual(["el-phone-1"]);
    const updatedAgent = await database.collections.agents.findOne({ _id: agent._id });
    expect(updatedAgent?.capabilities.phone).toBe(true);
    const audits = (await database.collections.auditLogs.find({ agentId: agent._id }).sort({ createdAt: 1 }).toArray()).map((audit) => audit.action);
    expect(audits).toContain("phone.number.reused");
    expect(audits).not.toContain("phone.number.purchased");
  });

  it("compensates Twilio purchase when ElevenLabs import fails", async () => {
    const agent = await insertAgent();
    const providers = fakeProviders({
      importTwilioNumber: async () => {
        throw new ApiError(422, "provider_error", "invalid phone number");
      }
    });

    await expect(provisionAgentPhoneNumber(database.collections, config, agent, providers)).rejects.toMatchObject({
      statusCode: 422,
      code: "provider_error",
      message: "invalid phone number"
    });

    expect(providers.releases).toEqual(["PN123"]);
    expect(providers.removals).toEqual([]);
    const row = await database.collections.phoneNumbers.findOne({ agentId: agent._id });
    expect(row).toMatchObject({ status: "released", releaseDetail: "invalid phone number" });
    const updatedAgent = await database.collections.agents.findOne({ _id: agent._id });
    expect(updatedAgent?.capabilities.phone).toBe(false);
    await expect(getAgentPhoneProvisioningStatus(database.collections, agent)).resolves.toEqual({ state: "failed", detail: "invalid phone number" });
  });

  it("marks reservation released when Twilio purchase fails without leaking release calls", async () => {
    const agent = await insertAgent();
    const providers = fakeProviders({
      purchaseNumber: async () => {
        throw new ApiError(402, "provider_error", "Twilio balance too low");
      }
    });

    await expect(provisionAgentPhoneNumber(database.collections, config, agent, providers)).rejects.toMatchObject({
      statusCode: 402,
      code: "provider_error",
      message: "Twilio balance too low"
    });

    expect(providers.releases).toEqual([]);
    expect(providers.imports).toEqual([]);
    const row = await database.collections.phoneNumbers.findOne({ agentId: agent._id });
    expect(row).toMatchObject({ status: "released", releaseDetail: "Twilio balance too low" });
  });

  it("removes ElevenLabs link, releases Twilio number, flips capability, and audits on deprovision", async () => {
    const agent = await insertAgent({ phone: true });
    const row = await insertPhoneNumber(agent, { status: "active", twilioSid: "PN123", elevenLabsPhoneNumberId: "el-phone-1" });
    const providers = fakeProviders();

    await deprovisionAgentPhoneNumber(database.collections, config, agent, providers);

    expect(providers.removals).toEqual(["el-phone-1"]);
    expect(providers.releases).toEqual(["PN123"]);
    const released = await database.collections.phoneNumbers.findOne({ _id: row._id });
    expect(released?.status).toBe("released");
    const updatedAgent = await database.collections.agents.findOne({ _id: agent._id });
    expect(updatedAgent?.capabilities.phone).toBe(false);
    const actions = (await database.collections.auditLogs.find({ agentId: agent._id }).sort({ createdAt: 1 }).toArray()).map((audit) => audit.action);
    expect(actions).toEqual(["phone.number.released", "phone.released"]);
  });

  it("retains an active number for reuse without releasing Twilio", async () => {
    const agent = await insertAgent({ phone: true });
    const row = await insertPhoneNumber(agent, { status: "active", twilioSid: "PN123", elevenLabsPhoneNumberId: "el-phone-1" });
    const providers = fakeProviders();

    await retainAgentPhoneNumberForReuse(database.collections, config, agent, providers);

    expect(providers.removals).toEqual(["el-phone-1"]);
    expect(providers.releases).toEqual([]);
    const retained = await database.collections.phoneNumbers.findOne({ _id: row._id });
    expect(retained).toMatchObject({ status: "active", twilioSid: "PN123" });
    expect(retained?.elevenLabsPhoneNumberId).toBeUndefined();
    const updatedAgent = await database.collections.agents.findOne({ _id: agent._id });
    expect(updatedAgent?.capabilities.phone).toBe(false);
  });

  it("exposes mock route enable/disable through agent detail polling", async () => {
    const cookie = await signup("phone-route-owner@example.com");
    const created = await createAgent(cookie, { name: "Route Phone" });

    const enable = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${created.agent.id}/capabilities/phone/enable`,
      cookies: { [config.SESSION_COOKIE_NAME]: cookie }
    });
    expect(enable.statusCode).toBe(202);
    const enabledDetail = await waitForPhoneState(cookie, created.agent.id, true);
    expect(enabledDetail.agent.phoneE164).toBe("+15005550001");
    expect(enabledDetail.provisioning.phone).toEqual({ enabled: true, state: "active", detail: "+15005550001" });

    const disable = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${created.agent.id}/capabilities/phone/disable`,
      cookies: { [config.SESSION_COOKIE_NAME]: cookie }
    });
    expect(disable.statusCode).toBe(202);
    const disabledDetail = await waitForPhoneState(cookie, created.agent.id, false);
    expect(disabledDetail.agent.phoneE164).toBe(null);
    expect(disabledDetail.provisioning.phone.enabled).toBe(false);
  });
});

async function insertAgent(input: { phone?: boolean; ownerUserId?: ObjectId } = {}): Promise<AgentDocument> {
  const now = new Date();
  const ownerUserId = input.ownerUserId ?? new ObjectId();
  const agent: AgentDocument = {
    _id: new ObjectId(),
    ownerUserId,
    name: "Phone Agent",
    slug: `phone-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    status: "active",
    capabilities: { email: false, phone: input.phone ?? false },
    approvalMode: "policy",
    createdAt: now,
    updatedAt: now
  };
  await database.collections.billingAccounts.updateOne(
    { ownerUserId },
    {
      $set: {
        stripeCustomerId: `cus_${ownerUserId.toHexString()}`,
        plan: "pro",
        subscriptionStatus: "active",
        updatedAt: now
      },
      $setOnInsert: {
        _id: new ObjectId(),
        ownerUserId,
        createdAt: now
      }
    },
    { upsert: true }
  );
  await database.collections.agents.insertOne(agent);
  return agent;
}

async function insertPhoneNumber(
  agent: AgentDocument,
  input: Pick<PhoneNumberDocument, "status" | "twilioSid" | "elevenLabsPhoneNumberId">
): Promise<PhoneNumberDocument> {
  const now = new Date();
  const row: PhoneNumberDocument = {
    _id: new ObjectId(),
    agentId: agent._id,
    e164: "+15005550001",
    country: "US",
    twilioSid: input.twilioSid,
    elevenLabsPhoneNumberId: input.elevenLabsPhoneNumberId,
    capabilitiesVoice: true,
    capabilitiesSms: true,
    status: input.status,
    createdAt: now,
    updatedAt: now
  };
  await database.collections.phoneNumbers.insertOne(row);
  return row;
}

function fakeProviders(overrides: Partial<PhoneProvisioningProviders> = {}) {
  const state = {
    searches: [] as Array<{ country: string }>,
    purchases: [] as Array<{ e164: string; friendlyName: string; agentId: string }>,
    imports: [] as Array<{ e164: string; label: string }>,
    assignments: [] as string[],
    releases: [] as string[],
    removals: [] as string[]
  };
  return {
    ...state,
    searchNumbers: async (input: { country: string }) => {
      state.searches.push(input);
      return [{ e164: "+15005550001", country: input.country, voiceEnabled: true, smsEnabled: true, monthlyPriceCents: 115 }];
    },
    purchaseNumber: async (input: { e164: string; friendlyName: string; agentId: string }) => {
      state.purchases.push(input);
      return {
        twilioSid: "PN123",
        e164: input.e164,
        capabilities: { voice: true, sms: true },
        monthlyPriceCents: 115
      };
    },
    releaseNumber: (twilioSid: string) => {
      state.releases.push(twilioSid);
    },
    importTwilioNumber: async (input: { e164: string; label: string }) => {
      state.imports.push(input);
      return { phoneNumberId: "el-phone-1" };
    },
    assignAgentToNumber: async (phoneNumberId: string) => {
      state.assignments.push(phoneNumberId);
    },
    removeNumber: async (phoneNumberId: string) => {
      state.removals.push(phoneNumberId);
    },
    ...overrides
  };
}

async function signup(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email, password: "password12345" }
  });
  expect([200, 201]).toContain(response.statusCode);
  const cookie = response.cookies.find((candidate) => candidate.name === config.SESSION_COOKIE_NAME);
  expect(cookie).toBeDefined();
  const user = await database.collections.users.findOne({ email });
  expect(user).toBeTruthy();
  await database.collections.billingAccounts.updateOne(
    { ownerUserId: user!._id },
    { $set: { plan: "pro", subscriptionStatus: "active", updatedAt: new Date() } }
  );
  return cookie!.value;
}

async function createAgent(cookie: string, payload: Record<string, unknown>) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agents",
    cookies: { [config.SESSION_COOKIE_NAME]: cookie },
    payload
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ agent: { id: string } }>();
}

async function waitForPhoneState(cookie: string, agentId: string, enabled: boolean) {
  let lastBody: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agentId}`,
      cookies: { [config.SESSION_COOKIE_NAME]: cookie }
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json<{
      agent: { capabilities: { phone: boolean }; phoneE164: string | null };
      provisioning: { phone: { enabled: boolean; state: string; detail?: string } };
    }>();
    lastBody = body;
    if (body.agent.capabilities.phone === enabled) {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const audits = await database.collections.auditLogs.find({ agentId: new ObjectId(agentId) }).sort({ createdAt: 1 }).toArray();
  throw new Error(`phone capability never became ${enabled}: ${JSON.stringify({ lastBody, audits: audits.map((audit) => ({ action: audit.action, status: audit.status, detail: audit.detail })) })}`);
}
