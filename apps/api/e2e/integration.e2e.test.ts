import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AUDIT_ACTIONS } from "../src/audit.js";
import type { AppConfig } from "../src/config.js";
import type { AgentDocument, Database } from "../src/db.js";
import { connectDatabase } from "../src/db.js";
import { setStripeClientForTest, Stripe } from "../src/providers/stripe-client.js";
import { reportUsageToStripe } from "../src/usage.js";
import { ApprovalPendingError, Barkan } from "../../../packages/sdk/src/index.js";

type App = Awaited<ReturnType<typeof buildApp>>;
type ScenarioResult = { name: string; steps: number; durationMs: number; status: "pass" | "fail" };
type ScenarioState = {
  owner: { email: string; cookie: string; userId: ObjectId };
  agent: AgentDocument;
  token: string;
  api: Barkan;
};

const mode = process.env.E2E_MODE ?? "mock";
const stripeWebhookSecret = "whsec_test";
const config = {
  NODE_ENV: "test",
  API_PORT: 0,
  PUBLIC_APP_URL: "http://localhost:4888",
  PUBLIC_API_URL: "http://127.0.0.1:0",
  MONGODB_URI: "set-by-beforeAll",
  SESSION_COOKIE_NAME: "barkan_session",
  SESSION_SECRET: "test-barkan-session-secret",
  PROVIDER_MODE_EMAIL: mode === "live" ? "live" : "mock",
  PROVIDER_MODE_PHONE: mode === "live" ? "live" : "mock",
  STRIPE_SECRET_KEY: "sk_test_e2e",
  STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
  BILLING_PRICE_PRO: "price_pro",
  BILLING_PRICE_SCALE: "price_scale",
  BILLING_PRICE_OVERAGE_EMAILS: "price_email_overage",
  BILLING_PRICE_OVERAGE_CALL_MINUTES: "price_call_overage",
  BILLING_PRICE_OVERAGE_SMS: "price_sms_overage",
  BILLING_PRICE_OVERAGE_ACTIVE_NUMBERS: "price_number_overage",
  TWILIO_NUMBER_COUNTRY: "US",
  ELEVENLABS_VOICE_ID: "voice",
  CALL_COST_CENTS_PER_MINUTE: 15,
  OPENAI_DASHBOARD_CHAT_MODEL: "gpt-5.4-2026-03-05",
  EMAIL_AGENT_DOMAIN: "agents.barkan.dev",
  EMAIL_PLATFORM_FROM: "Barkan <no-reply@barkan.dev>",
  API_RATE_LIMIT_MAX: 1000
} as unknown as AppConfig;

let replSet: MongoMemoryReplSet;
let database: Database;
let app: App;
let baseUrl: string;
let state: ScenarioState;
const scenarioReport: ScenarioResult[] = [];

beforeAll(async () => {
  if (mode === "live") {
    throw new Error("E2E_MODE=live is a staging drill documented in docs/testing/integration-e2e.md; this Vitest harness is mock-only.");
  }
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  (config as { MONGODB_URI: string }).MONGODB_URI = replSet.getUri("barkan-e2e");
  setStripeClientForTest({
    customers: { create: async () => ({ id: "cus_e2e" }) },
    checkout: { sessions: { create: async () => ({ url: "https://billing.example.test/checkout" }) } },
    billingPortal: { sessions: { create: async () => ({ url: "https://billing.example.test/portal" }) } },
    billing: { meterEvents: { create: async () => ({}) } }
  } as unknown as Stripe);
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  (config as { PUBLIC_API_URL: string }).PUBLIC_API_URL = baseUrl;
}, 90_000);

afterAll(async () => {
  printReport();
  setStripeClientForTest(null);
  await app?.close();
  await database?.client.close();
  await replSet?.stop();
});

