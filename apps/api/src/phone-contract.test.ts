import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { issueIdentityToken } from "./agent-auth.js";
import type { AppConfig } from "./config.js";
import { connectDatabase, type AgentDocument, type Database, type PhonePolicy, type UserDocument } from "./db.js";
import { defaultEmailPolicy, defaultPhonePolicy } from "./policies.js";
import { createSessionExpiry, hashSessionToken } from "./security.js";

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
let ownerUser: UserDocument;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);
}, 60_000);

beforeEach(async () => {
  await Promise.all(Object.values(database.collections).map((collection) => collection.deleteMany({})));
  ownerCookie = `session-${Math.random().toString(36).slice(2)}`;
  ownerUser = {
    _id: new ObjectId(),
    email: "owner@example.com",
    displayName: "Owner",
    passwordHash: "unused",
    createdAt: new Date(),
    updatedAt: new Date()
  };
  await database.collections.users.insertOne(ownerUser);
  await database.collections.sessions.insertOne({
    _id: new ObjectId(),
    userId: ownerUser._id,
    tokenHash: hashSessionToken(ownerCookie, config.SESSION_SECRET),
    expiresAt: createSessionExpiry(),
    createdAt: new Date()
  });
});

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("phone bearer contract", () => {
  it("GET /phone/number returns the active number shape", async () => {
    const fixture = await createFixture();
    const response = await agentGet(fixture.token, "/api/v1/agent/phone/number");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ e164: "+15005550001", country: "US", capabilities: { voice: true, sms: true }, status: "active" });
  });

  it("GET /phone/number returns 409 without a number", async () => {
    const fixture = await createFixture({ withNumber: false });
    expect((await agentGet(fixture.token, "/api/v1/agent/phone/number")).statusCode).toBe(409);
  });

  it("revoked tokens cannot access phone routes", async () => {
    const fixture = await createFixture();
    await database.collections.identityTokens.updateMany({ agentId: fixture.agent._id }, { $set: { status: "revoked" } });
    expect((await agentGet(fixture.token, "/api/v1/agent/phone/number")).statusCode).toBe(401);
  });

  it("places a mock outbound call and returns stable response shape", async () => {
    const fixture = await createFixture();
    const response = await agentPost(fixture.token, "/api/v1/agent/phone/call", { to: "+33612345678", task: "Confirm booking" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ call_id: expect.any(String), status: "queued", from: "+15005550001", to: "+33612345678" });
  });

  it("mock call completion is deterministic after 2 seconds", async () => {
    const fixture = await createFixture();
    const response = await agentPost(fixture.token, "/api/v1/agent/phone/call", { to: "+33612345678", task: "Confirm booking" });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const call = await database.collections.calls.findOne({ _id: new ObjectId(response.json().call_id) });
    expect(call).toMatchObject({ status: "completed", durationSecs: 0 });
  });

  it("lists and retrieves calls with transcript fields", async () => {
    const fixture = await createFixture();
    const callId = await insertCompletedCall(fixture.agent._id, fixture.phoneNumberId);
    const list = await agentGet(fixture.token, "/api/v1/agent/phone/calls");
    expect(list.json().calls[0]).toMatchObject({ id: callId, summary: "Done", transcript: [{ role: "agent", message: "Hello", timeInCallSecs: 0 }] });
    const detail = await agentGet(fixture.token, `/api/v1/agent/phone/calls/${callId}`);
    expect(detail.json().call).toMatchObject({ id: callId, duration_secs: 42, cost_cents: 15 });
  });

  it("paginates calls using cursor", async () => {
    const fixture = await createFixture();
    await insertCompletedCall(fixture.agent._id, fixture.phoneNumberId, "+33600000001");
    const second = await insertCompletedCall(fixture.agent._id, fixture.phoneNumberId, "+33600000002");
    const firstPage = await agentGet(fixture.token, "/api/v1/agent/phone/calls");
    const secondPage = await agentGet(fixture.token, `/api/v1/agent/phone/calls?cursor=${second}`);
    expect(firstPage.json().calls.length).toBeGreaterThan(0);
    expect(secondPage.statusCode).toBe(200);
  });

  it.each([
    ["bad number", { to: "not-phone", task: "Do it" }, 400],
    ["empty task", { to: "+33612345678", task: "" }, 400]
  ])("rejects invalid call payload: %s", async (_label, payload, status) => {
    const fixture = await createFixture();
    expect((await agentPost(fixture.token, "/api/v1/agent/phone/call", payload)).statusCode).toBe(status);
  });

  it("returns 409 when calling without a number", async () => {
    const fixture = await createFixture({ withNumber: false });
    expect((await agentPost(fixture.token, "/api/v1/agent/phone/call", { to: "+33612345678", task: "Call" })).statusCode).toBe(409);
  });

  it.each([
    ["country", { allowedCountries: ["FR"] }, "+14155550123", /country US not allowed/],
    ["unknown country", { allowedCountries: ["FR"] }, "+9991234", /unknown country/],
    ["daily cap", { dailyCallLimit: 0 }, "+33612345678", /daily call limit/],
    ["quiet hours", { quietHours: { start: "00:00", end: "23:59", timezone: "UTC" } }, "+33612345678", /quiet hours/]
  ])("blocks call policy branch: %s", async (_label, patch, to, message) => {
    const fixture = await createFixture({ phonePolicy: { requireApprovalOutboundCall: "never", ...patch } });
    const response = await agentPost(fixture.token, "/api/v1/agent/phone/call", { to, task: "Call" });
    expect(response.statusCode).toBe(403);
    expect(response.json().message).toMatch(message);
  });

  it("returns async approval for gated calls", async () => {
    const fixture = await createFixture({ phonePolicy: { requireApprovalOutboundCall: "always" } });
    const response = await agentPost(fixture.token, "/api/v1/agent/phone/call?mode=async", { to: "+33612345678", task: "Call" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "approval_required", decision: "pending", approval_id: expect.any(String) });
  });

  it("wait-mode call approval dials exactly once", async () => {
    const fixture = await createFixture({ phonePolicy: { requireApprovalOutboundCall: "always" } });
    const pending = agentPost(fixture.token, "/api/v1/agent/phone/call?wait=3", { to: "+33612345678", task: "Call" });
    const approval = await waitForPendingApproval(fixture.agent._id);
    await approve(approval._id);
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(await database.collections.calls.countDocuments({ agentId: fixture.agent._id, counterpartyE164: "+33612345678" })).toBe(1);
  });

  it("wait-mode call rejection returns 403 and dials nothing", async () => {
    const fixture = await createFixture({ phonePolicy: { requireApprovalOutboundCall: "always" } });
    const pending = agentPost(fixture.token, "/api/v1/agent/phone/call?wait=3", { to: "+33612345678", task: "Call" });
    const approval = await waitForPendingApproval(fixture.agent._id);
    await reject(approval._id);
    const response = await pending;
    expect(response.statusCode).toBe(403);
    expect(await database.collections.calls.countDocuments({ agentId: fixture.agent._id })).toBe(0);
  });

  it("sends SMS and replays idempotency", async () => {
    const fixture = await createFixture();
    const payload = { to: "+33612345678", body: "Hello", idempotencyKey: "sms-1" };
    const first = await agentPost(fixture.token, "/api/v1/agent/phone/sms", payload);
    const second = await agentPost(fixture.token, "/api/v1/agent/phone/sms", payload);
    expect(first.statusCode).toBe(200);
    expect(second.json().message.id).toBe(first.json().message.id);
    expect(await database.collections.smsMessages.countDocuments({ agentId: fixture.agent._id })).toBe(1);
  });

  it("lists SMS thread in chronological order", async () => {
    const fixture = await createFixture();
    await insertInboundSms(fixture.agent._id, fixture.phoneNumberId, "+33612345678", "first", new Date("2026-07-07T10:00:00Z"));
    await agentPost(fixture.token, "/api/v1/agent/phone/sms", { to: "+33612345678", body: "second" });
    const response = await agentGet(fixture.token, "/api/v1/agent/phone/sms?with=%2B33612345678");
    expect(response.json().messages.map((message: { body: string }) => message.body)).toEqual(["first", "second"]);
  });

  it("paginates SMS thread with cursor", async () => {
    const fixture = await createFixture();
    const oldId = await insertInboundSms(fixture.agent._id, fixture.phoneNumberId, "+33612345678", "old", new Date("2026-07-07T10:00:00Z"));
    await insertInboundSms(fixture.agent._id, fixture.phoneNumberId, "+33612345678", "new", new Date("2026-07-07T10:01:00Z"));
    const page = await agentGet(fixture.token, `/api/v1/agent/phone/sms?with=%2B33612345678&cursor=${oldId}`);
    expect(page.statusCode).toBe(200);
  });

  it.each([
    ["four", "Code 1234", "1234"],
    ["five", "Code 12345", "12345"],
    ["six newest", "Code 482913", "482913"],
    ["eight", "Code 12345678", "12345678"]
  ])("extracts latest SMS code: %s", async (_label, body, code) => {
    const fixture = await createFixture();
    await insertInboundSms(fixture.agent._id, fixture.phoneNumberId, "+33612345678", body, new Date("2026-07-07T10:02:00Z"));
    const response = await agentGet(fixture.token, "/api/v1/agent/phone/sms/latest-code?from=%2B33612345678&since=2026-07-07T10%3A00%3A00.000Z");
    expect(response.statusCode).toBe(200);
    expect(response.json().code).toBe(code);
  });

  it("latest-code returns newest match and 404 when none exists", async () => {
    const fixture = await createFixture();
    await insertInboundSms(fixture.agent._id, fixture.phoneNumberId, "+33612345678", "Code 111111", new Date("2026-07-07T10:01:00Z"));
    await insertInboundSms(fixture.agent._id, fixture.phoneNumberId, "+33612345678", "Use 222222", new Date("2026-07-07T10:02:00Z"));
    expect((await agentGet(fixture.token, "/api/v1/agent/phone/sms/latest-code")).json().code).toBe("222222");
    const empty = await agentGet(fixture.token, "/api/v1/agent/phone/sms/latest-code?from=%2B15550000000");
    expect(empty.statusCode).toBe(404);
  });

  it.each([
    ["country", { allowedCountries: ["FR"] }, "+14155550123", /country US not allowed/],
    ["daily cap", { dailySmsLimit: 0 }, "+33612345678", /daily SMS limit/]
  ])("blocks SMS policy branch: %s", async (_label, patch, to, message) => {
    const fixture = await createFixture({ phonePolicy: { requireApprovalSms: "never", ...patch } });
    const response = await agentPost(fixture.token, "/api/v1/agent/phone/sms", { to, body: "Hello" });
    expect(response.statusCode).toBe(403);
    expect(response.json().message).toMatch(message);
  });

  it("returns async approval for gated SMS", async () => {
    const fixture = await createFixture({ phonePolicy: { requireApprovalSms: "always" } });
    const response = await agentPost(fixture.token, "/api/v1/agent/phone/sms?mode=async", { to: "+33612345678", body: "Hello" });
    expect(response.json()).toMatchObject({ status: "approval_required", decision: "pending" });
  });

  it("wait-mode SMS approval sends once", async () => {
    const fixture = await createFixture({ phonePolicy: { requireApprovalSms: "always" } });
    const pending = agentPost(fixture.token, "/api/v1/agent/phone/sms?wait=3", { to: "+33612345678", body: "Hello" });
    const approval = await waitForPendingApproval(fixture.agent._id);
    await approve(approval._id);
    expect((await pending).statusCode).toBe(200);
    expect(await database.collections.smsMessages.countDocuments({ agentId: fixture.agent._id })).toBe(1);
  });

  it("wait-mode SMS rejection returns 403 and sends nothing", async () => {
    const fixture = await createFixture({ phonePolicy: { requireApprovalSms: "always" } });
    const pending = agentPost(fixture.token, "/api/v1/agent/phone/sms?wait=3", { to: "+33612345678", body: "Hello" });
    const approval = await waitForPendingApproval(fixture.agent._id);
    await reject(approval._id);
    expect((await pending).statusCode).toBe(403);
    expect(await database.collections.smsMessages.countDocuments({ agentId: fixture.agent._id })).toBe(0);
  });
});

