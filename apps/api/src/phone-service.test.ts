import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.js";
import { connectDatabase, type AgentDocument, type Database, type PhoneNumberDocument, type UserDocument } from "./db.js";
import { defaultEmailPolicy, defaultPhonePolicy } from "./policies.js";
import { buildPersonalAssistantCallBrief, getAgentPhoneCall, listAgentPhoneCalls, placeOutboundCall } from "./phone-service.js";

const config = {
  PROVIDER_MODE_PHONE: "mock",
  ELEVENLABS_API_KEY: undefined,
  ELEVENLABS_AGENT_ID: "el-agent"
} as AppConfig;

let mongoServer: MongoMemoryServer;
let database: Database;
let phoneNumberSequence = 0;

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
  it("validates outbound call input before queueing", async () => {
    const { agent } = await insertFixture();

    await expect(placeOutboundCall(database.collections, config, {
      agent,
      toNumber: "not-a-number",
      task: "Book an appointment."
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "validation_failed",
      message: "The phone number must be an E.164-style number, for example +14155550198."
    });
    await expect(placeOutboundCall(database.collections, config, {
      agent,
      toNumber: "+33757509222",
      task: "  "
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "validation_failed",
      message: "The call task cannot be empty."
    });
    expect(await database.collections.calls.countDocuments()).toBe(0);
  });

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
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const completed = await getAgentPhoneCall(database.collections, agent, result.callId);
    expect(completed).toMatchObject({
      direction: "outbound",
      status: "completed",
      counterpartyE164: "+3375750922",
      transcript: [{ role: "agent", message: "[mock] Called +3375750922 about: Book a barber appointment.", timeInCallSecs: 0 }]
    });
  });

  it("blocks approval-gated calls when the agent has no owner", async () => {
    const { agent } = await insertFixture({ withoutOwner: true });
    await database.collections.policies.updateOne(
      { agentId: agent._id },
      { $set: { "phone.requireApprovalOutboundCall": "always", updatedAt: new Date() } }
    );

    await expect(placeOutboundCall(database.collections, config, {
      agent,
      toNumber: "+33757509222",
      task: "Book an appointment."
    })).rejects.toMatchObject({
      statusCode: 403,
      code: "policy_blocked",
      message: "phone call approval requires an owner user"
    });
    expect(await database.collections.auditLogs.findOne({ action: "phone.blocked" })).toMatchObject({ status: "blocked" });
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

  it("maps live provider call statuses", async () => {
    const cases = [
      ["completed", "completed"],
      ["error", "failed"],
      ["no-answer", "no_answer"],
      ["queued", "ringing"]
    ] as const;

    for (const [providerStatus, expectedStatus] of cases) {
      const { agent } = await insertFixture();
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ status: providerStatus }), { status: 200 })
      );
      const result = await placeOutboundCall(database.collections, {
        ...config,
        PROVIDER_MODE_PHONE: "live",
        ELEVENLABS_API_KEY: "test-key",
        ELEVENLABS_AGENT_ID: "el-agent"
      }, {
        agent,
        toNumber: "+33771594992",
        task: `Check status ${providerStatus}.`
      });

      expect(result.status).toBe(expectedStatus);
    }
  });

  it("marks live calls failed when ElevenLabs rejects the request", async () => {
    const { agent } = await insertFixture();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "provider down" }), { status: 502 })
    );

    await expect(placeOutboundCall(database.collections, {
      ...config,
      PROVIDER_MODE_PHONE: "live",
      ELEVENLABS_API_KEY: "test-key",
      ELEVENLABS_AGENT_ID: "el-agent"
    }, {
      agent,
      toNumber: "+33771594992",
      task: "Book a barber appointment."
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "provider_error",
      message: "provider down"
    });

    expect(await database.collections.calls.findOne({ agentId: agent._id })).toMatchObject({ status: "failed" });
  });

  it("uses fallback provider error text when the response is not JSON", async () => {
    const { agent } = await insertFixture();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("plain provider failure", { status: 500 })
    );

    await expect(placeOutboundCall(database.collections, {
      ...config,
      PROVIDER_MODE_PHONE: "live",
      ELEVENLABS_API_KEY: "test-key",
      ELEVENLABS_AGENT_ID: "el-agent"
    }, {
      agent,
      toNumber: "+33771594992",
      task: "Book a barber appointment."
    })).rejects.toMatchObject({ message: "plain provider failure" });
  });

  it("lists and fetches agent-scoped calls", async () => {
    const { agent } = await insertFixture();
    const result = await placeOutboundCall(database.collections, config, { agent, toNumber: "+33757509222", task: "Confirm dinner." });

    const list = await listAgentPhoneCalls(database.collections, agent);
    expect(list.calls.map((call) => call._id.toHexString())).toEqual([result.callId]);
    expect(await getAgentPhoneCall(database.collections, agent, result.callId)).toMatchObject({ task: "Confirm dinner." });
  });

  it("paginates calls and rejects missing call ids", async () => {
    const { agent } = await insertFixture();
    const first = await placeOutboundCall(database.collections, config, { agent, toNumber: "+33757509222", task: "First call." });
    await placeOutboundCall(database.collections, config, { agent, toNumber: "+33757509223", task: "Second call." });

    const page = await listAgentPhoneCalls(database.collections, agent, null, 1);
    expect(page.calls).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const nextPage = await listAgentPhoneCalls(database.collections, agent, page.nextCursor, 1);
    expect(nextPage.calls.map((call) => call._id.toHexString())).toEqual([first.callId]);
    await expect(getAgentPhoneCall(database.collections, agent, "not-an-id")).rejects.toMatchObject({ statusCode: 404 });
    await expect(getAgentPhoneCall(database.collections, agent, new ObjectId().toHexString())).rejects.toMatchObject({ statusCode: 404 });
  });

  it("keeps natural outbound openings from the previous phone tool", () => {
    expect(buildPersonalAssistantCallBrief({ ownerName: "Maxence" }, "i'm calling to confirm the booking.").firstMessage)
      .toBe("Hi, I'm calling on behalf of Maxence. I'm calling to confirm the booking.");
    expect(buildPersonalAssistantCallBrief({ ownerName: "Maxence", recipientName: "Alex" }, "Call Alex and propose a picnic this Sunday.").firstMessage)
      .toBe("Hi, I'm calling on behalf of Maxence. I'm calling to propose a picnic this Sunday.");
    expect(buildPersonalAssistantCallBrief({ ownerName: "Maxence", recipientName: "Alex" }, "Call Alex").firstMessage)
      .toBe("Hi, I'm calling on behalf of Maxence. I'm calling about speak with Alex about the user's request.");
    expect(buildPersonalAssistantCallBrief({ ownerName: "Maxence" }, "Can we move the appointment to tomorrow morning?").firstMessage)
      .toBe("Hi, I'm calling on behalf of Maxence. I'm calling to ask if we can move the appointment to tomorrow morning.");
    expect(buildPersonalAssistantCallBrief({ ownerName: "Maxence" }, "Is Alex available?").firstMessage)
      .toBe("Hi, I'm calling on behalf of Maxence. I'm calling to ask if alex is available.");
    expect(buildPersonalAssistantCallBrief({ ownerName: "Maxence" }, "Do you have tables tonight?").firstMessage)
      .toBe("Hi, I'm calling on behalf of Maxence. I'm calling to ask if you have tables tonight.");
    expect(buildPersonalAssistantCallBrief({ ownerName: "Maxence" }, "Does Alex have availability?").firstMessage)
      .toBe("Hi, I'm calling on behalf of Maxence. I'm calling to ask if alex has availability.");
    expect(buildPersonalAssistantCallBrief({ ownerName: "Maxence" }, "Why now?").firstMessage)
      .toBe("Hi, I'm calling on behalf of Maxence. I'm calling about why now.");
    expect(buildPersonalAssistantCallBrief({ ownerName: "Maxence" }, "Can?").firstMessage)
      .toBe("Hi, I'm calling on behalf of Maxence. I'm calling to ask if can.");
    expect(buildPersonalAssistantCallBrief({ ownerName: "Maxence" }, "Can? Alex arrive?").firstMessage)
      .toBe("Hi, I'm calling on behalf of Maxence. I'm calling to ask if can? Alex arrive.");
  });
});

async function insertFixture(input: { withPhone?: boolean; withoutOwner?: boolean } = {}): Promise<{
  user: UserDocument;
  agent: AgentDocument;
  phoneNumber: PhoneNumberDocument;
}> {
  const now = new Date();
  const phoneNumberE164 = `+1500555${String(++phoneNumberSequence).padStart(4, "0")}`;
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
    ownerUserId: input.withoutOwner ? null : user._id,
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
    e164: phoneNumberE164,
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
    phone: { ...defaultPhonePolicy(), requireApprovalOutboundCall: "never" },
    createdAt: now,
    updatedAt: now
  });
  if (input.withPhone !== false) {
    await database.collections.phoneNumbers.insertOne(phoneNumber);
  }

  return { user, agent, phoneNumber };
}
