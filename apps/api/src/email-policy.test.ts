import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { connectDatabase, type Database } from "./db.js";

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

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);
  ownerCookie = await signup("email-policy-owner@example.com");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("email policy enforcement", () => {
  it("updates owner email policy and enforces blocked before allowed", async () => {
    const created = await createAgent("Policy Block");
    await putPolicy(created.agent.id, {
      requireApproval: "never",
      allowedRecipients: ["@example.com"],
      blockedRecipients: ["blocked@example.com"],
      dailySendLimit: 50,
      maxRecipientsPerMessage: 5
    });

    const blocked = await sendEmail(created.identityToken.secret, { to: "blocked@example.com" });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().message).toMatch(/blocked/i);

    const disallowed = await sendEmail(created.identityToken.secret, { to: "person@other.com" });
    expect(disallowed.statusCode).toBe(403);
    expect(disallowed.json().message).toMatch(/allowed recipients/i);

    const allowed = await sendEmail(created.identityToken.secret, { to: "person@example.com" });
    expect(allowed.statusCode).toBe(201);
  });

  it("enforces daily cap against sent and delivered only", async () => {
    const created = await createAgent("Daily Cap");
    await putPolicy(created.agent.id, {
      requireApproval: "never",
      allowedRecipients: [],
      blockedRecipients: [],
      dailySendLimit: 1,
      maxRecipientsPerMessage: 5
    });
    const agentId = new ObjectId(created.agent.id);
    await database.collections.emailMessages.insertOne({
      _id: new ObjectId(),
      agentId,
      threadId: new ObjectId(),
      direction: "outbound",
      fromEmail: created.agent.emailAddress,
      toEmail: "old@example.com",
      subject: "Old",
      textBody: "Old",
      status: "failed",
      createdAt: new Date(),
      updatedAt: new Date()
    });
    expect((await sendEmail(created.identityToken.secret, { to: "first@example.com" })).statusCode).toBe(201);

    const capped = await sendEmail(created.identityToken.secret, { to: "second@example.com" });
    expect(capped.statusCode).toBe(403);
    expect(capped.json().message).toMatch(/daily email send limit/i);
    const audit = await database.collections.auditLogs.findOne({ agentId, action: "email.blocked" });
    expect(audit?.detail).toMatch(/daily email send limit/i);
  });

  it("wait-mode approval sends exactly once and returns final message", async () => {
    const created = await createAgent("Wait Approval");
    await putPolicy(created.agent.id, {
      requireApproval: "always",
      allowedRecipients: [],
      blockedRecipients: [],
      dailySendLimit: 50,
      maxRecipientsPerMessage: 5
    });

    const pendingResponse = app.inject({
      method: "POST",
      url: "/api/v1/agent/email/send?wait=3",
      headers: { authorization: `Bearer ${created.identityToken.secret}` },
      payload: { to: "review@example.com", subject: "Needs approval", text: "Please approve" }
    });
    const approval = await waitForPendingApproval(new ObjectId(created.agent.id));
    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approval._id.toHexString()}/approve`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
    });
    expect(approve.statusCode).toBe(200);

    const final = await pendingResponse;
    expect(final.statusCode).toBe(201);
    expect(final.json()).toMatchObject({ ok: true, to: "review@example.com", status: "sent" });
    expect(await database.collections.emailMessages.countDocuments({ agentId: new ObjectId(created.agent.id), toEmail: "review@example.com" })).toBe(1);
  });

  it("wait-mode rejection returns 403 and sends nothing", async () => {
    const created = await createAgent("Reject Approval");
    await putPolicy(created.agent.id, {
      requireApproval: "always",
      allowedRecipients: [],
      blockedRecipients: [],
      dailySendLimit: 50,
      maxRecipientsPerMessage: 5
    });

    const pendingResponse = app.inject({
      method: "POST",
      url: "/api/v1/agent/email/send?wait=3",
      headers: { authorization: `Bearer ${created.identityToken.secret}` },
      payload: { to: "reject@example.com", subject: "Reject me", text: "Please reject" }
    });
    const approval = await waitForPendingApproval(new ObjectId(created.agent.id));
    const reject = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approval._id.toHexString()}/reject`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
    });
    expect(reject.statusCode).toBe(200);

    const final = await pendingResponse;
    expect(final.statusCode).toBe(403);
    expect(await database.collections.emailMessages.countDocuments({ agentId: new ObjectId(created.agent.id), toEmail: "reject@example.com" })).toBe(0);
  });

  it("async approval executes after the agent disconnects", async () => {
    const created = await createAgent("Async Approval");
    await putPolicy(created.agent.id, {
      requireApproval: "always",
      allowedRecipients: [],
      blockedRecipients: [],
      dailySendLimit: 50,
      maxRecipientsPerMessage: 5
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/email/send?mode=async",
      headers: { authorization: `Bearer ${created.identityToken.secret}` },
      payload: { to: "async@example.com", subject: "Async", text: "Send later" }
    });
    expect(response.statusCode).toBe(202);
    const approvalId = response.json().approval_id;

    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/approve`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().approval.executionResult).toMatchObject({ status: "sent", to: "async@example.com" });
    expect(await database.collections.emailMessages.countDocuments({ agentId: new ObjectId(created.agent.id), toEmail: "async@example.com" })).toBe(1);
  });
});

async function signup(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email, password: "password12345" }
  });
  expect(response.statusCode).toBe(200);
  return response.cookies.find((candidate) => candidate.name === config.SESSION_COOKIE_NAME)!.value;
}

async function createAgent(name: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agents",
    cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie },
    payload: { name, capabilities: { email: true }, approvalMode: "policy" }
  });
  expect(response.statusCode).toBe(201);
  return response.json<{
    agent: { id: string; emailAddress: string };
    identityToken: { secret: string };
  }>();
}

async function putPolicy(agentId: string, policy: Record<string, unknown>) {
  const response = await app.inject({
    method: "PUT",
    url: `/api/v1/agents/${agentId}/policies/email`,
    cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie },
    payload: policy
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function sendEmail(token: string, input: { to: string }) {
  return app.inject({
    method: "POST",
    url: "/api/v1/agent/email/send",
    headers: { authorization: `Bearer ${token}` },
    payload: { to: input.to, subject: "Hello", text: "Hello" }
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