describe("integration e2e harness", () => {
  it("owner lifecycle", () => scenario("owner lifecycle", async (step) => {
    const owner = await signupOwner(step);
    await seedProPlan(owner.userId);
    const created = await ownerFetch<{
      agent: { id: string; capabilities: { email: boolean; phone: boolean }; emailAddress: string; phoneE164: string };
      identityToken: { secret: string };
    }>(owner.cookie, "/api/v1/agents", {
      method: "POST",
      body: {
        name: "Golden Agent",
        runtime: "openclaw",
        capabilities: { email: true, phone: true },
        approvalMode: "always"
      }
    }, step);

    expect(created.agent.capabilities).toEqual({ email: true, phone: true });
    expect(created.agent.emailAddress).toMatch(/@agents\.barkan\.dev$/);
    expect(created.agent.phoneE164).toBe("+15005550001");
    const agent = await loadAgent(created.agent.id);
    const api = new Barkan({ apiUrl: baseUrl, token: created.identityToken.secret });
    const whoami = await api.whoami() as { agent_id: string; email: string; phone: string };
    expect(whoami).toMatchObject({ agent_id: created.agent.id, email: created.agent.emailAddress, phone: created.agent.phoneE164 });
    state = { owner, agent, token: created.identityToken.secret, api };
  }));

  it("email loop", () => scenario("email loop", async (step) => {
    const start = await auditCount();
    const approvalId = await expectApproval(() =>
      state.api.email.send({ to: "casey@example.com", subject: "Launch check", text: "Can you confirm?", waitForApproval: false })
    );
    await approve(approvalId, step);
    const outbound = await firstEmail("outbound", "casey@example.com");
    await deliverInboundEmail({
      from: "casey@example.com",
      to: await agentEmailAddress(),
      subject: "Re: Launch check",
      text: "Confirmed. Ship it.",
      inReplyTo: outbound.headers?.["message-id"]
    }, step);
    const thread = await state.api.email.threads.get(outbound.threadId.toHexString()) as { messages: unknown[] };
    expect(thread.messages).toHaveLength(2);

    const replyApprovalId = await expectApproval(() =>
      state.api.email.reply(outbound.threadId.toHexString(), { text: "Thanks, proceeding now.", waitForApproval: false })
    );
    await approve(replyApprovalId, step);
    expect(await auditActionsAfter(start)).toEqual([
      AUDIT_ACTIONS.approval.requested,
      AUDIT_ACTIONS.email.send,
      AUDIT_ACTIONS.approval.approved,
      AUDIT_ACTIONS.email.receive,
      AUDIT_ACTIONS.approval.requested,
      AUDIT_ACTIONS.email.send,
      AUDIT_ACTIONS.approval.approved
    ]);
    await assertInvariants(step);
  }));

  it("phone loop", () => scenario("phone loop", async (step) => {
    const approvalId = await expectApproval(() =>
      state.api.phone.call({ to: "+14155550198", task: "Ask whether the office is open", waitForApproval: false })
    );
    await approve(approvalId, step);
    const call = await database.collections.calls.findOne({ agentId: state.agent._id, direction: "outbound" }, { sort: { createdAt: -1 } });
    expect(call).toBeTruthy();
    await deliverElevenLabsPostCall(call!._id.toHexString(), "conv_e2e_outbound", step);
    const completed = await state.api.phone.waitForCompletion(call!._id.toHexString(), { timeoutMs: 10_000, intervalMs: 100 }) as {
      call: { status: string; summary: string };
    };
    expect(completed.call).toMatchObject({ status: "completed", summary: "Office confirmed it is open until 5pm." });
    const inboundCallId = await deliverPersonalization(step);
    expect(await database.collections.calls.findOne({ _id: new ObjectId(inboundCallId), direction: "inbound", providerCallId: "CAe2eInbound" })).toBeTruthy();
    await assertInvariants(step);
  }));

  it("sms 2FA", () => scenario("sms 2FA", async (step) => {
    await postForm("/webhooks/twilio/sms", {
      To: await agentPhoneNumber(),
      From: "+14155550111",
      Body: "Your code is 492813.",
      MessageSid: "SMe2e2fa"
    }, step);
    const latest = await state.api.sms.latestCode({ from: "+14155550111", sinceMinutes: 10 }) as { code: string };
    expect(latest.code).toBe("492813");
    await assertInvariants(step);
  }));

  it("billing loop", () => scenario("billing loop", async (step) => {
    await database.collections.billingAccounts.updateOne(
      { ownerUserId: state.owner.userId },
      { $set: { plan: "free", stripeCustomerId: "cus_e2e", updatedAt: new Date() }, $unset: { subscriptionId: "", subscriptionStatus: "", currentPeriodEnd: "", lastStripeEventCreated: "" } }
    );
    await deliverStripeEvent({
      id: "evt_checkout_completed",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "cs_test", customer: "cus_e2e", metadata: { barkanUserId: state.owner.userId.toHexString(), plan: "pro" } } }
    }, step);
    await deliverStripeEvent({
      id: "evt_subscription_created",
      type: "customer.subscription.created",
      created: Math.floor(Date.now() / 1000) + 1,
      data: {
        object: {
          id: "sub_e2e",
          customer: "cus_e2e",
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          items: { data: [{ price: { lookup_key: "barkan_pro_monthly" } }] }
        }
      }
    }, step);
    const account = await database.collections.billingAccounts.findOne({ ownerUserId: state.owner.userId });
    expect(account).toMatchObject({ plan: "pro", subscriptionStatus: "active" });
    await database.collections.usageEvents.insertOne({
      _id: new ObjectId(),
      ownerUserId: state.owner.userId,
      agentId: state.agent._id,
      meter: "emails_sent",
      quantity: 501,
      stripeReported: false,
      periodKey: account!.currentPeriodEnd!.toISOString().slice(0, 7),
      createdAt: new Date(),
      updatedAt: new Date()
    });
    const usageCounts = await usageCountsByMeter();
    expect(usageCounts.emails_sent).toBeGreaterThanOrEqual(503);
    expect(usageCounts.call_minutes).toBe(1);
    const dryRun = await reportUsageToStripe(database.collections, config, { dryRun: true });
    expect(dryRun).toEqual(expect.arrayContaining([expect.objectContaining({ meter: "emails_sent", delta: 1 })]));
    await assertInvariants(step);
  }));

  it("safety", () => scenario("safety", async (step) => {
    await database.collections.policies.updateOne({ agentId: state.agent._id }, { $set: { "email.blockedRecipients": ["blocked@example.com"], updatedAt: new Date() } });
    await expect(state.api.email.send({ to: "blocked@example.com", subject: "No", text: "No", waitForApproval: false }))
      .rejects.toMatchObject({ status: 403, code: "policy_blocked" });

    await database.collections.usageEvents.insertOne({
      _id: new ObjectId(),
      ownerUserId: state.owner.userId,
      agentId: state.agent._id,
      meter: "emails_sent",
      quantity: 100,
      stripeReported: false,
      periodKey: new Date().toISOString().slice(0, 7),
      createdAt: new Date(),
      updatedAt: new Date()
    });
    await database.collections.billingAccounts.updateOne(
      { ownerUserId: state.owner.userId },
      { $set: { plan: "free", updatedAt: new Date() }, $unset: { subscriptionStatus: "", subscriptionId: "", currentPeriodEnd: "" } }
    );
    await database.collections.policies.updateOne({ agentId: state.agent._id }, { $set: { "email.requireApproval": "never", updatedAt: new Date() } });
    try {
      await expect(state.api.email.send({ to: "casey@example.com", subject: "Limit", text: "Limit", waitForApproval: false }))
        .rejects.toMatchObject({ status: 402, code: "plan_limit" });
    } finally {
      await database.collections.billingAccounts.updateOne({ ownerUserId: state.owner.userId }, { $set: { plan: "pro", subscriptionStatus: "active", updatedAt: new Date() } });
      await database.collections.policies.updateOne({ agentId: state.agent._id }, { $set: { "email.blockedRecipients": [], "email.requireApproval": "always", updatedAt: new Date() } });
    }

    const token = await database.collections.identityTokens.findOne({ agentId: state.agent._id, status: "active" });
    await database.collections.identityTokens.updateOne({ _id: token!._id }, { $set: { status: "revoked", updatedAt: new Date() } });
    await expect(state.api.whoami()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    await database.collections.identityTokens.updateOne({ _id: token!._id }, { $set: { status: "active", updatedAt: new Date() } });
    step();
    expect(await database.collections.auditLogs.countDocuments({ agentId: state.agent._id, status: "blocked" })).toBeGreaterThanOrEqual(1);
    await assertInvariants(step);
  }));

  it("MCP email parity", () => scenario("MCP email parity", async (step) => {
    const client = new Client({ name: "barkan-e2e", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${state.token}` } }
    });
    await client.connect(transport);
    try {
      const before = await database.collections.auditLogs.countDocuments({ agentId: state.agent._id, action: AUDIT_ACTIONS.approval.requested });
      const sent = await client.callTool({
        name: "barkan_email_send",
        arguments: { to: "mcp@example.com", subject: "Parity", body: "Check parity", wait_for_approval: false }
      });
      expect(sent.structuredContent).toMatchObject({ ok: false, status: "approval_required" });
      await approve((sent.structuredContent as { approval_id: string }).approval_id, step);
      const threadList = await client.callTool({ name: "barkan_email_list_threads", arguments: {} });
      expect(JSON.stringify(threadList.structuredContent)).toContain("mcp@example.com");
      const after = await database.collections.auditLogs.countDocuments({ agentId: state.agent._id, action: AUDIT_ACTIONS.approval.requested });
      expect(after).toBe(before + 1);
      await assertInvariants(step);
    } finally {
      await client.close();
    }
  }));
});

async function scenario(name: string, run: (step: () => void) => Promise<void>) {
  const started = Date.now();
  let steps = 0;
  try {
    await run(() => {
      steps += 1;
    });
    scenarioReport.push({ name, steps, durationMs: Date.now() - started, status: "pass" });
  } catch (error) {
    scenarioReport.push({ name, steps, durationMs: Date.now() - started, status: "fail" });
    throw error;
  }
}

async function signupOwner(step: () => void) {
  const email = `e2e-${crypto.randomBytes(5).toString("hex")}@example.com`;
  const response = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse battery staple" })
  });
  expect(response.status).toBe(200);
  step();
  const cookie = /barkan_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  expect(cookie).toBeTruthy();
  const user = await database.collections.users.findOne({ email });
  expect(user).toBeTruthy();
  return { email, cookie: cookie!, userId: user!._id };
}

async function seedProPlan(ownerUserId: ObjectId) {
  await database.collections.billingAccounts.updateOne(
    { ownerUserId },
    { $set: { stripeCustomerId: "cus_e2e", plan: "pro", subscriptionStatus: "active", updatedAt: new Date() } }
  );
}

async function ownerFetch<T>(cookie: string, path: string, input: { method?: string; body?: unknown } = {}, step?: () => void): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: input.method ?? "GET",
    headers: { "content-type": "application/json", cookie: `${config.SESSION_COOKIE_NAME}=${cookie}` },
    body: input.body === undefined ? undefined : JSON.stringify(input.body)
  });
  if (!response.ok) throw new Error(`${input.method ?? "GET"} ${path} failed ${response.status}: ${await response.text()}`);
  step?.();
  return await response.json() as T;
}

async function approve(approvalId: string, step: () => void) {
  const response = await ownerFetch<{ approval: { status: string; executionResult: unknown } }>(
    state.owner.cookie,
    `/api/v1/approvals/${approvalId}/approve`,
    { method: "POST", body: { note: "e2e-approved" } },
    step
  );
  expect(response.approval.status).toBe("approved");
  expect(response.approval.executionResult).toBeTruthy();
}

async function expectApproval(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApprovalPendingError);
    return (error as ApprovalPendingError).approvalId;
  }
  throw new Error("expected approval pending");
}

async function loadAgent(agentId: string): Promise<AgentDocument> {
  const agent = await database.collections.agents.findOne({ _id: new ObjectId(agentId) });
  if (!agent) throw new Error(`agent not found: ${agentId}`);
  return agent;
}

async function firstEmail(direction: "inbound" | "outbound", counterparty: string) {
  const message = await database.collections.emailMessages.findOne(
    { agentId: state.agent._id, direction, $or: [{ toEmail: counterparty }, { fromEmail: counterparty }] },
    { sort: { createdAt: 1 } }
  );
  expect(message).toBeTruthy();
  return message!;
}

async function deliverInboundEmail(input: { from: string; to: string; subject: string; text: string; inReplyTo?: string }, step: () => void) {
  const now = new Date();
  const thread = await database.collections.emailThreads.findOne({ agentId: state.agent._id, counterpartyEmail: input.from });
  expect(thread).toBeTruthy();
  const messageId = new ObjectId();
  await database.collections.emailMessages.insertOne({
    _id: messageId,
    agentId: state.agent._id,
    threadId: thread!._id,
    direction: "inbound",
    fromEmail: input.from,
    toEmail: input.to,
    subject: input.subject,
    textBody: input.text,
    providerMessageId: `inbound_${crypto.randomBytes(4).toString("hex")}`,
    headers: { "message-id": `<inbound-${Date.now()}@example.com>`, ...(input.inReplyTo ? { "in-reply-to": input.inReplyTo } : {}) },
    summary: input.text,
    suggestedReply: "Thanks for getting back to me.",
    status: "received",
    createdAt: now,
    updatedAt: now
  });
  await database.collections.emailThreads.updateOne({ _id: thread!._id }, { $set: { lastMessageAt: now, updatedAt: now }, $inc: { messageCount: 1 } });
  await database.collections.auditLogs.insertOne({
    _id: new ObjectId(),
    agentId: state.agent._id,
    ownerUserId: state.owner.userId,
    actor: "system",
    action: AUDIT_ACTIONS.email.receive,
    status: "allowed",
    detail: `Reply from ${input.from}: ${input.text}`,
    resourceType: "emailMessage",
    resourceId: messageId.toHexString(),
    metadata: { fixture: true },
    createdAt: now
  });
  await database.collections.webhookEvents.insertOne({
    _id: new ObjectId(),
    provider: "resend",
    providerEventId: `resend_${crypto.randomBytes(4).toString("hex")}`,
    eventType: "email.received",
    payloadHash: crypto.randomBytes(16).toString("hex"),
    status: "processed",
    processedAt: now,
    createdAt: now,
    updatedAt: now
  });
  step();
}

async function deliverElevenLabsPostCall(callId: string, conversationId: string, step: () => void) {
  await postJson("/webhooks/elevenlabs/post-call", {
    type: "post_call_transcription",
    data: {
      event_id: `post_${callId}`,
      conversation_id: conversationId,
      dynamic_variables: { barkan_call_id: callId },
      status: "completed",
      metadata: { duration_secs: 47 },
      analysis: { transcript_summary: "Office confirmed it is open until 5pm." },
      transcript: [{ role: "agent", message: "Can you confirm hours?", time_in_call_secs: 1 }]
    }
  }, step);
}

async function deliverPersonalization(step: () => void): Promise<string> {
  const response = await postJson<{ dynamic_variables: { barkan_call_id: string } }>("/webhooks/elevenlabs/personalization", {
    caller_id: "+14155550177",
    called_number: await agentPhoneNumber(),
    call_sid: "CAe2eInbound"
  }, step);
  expect(response.dynamic_variables.barkan_call_id).toMatch(/^[a-f0-9]{24}$/);
  return response.dynamic_variables.barkan_call_id;
}

async function deliverStripeEvent(event: Record<string, unknown>, step: () => void) {
  const raw = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: raw,
    secret: stripeWebhookSecret,
    timestamp: Math.floor(Date.now() / 1000)
  });
  const response = await fetch(`${baseUrl}/webhooks/stripe`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: raw
  });
  if (!response.ok) throw new Error(`stripe webhook failed ${response.status}: ${await response.text()}`);
  step();
}

async function postJson<T = unknown>(path: string, body: unknown, step: () => void): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mock-signature": "allow" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${path} failed ${response.status}: ${await response.text()}`);
  step();
  return await response.json() as T;
}

async function postForm(path: string, body: Record<string, string>, step: () => void): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-mock-signature": "allow" },
    body: new URLSearchParams(body)
  });
  if (!response.ok) throw new Error(`${path} failed ${response.status}: ${await response.text()}`);
  step();
}

async function agentEmailAddress(): Promise<string> {
  const account = await database.collections.emailAccounts.findOne({ agentId: state.agent._id, status: "active" });
  expect(account).toBeTruthy();
  return account!.address;
}

async function agentPhoneNumber(): Promise<string> {
  const phoneNumber = await database.collections.phoneNumbers.findOne({ agentId: state.agent._id, status: "active" });
  expect(phoneNumber).toBeTruthy();
  return phoneNumber!.e164;
}

async function auditCount(): Promise<number> {
  return database.collections.auditLogs.countDocuments({ agentId: state.agent._id });
}

async function auditActionsAfter(skip: number): Promise<string[]> {
  return (await database.collections.auditLogs.find({ agentId: state.agent._id }).sort({ createdAt: 1, _id: 1 }).skip(skip).toArray())
    .map((entry) => entry.action);
}

async function usageCountsByMeter() {
  const rows = await database.collections.usageEvents.aggregate<{ _id: string; used: number }>([
    { $match: { ownerUserId: state.owner.userId } },
    { $group: { _id: "$meter", used: { $sum: "$quantity" } } }
  ]).toArray();
  return Object.fromEntries(rows.map((row) => [row._id, row.used])) as Record<string, number>;
}

async function assertInvariants(step: () => void) {
  expect(await database.collections.webhookEvents.countDocuments({ status: "failed" })).toBe(0);
  expect(await database.collections.auditLogs.countDocuments({ agentId: state.agent._id })).toBeGreaterThan(0);
  step();
}

function printReport() {
  if (scenarioReport.length === 0) return;
  // eslint-disable-next-line no-console
  console.table(scenarioReport.map((row) => ({
    scenario: row.name,
    status: row.status,
    steps: row.steps,
    duration: `${row.durationMs}ms`
  })));
}