async function createFixture(input: { withNumber?: boolean; phonePolicy?: Partial<PhonePolicy> } = {}) {
  const now = new Date("2026-07-07T12:00:00Z");
  const agent: AgentDocument = {
    _id: new ObjectId(),
    ownerUserId: ownerUser._id,
    name: "Maya",
    slug: `maya-${Math.random().toString(36).slice(2)}`,
    status: "active",
    capabilities: { email: false, phone: true },
    approvalMode: "policy",
    createdAt: now,
    updatedAt: now
  };
  const phoneNumberId = new ObjectId();
  await database.collections.agents.insertOne(agent);
  await database.collections.policies.insertOne({
    _id: new ObjectId(),
    agentId: agent._id,
    email: defaultEmailPolicy(agent.approvalMode),
    phone: { ...defaultPhonePolicy(), requireApprovalOutboundCall: "never", requireApprovalSms: "never", ...(input.phonePolicy ?? {}) },
    createdAt: now,
    updatedAt: now
  });
  if (input.withNumber !== false) {
    await database.collections.phoneNumbers.insertOne({
      _id: phoneNumberId,
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
    });
  }
  const { plaintext } = await issueIdentityToken(database.collections, agent._id, "default", { mode: "test" });
  return { agent, token: plaintext, phoneNumberId };
}

