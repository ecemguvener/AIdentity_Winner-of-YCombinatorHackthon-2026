import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.js";
import { connectDatabase, type AgentDocument, type Database, type PhoneNumberDocument, type UserDocument } from "./db.js";
import { defaultEmailPolicy, defaultPhonePolicy } from "./policies.js";
import { buildPersonalAssistantCallBrief, getAgentPhoneCall, listAgentPhoneCalls, placeOutboundCall, waitForCallCompletion } from "./phone-service.js";

const config = {
  PROVIDER_MODE_PHONE: "mock",
  ELEVENLABS_API_KEY: undefined,
  ELEVENLABS_AGENT_ID: "el-agent"
} as AppConfig;

let mongoServer: MongoMemoryServer;
let database: Database;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  database = await connectDatabase({ MONGODB_URI: mongoServer.getUri() } as AppConfig);
}, 60_000);

beforeEach(async () => {
  await Promise.all([
    database.collections.users.deleteMany({}),
    database.collections.agents.deleteMany({}),
    database.collections.phoneNumbers.deleteMany({}),
    database.collections.calls.deleteMany({}),
    database.collections.policies.deleteMany({}),
    database.collections.auditLogs.deleteMany({})
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(async () => {
  await database?.client.close();
  await mongoServer?.stop();
});

describe("phone service outbound calls", () => {
  it("blocks outbound calls when the agent has no active phone number", async () => {
    const { agent } = await insertFixture({ withPhone: false });

    await expect(placeOutboundCall(database.collections, config, {
      agent,
      toNumber: "+33757509222",
      task: "Book an appointment."
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "policy_blocked",
      message: "phone capability not provisioned"
    });
  });

  it("runs mock lifecycle queued to completed with a labeled transcript", async () => {
    vi.useFakeTimers();
    const { agent, phoneNumber } = await insertFixture();

    const result = await placeOutboundCall(database.collections, config, {
      agent,
      toNumber: "(337) 575-0922",
      task: "Book a barber appointment.",
      recipientName: "Barber"
    });

    expect(result).toEqual({
      callId: expect.any(String),
      status: "queued",
      from: phoneNumber.e164,
      to: "+3375750922",
      simulated: true
    });
    await vi.advanceTimersByTimeAsync(2000);
    const completed = await getAgentPhoneCall(database.collections, agent, result.callId);
    expect(completed).toMatchObject({
      direction: "outbound",
      status: "completed",
      counterpartyE164: "+3375750922",
      transcript: [{ role: "agent", message: "[mock] Called +3375750922 about: Book a barber appointment.", timeInCallSecs: 0 }]
    });
    await expect(waitForCallCompletion(database.collections, result.callId, { intervalMs: 1, maxWaitMs: 5 })).resolves.toMatchObject({ status: "completed" });
  });

  it("sends the agent-owned ElevenLabs phone number and dynamic variables", async () => {
    const { agent, phoneNumber } = await insertFixture();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ conversation_id: "conv_test", status: "started" }), { status: 200 })
    );

    const result = await placeOutboundCall(database.collections, {
      ...config,
      PROVIDER_MODE_PHONE: "live",
      ELEVENLABS_API_KEY: "test-key",
      ELEVENLABS_AGENT_ID: "el-agent"
    }, {
      agent,
      toNumber: "+33771594992",
      task: "Book a barber appointment for tomorrow afternoon.",
      recipientName: "Barber shop",
      context: "Ask for the first available haircut slot after 3pm.",
      sourceUrl: "https://example.com/barber"
    });

    expect(result).toMatchObject({ status: "in_progress", from: phoneNumber.e164, to: "+33771594992", simulated: false });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      agent_phone_number_id?: string;
      conversation_initiation_client_data?: { dynamic_variables?: Record<string, string> };
    };
    const variables = requestBody.conversation_initiation_client_data?.dynamic_variables;
    expect(requestBody.agent_phone_number_id).toBe(phoneNumber.elevenLabsPhoneNumberId);
    expect(variables).toMatchObject({
      agent_identity_name: agent.name,
      owner_name: "Maxence",
      agent_role: "recruiting concierge",
      barkan_call_id: result.callId,
      recipient_name: "Barber shop",
      task: "Book a barber appointment for tomorrow afternoon.",
      source_url: "https://example.com/barber"
    });
    expect(variables?.call_opening).toBe(
      "Hi, I'm calling on behalf of Maxence. I'm calling to book a barber appointment for tomorrow afternoon."
    );
    expect(variables?.call_guidance).toContain("Do not repeatedly ask for confirmation");
    expect(variables?.context).toContain("Ask for the first available haircut slot after 3pm.");

    const call = await getAgentPhoneCall(database.collections, agent, result.callId);
    expect(call).toMatchObject({ elevenLabsConversationId: "conv_test", providerCallId: "conv_test", status: "in_progress" });
  });

  it("lists and fetches agent-scoped calls", async () => {
    vi.useFakeTimers();
    const { agent } = await insertFixture();
    const result = await placeOutboundCall(database.collections, config, { agent, toNumber: "+33757509222", task: "Confirm dinner." });

    const list = await listAgentPhoneCalls(database.collections, agent);
    expect(list.calls.map((call) => call._id.toHexString())).toEqual([result.callId]);
    expect(await getAgentPhoneCall(database.collections, agent, result.callId)).toMatchObject({ task: "Confirm dinner." });
  });

  it("keeps natural outbound openings from the previous phone tool", () => {
    expect(buildPersonalAssistantCallBrief({ ownerName: "Maxence", recipientName: "Alex" }, "Call Alex and propose a picnic this Sunday.").firstMessage)
      .toBe("Hi, I'm calling on behalf of Maxence. I'm calling to propose a picnic this Sunday.");
    expect(buildPersonalAssistantCallBrief({ ownerName: "Maxence" }, "Can we move the appointment to tomorrow morning?").firstMessage)
      .toBe("Hi, I'm calling on behalf of Maxence. I'm calling to ask if we can move the appointment to tomorrow morning.");
  });
});

async function insertFixture(input: { withPhone?: boolean } = {}): Promise<{
  user: UserDocument;
  agent: AgentDocument;
  phoneNumber: PhoneNumberDocument;
}> {
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
  await database.collections.policies.insertOne({
    _id: new ObjectId(),
    agentId: agent._id,
    email: defaultEmailPolicy(agent.approvalMode),
    phone: defaultPhonePolicy(),
    createdAt: now,
    updatedAt: now
  });
  if (input.withPhone !== false) {
    await database.collections.phoneNumbers.insertOne(phoneNumber);
  }

  return { user, agent, phoneNumber };
}
