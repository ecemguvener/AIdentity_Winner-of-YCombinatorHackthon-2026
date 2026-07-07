import { ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/api/src/app.js";
import type { AppConfig } from "../../../apps/api/src/config.js";
import { connectDatabase, type Database } from "../../../apps/api/src/db.js";
import { Barkan, BarkanError, ApprovalPendingError } from "./index.js";

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
let apiUrl: string;
let token: string;
let agentId: string;
let ownerUserId: ObjectId;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);
  apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  ({ token, agentId, ownerUserId } = await createFixtureAgent());
}, 60_000);

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("@barkan/sdk", () => {
  it("covers agent email, phone, sms, approvals, and audit helpers", async () => {
    const barkan = new Barkan({ apiUrl, token });
    expect(await barkan.whoami()).toMatchObject({ name: "SDK Bot", email: "sdk-bot@agents.barkan.dev", phone: "+15005550001" });

    const email = await barkan.email.send({ to: "person@example.com", subject: "Hello", text: "Hi" }) as { thread_id: string };
    const threads = await barkan.email.threads.list() as { threads: Array<{ id: string }> };
    expect(threads.threads.map((thread) => thread.id)).toContain(email.thread_id);
    expect(await barkan.email.threads.get(email.thread_id)).toMatchObject({ thread: { id: email.thread_id } });
    expect(await barkan.email.reply(email.thread_id, { text: "Thanks" })).toMatchObject({ thread_id: email.thread_id });

    const call = await barkan.phone.call({ to: "+14155550198", task: "Ask for hours" }) as { call_id: string };
    expect((await barkan.phone.calls.list() as { calls: unknown[] }).calls.length).toBeGreaterThan(0);
    expect(await barkan.phone.calls.get(call.call_id)).toMatchObject({ call: { id: call.call_id } });
    expect(await barkan.phone.waitForCompletion(call.call_id, { timeoutMs: 5000, intervalMs: 50 })).toMatchObject({ call: { status: "completed" } });

    expect(await barkan.sms.send({ to: "+14155550199", body: "Hello" })).toMatchObject({ message: { status: "sent" } });
    expect(await barkan.sms.conversation({ with: "+14155550199" })).toMatchObject({ messages: expect.any(Array) });
    await insertInboundSms("Your code is 246810", "+14155550199");
    expect(await barkan.sms.latestCode({ from: "+14155550199", sinceMinutes: 10 })).toMatchObject({ code: "246810" });

    const approvalId = await insertPendingApproval();
    setTimeout(() => {
      void database.collections.approvals.updateOne({ _id: new ObjectId(approvalId) }, { $set: { status: "approved", updatedAt: new Date() } });
    }, 25);
    expect(await barkan.approvals.waitFor(approvalId, { timeoutMs: 1000, intervalMs: 25 })).toMatchObject({ approval: { status: "approved" } });
    expect(await barkan.audit.recent(10)).toMatchObject({ entries: expect.any(Array) });
  }, 15_000);

  it("maps API errors and approval-pending results", async () => {
    const barkan = new Barkan({ apiUrl, token });
    await expect(barkan.email.threads.get("bad-id")).rejects.toMatchObject({ code: "not_found", status: 404 });

    await database.collections.policies.updateOne({ agentId: new ObjectId(agentId) }, { $set: { "email.requireApproval": "always" } });
    await expect(barkan.email.send({ to: "approval@example.com", subject: "Needs approval", text: "Hi", waitForApproval: false }))
      .rejects.toBeInstanceOf(ApprovalPendingError);
    await database.collections.policies.updateOne({ agentId: new ObjectId(agentId) }, { $set: { "email.requireApproval": "never" } });
  });

  it("retries idempotent GETs but not POSTs", async () => {
    let getCount = 0;
    const retryClient = new Barkan({
      apiUrl: "https://sdk.test",
      token: "token",
      fetch: async () => {
        getCount += 1;
        return new Response(JSON.stringify({ ok: true }), { status: getCount === 1 ? 500 : 200, headers: { "content-type": "application/json" } });
      }
    });
    await expect(retryClient.whoami()).resolves.toEqual({ ok: true });
    expect(getCount).toBe(2);

    let postCount = 0;
    const noRetryClient = new Barkan({
      apiUrl: "https://sdk.test",
      token: "token",
      fetch: async () => {
        postCount += 1;
        return new Response(JSON.stringify({ error: { code: "internal", message: "down", requestId: "r1" } }), { status: 500, headers: { "content-type": "application/json" } });
      }
    });
    await expect(noRetryClient.email.send({ to: "a@example.com", subject: "x", text: "x" })).rejects.toBeInstanceOf(BarkanError);
    expect(postCount).toBe(1);
  });
});

async function createFixtureAgent(): Promise<{ token: string; agentId: string; ownerUserId: ObjectId }> {
  const signup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "sdk-owner@example.com", password: "password12345" }
  });
  const cookie = signup.cookies.find((candidate) => candidate.name === config.SESSION_COOKIE_NAME)!;
  const user = await database.collections.users.findOne({ email: "sdk-owner@example.com" });
  ownerUserId = user!._id;
  await database.collections.billingAccounts.updateOne({ ownerUserId }, { $set: { plan: "scale", updatedAt: new Date() } });

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/agents",
    cookies: { [config.SESSION_COOKIE_NAME]: cookie.value },
    payload: { name: "SDK Bot", capabilities: { email: true, phone: false }, approvalMode: "autonomous" }
  });
  const body = created.json();
  agentId = body.agent.id;
  await database.collections.policies.updateOne(
    { agentId: new ObjectId(agentId) },
    { $set: { "email.requireApproval": "never", "phone.requireApprovalOutboundCall": "never", "phone.requireApprovalSms": "never" } }
  );
  await database.collections.agents.updateOne({ _id: new ObjectId(agentId) }, { $set: { "capabilities.phone": true } });
  await database.collections.phoneNumbers.insertOne({
    _id: new ObjectId(),
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
  return { token: body.identityToken.secret, agentId, ownerUserId };
}

async function insertInboundSms(body: string, from: string): Promise<void> {
  const phoneNumber = await database.collections.phoneNumbers.findOne({ agentId: new ObjectId(agentId) });
  await database.collections.smsMessages.insertOne({
    _id: new ObjectId(),
    agentId: new ObjectId(agentId),
    phoneNumberId: phoneNumber!._id,
    direction: "inbound",
    counterpartyE164: from,
    body,
    status: "received",
    createdAt: new Date(),
    updatedAt: new Date()
  });
}

async function insertPendingApproval(): Promise<string> {
  const approvalId = new ObjectId();
  await database.collections.approvals.insertOne({
    _id: approvalId,
    agentId: new ObjectId(agentId),
    ownerUserId,
    kind: "email.send",
    status: "pending",
    payloadSummary: "SDK approval",
    payload: {},
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date()
  });
  return approvalId.toHexString();
}