function agentGet(token: string, url: string) {
  return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
}

function agentPost(token: string, url: string, payload: unknown) {
  return app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });
}

async function approve(approvalId: ObjectId) {
  return app.inject({ method: "POST", url: `/api/v1/approvals/${approvalId.toHexString()}/approve`, cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie } });
}

async function reject(approvalId: ObjectId) {
  return app.inject({ method: "POST", url: `/api/v1/approvals/${approvalId.toHexString()}/reject`, cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie } });
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

async function insertCompletedCall(agentId: ObjectId, phoneNumberId: ObjectId, counterpartyE164 = "+33612345678") {
  const _id = new ObjectId();
  await database.collections.calls.insertOne({
    _id,
    agentId,
    phoneNumberId,
    direction: "outbound",
    counterpartyE164,
    task: "Task",
    status: "completed",
    durationSecs: 42,
    transcript: [{ role: "agent", message: "Hello", timeInCallSecs: 0 }],
    summary: "Done",
    costCents: 15,
    createdAt: new Date(),
    updatedAt: new Date()
  });
  return _id.toHexString();
}

async function insertInboundSms(agentId: ObjectId, phoneNumberId: ObjectId, from: string, body: string, createdAt: Date) {
  const _id = new ObjectId();
  await database.collections.smsMessages.insertOne({
    _id,
    agentId,
    phoneNumberId,
    direction: "inbound",
    counterpartyE164: from,
    body,
    twilioMessageSid: `SM${Math.random().toString(36).slice(2)}`,
    status: "received",
    createdAt,
    updatedAt: createdAt
  });
  return _id.toHexString();
}
