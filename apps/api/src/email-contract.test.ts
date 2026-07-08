import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { connectDatabase, type AgentDocument, type Database } from "./db.js";
import { decideApproval } from "./approvals.js";
import { ingestResendReceivedEmail, sendAgentEmail } from "./email-service.js";
import { MockEmailProvider, type EmailProviderSendInput, type ReceivedEmailContent } from "./providers/email-provider.js";

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
let sendCalls: EmailProviderSendInput[] = [];
let failNextProviderSend: Error | null = null;
let agentCounter = 0;

const originalMockSend = MockEmailProvider.prototype.sendEmail;

beforeAll(async () => {
  vi.spyOn(MockEmailProvider.prototype, "sendEmail").mockImplementation(async function (input) {
    sendCalls.push(input);
    if (failNextProviderSend) {
      const error = failNextProviderSend;
      failNextProviderSend = null;
      throw error;
    }
    return originalMockSend.call(this, input);
  });
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);
  ownerCookie = await signup("email-contract-owner@example.com");
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await Promise.all([
    database.collections.agents.deleteMany({}),
    database.collections.identityTokens.deleteMany({}),
    database.collections.emailAccounts.deleteMany({}),
    database.collections.emailThreads.deleteMany({}),
    database.collections.emailMessages.deleteMany({}),
    database.collections.approvals.deleteMany({}),
    database.collections.policies.deleteMany({}),
    database.collections.auditLogs.deleteMany({}),
    database.collections.usageEvents.deleteMany({})
  ]);
});

describe("email agent API frozen contract", () => {
  it("GET /api/v1/agent/email/address returns the address contract", async () => {
    const created = await createEmailAgent("Address");
    const response = await agentRequest(created.token, "GET", "/api/v1/agent/email/address");
    expect(response.statusCode).toBe(200);
    expect(normalizeContract(response.json())).toMatchInlineSnapshot(`
      {
        "address": "address@agents.barkan.dev",
        "displayName": "Address 1",
        "status": "active",
      }
    `);
  });

  it("POST /api/v1/agent/email/send returns the send contract", async () => {
    const created = await createEmailAgent("Send");
    await setEmailPolicy(created.agentId, { requireApproval: "never" });
    const response = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "alice@example.com",
      subject: "Hello",
      text: "Hello Alice"
    });
    expect(response.statusCode).toBe(201);
    expect(normalizeContract(response.json())).toMatchInlineSnapshot(`
      {
        "from": "send@agents.barkan.dev",
        "message_id": "<object-id>",
        "ok": true,
        "provider_message_id": "<provider-message-id>",
        "status": "sent",
        "subject": "Hello",
        "thread_id": "<object-id>",
        "to": "alice@example.com",
      }
    `);
  });

  it("accepts optional html on send", async () => {
    const created = await createEmailAgent("Html");
    await setEmailPolicy(created.agentId, { requireApproval: "never" });
    const response = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "html@example.com",
      subject: "HTML",
      text: "Plain",
      html: "<p>Plain</p>"
    });
    expect(response.statusCode).toBe(201);
    expect(sendCalls.at(-1)?.html).toBe("<p>Plain</p>");
  });

  it("idempotent replay returns 200 and does not call the provider twice", async () => {
    const created = await createEmailAgent("Idempotent");
    await setEmailPolicy(created.agentId, { requireApproval: "never" });
    const before = sendCalls.length;
    const payload = { to: "idempotent@example.com", subject: "Once", text: "Only once", idempotencyKey: "idem-1" };
    const first = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", payload);
    const replay = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", payload);
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().message_id).toBe(first.json().message_id);
    expect(sendCalls.length - before).toBe(1);
  });

  it("GET /threads returns the list contract", async () => {
    const created = await createEmailAgent("Threads");
    await setEmailPolicy(created.agentId, { requireApproval: "never" });
    await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "thread@example.com",
      subject: "Thread",
      text: "First"
    });
    const response = await agentRequest(created.token, "GET", "/api/v1/agent/email/threads");
    expect(response.statusCode).toBe(200);
    expect(normalizeContract(response.json())).toMatchInlineSnapshot(`
      {
        "nextCursor": null,
        "threads": [
          {
            "counterparty": "thread@example.com",
            "id": "<object-id>",
            "lastMessageAt": "<iso-date>",
            "subject": "Thread",
            "unreadCount": 0,
          },
        ],
      }
    `);
  });

  it("GET /threads/:threadId returns the thread detail contract", async () => {
    const created = await createEmailAgent("Thread Detail");
    await setEmailPolicy(created.agentId, { requireApproval: "never" });
    const send = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "detail@example.com",
      subject: "Detail",
      text: "Body"
    });
    const response = await agentRequest(created.token, "GET", `/api/v1/agent/email/threads/${send.json().thread_id}`);
    expect(response.statusCode).toBe(200);
    expect(normalizeContract(response.json())).toMatchInlineSnapshot(`
      {
        "messages": [
          {
            "attachments": [],
            "body": "Body",
            "cc": [],
            "created_at": "<iso-date>",
            "direction": "outbound",
            "from_email": "thread-detail@agents.barkan.dev",
            "html": null,
            "id": "<object-id>",
            "parsed_by": null,
            "provider_message_id": "<provider-message-id>",
            "status": "sent",
            "subject": "Detail",
            "suggested_reply": null,
            "summary": null,
            "thread_id": "<object-id>",
            "to_email": "detail@example.com",
          },
        ],
        "thread": {
          "counterparty": "detail@example.com",
          "id": "<object-id>",
          "lastMessageAt": "<iso-date>",
          "messageCount": 1,
          "subject": "Detail",
        },
      }
    `);
  });

  it("POST /threads/:threadId/reply returns the reply contract", async () => {
    const created = await createEmailAgent("Reply");
    await setEmailPolicy(created.agentId, { requireApproval: "never" });
    const send = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "reply@example.com",
      subject: "Reply",
      text: "Opening"
    });
    const response = await agentRequest(created.token, "POST", `/api/v1/agent/email/threads/${send.json().thread_id}/reply`, {
      text: "Following up"
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ ok: true, subject: "Re: Reply", to: "reply@example.com" });
  });

  it("reply supports async approval mode", async () => {
    const created = await createEmailAgent("Reply Approval");
    await setEmailPolicy(created.agentId, { requireApproval: "never" });
    const send = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "reply-approval@example.com",
      subject: "Reply approval",
      text: "Opening"
    });
    await setEmailPolicy(created.agentId, { requireApproval: "always" });
    const response = await agentRequest(created.token, "POST", `/api/v1/agent/email/threads/${send.json().thread_id}/reply?mode=async`, {
      text: "Needs approval"
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: "approval_required", decision: "pending" });
  });

  it("GET /api/v1/agent/approvals/:id returns the approval contract", async () => {
    const created = await createEmailAgent("Approval Get");
    await setEmailPolicy(created.agentId, { requireApproval: "always" });
    const pending = await agentRequest(created.token, "POST", "/api/v1/agent/email/send?mode=async", {
      to: "approval-get@example.com",
      subject: "Needs approval",
      text: "Please approve"
    });
    const response = await agentRequest(created.token, "GET", `/api/v1/agent/approvals/${pending.json().approval_id}`);
    expect(response.statusCode).toBe(200);
    expect(normalizeContract(response.json())).toMatchInlineSnapshot(`
      {
        "approval": {
          "agentId": "<object-id>",
          "createdAt": "<iso-date>",
          "decidedAt": null,
          "decisionNote": null,
          "executionError": null,
          "executionResult": null,
          "expiresAt": "<iso-date>",
          "id": "<object-id>",
          "kind": "email.send",
          "ownerUserId": "<object-id>",
          "payload": {
            "cc": [],
            "subject": "Needs approval",
            "text": "Please approve",
            "to": "approval-get@example.com",
          },
          "payloadSummary": "Send email to approval-get@example.com: Needs approval",
          "status": "pending",
          "updatedAt": "<iso-date>",
        },
      }
    `);
  });

  it("blocks configured recipients with policy_blocked", async () => {
    const created = await createEmailAgent("Blocked");
    await setEmailPolicy(created.agentId, { requireApproval: "never", blockedRecipients: ["blocked@example.com"] });
    const response = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "blocked@example.com",
      subject: "Blocked",
      text: "No"
    });
    expectError(response, 403, "policy_blocked", /blocked/);
  });

  it("blocks allowlist misses with policy_blocked", async () => {
    const created = await createEmailAgent("Allowlist");
    await setEmailPolicy(created.agentId, { requireApproval: "never", allowedRecipients: ["@example.com"] });
    const response = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "person@other.com",
      subject: "Blocked",
      text: "No"
    });
    expectError(response, 403, "policy_blocked", /allowed recipients/);
  });

  it("blocks recipient count over maxRecipientsPerMessage", async () => {
    const created = await createEmailAgent("Recipients");
    await setEmailPolicy(created.agentId, { requireApproval: "never", maxRecipientsPerMessage: 1 });
    const response = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "one@example.com",
      cc: ["two@example.com"],
      subject: "Too many",
      text: "No"
    });
    expectError(response, 403, "policy_blocked", /limit is 1/);
  });

  it("blocks daily cap exhaustion", async () => {
    const created = await createEmailAgent("Daily Contract");
    await setEmailPolicy(created.agentId, { requireApproval: "never", dailySendLimit: 1 });
    expect((await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "first@example.com",
      subject: "First",
      text: "First"
    })).statusCode).toBe(201);
    const capped = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "second@example.com",
      subject: "Second",
      text: "Second"
    });
    expectError(capped, 403, "policy_blocked", /daily email send limit/);
  });

  it("wait approval approved returns the final send once", async () => {
    const created = await createEmailAgent("Wait Approved");
    await setEmailPolicy(created.agentId, { requireApproval: "always" });
    const before = sendCalls.length;
    const pendingResponse = agentRequest(created.token, "POST", "/api/v1/agent/email/send?wait=3", {
      to: "wait-approved@example.com",
      subject: "Wait approved",
      text: "Approve"
    });
    const approval = await waitForPendingApproval(created.agentId);
    await ownerDecision(approval._id.toHexString(), "approve");
    const final = await pendingResponse;
    expect(final.statusCode).toBe(201);
    expect(final.json()).toMatchObject({ ok: true, to: "wait-approved@example.com" });
    expect(sendCalls.length - before).toBe(1);
  });

  it("wait approval rejected returns approval_required and sends nothing", async () => {
    const created = await createEmailAgent("Wait Rejected");
    await setEmailPolicy(created.agentId, { requireApproval: "always" });
    const before = sendCalls.length;
    const pendingResponse = agentRequest(created.token, "POST", "/api/v1/agent/email/send?wait=3", {
      to: "wait-rejected@example.com",
      subject: "Wait rejected",
      text: "Reject"
    });
    const approval = await waitForPendingApproval(created.agentId);
    await ownerDecision(approval._id.toHexString(), "reject");
    const final = await pendingResponse;
    expectError(final, 403, "approval_required", /rejected/);
    expect(sendCalls.length).toBe(before);
  });

  it("async approval returns approval_required with approval_id", async () => {
    const created = await createEmailAgent("Async Contract");
    await setEmailPolicy(created.agentId, { requireApproval: "always" });
    const response = await agentRequest(created.token, "POST", "/api/v1/agent/email/send?mode=async", {
      to: "async-contract@example.com",
      subject: "Async",
      text: "Pending"
    });
    expect(response.statusCode).toBe(202);
    expect(normalizeContract(response.json())).toMatchInlineSnapshot(`
      {
        "approval": {
          "executionError": null,
          "executionResult": null,
          "id": "<object-id>",
          "payloadSummary": "Send email to async-contract@example.com: Async",
          "status": "pending",
        },
        "approval_id": "<object-id>",
        "decision": "pending",
        "ok": false,
        "status": "approval_required",
      }
    `);
  });

  it("wait approval timeout returns 202 decision timeout", async () => {
    const created = await createEmailAgent("Wait Timeout");
    await setEmailPolicy(created.agentId, { requireApproval: "always" });
    const response = await agentRequest(created.token, "POST", "/api/v1/agent/email/send?wait=1", {
      to: "timeout@example.com",
      subject: "Timeout",
      text: "Timeout"
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: "approval_required", decision: "timeout" });
  });

  it("wait approval expired returns approval_required expired", async () => {
    const created = await createEmailAgent("Wait Expired");
    await setEmailPolicy(created.agentId, { requireApproval: "always" });
    const pendingResponse = agentRequest(created.token, "POST", "/api/v1/agent/email/send?wait=6", {
      to: "expired@example.com",
      subject: "Expired",
      text: "Expired"
    });
    const approval = await waitForPendingApproval(created.agentId);
    await database.collections.approvals.updateOne(
      { _id: approval._id },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } }
    );
    const final = await pendingResponse;
    expectError(final, 403, "approval_required", /expired/);
  }, 10_000);

  it("thread ownership mismatch returns not_found", async () => {
    const owner = await createEmailAgent("Thread Owner");
    const other = await createEmailAgent("Thread Other");
    await setEmailPolicy(owner.agentId, { requireApproval: "never" });
    const send = await agentRequest(owner.token, "POST", "/api/v1/agent/email/send", {
      to: "owned@example.com",
      subject: "Owned",
      text: "Owned"
    });
    const response = await agentRequest(other.token, "GET", `/api/v1/agent/email/threads/${send.json().thread_id}`);
    expectError(response, 404, "not_found", /email thread not found/);
  });

  it("revoked tokens return unauthorized", async () => {
    const created = await createEmailAgent("Revoked Contract");
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${created.agentId}`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
    });
    const tokenId = detail.json().tokens[0].id as string;
    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/v1/agents/${created.agentId}/tokens/${tokenId}`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
    });
    expect(revoke.statusCode).toBe(200);
    const response = await agentRequest(created.token, "GET", "/api/v1/agent/email/address");
    expectError(response, 401, "unauthorized", /missing or invalid identity token/);
  });

  it("provider failures return provider_error", async () => {
    const created = await createEmailAgent("Provider Error");
    await setEmailPolicy(created.agentId, { requireApproval: "never" });
    failNextProviderSend = new Error("provider down");
    const response = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "provider-error@example.com",
      subject: "Provider",
      text: "Provider"
    });
    expectError(response, 502, "provider_error", /provider down/);
  });

  it("paginates thread lists with cursor", async () => {
    const created = await createEmailAgent("Pagination");
    await setEmailPolicy(created.agentId, { requireApproval: "never" });
    for (let index = 0; index < 26; index++) {
      const response = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
        to: `page-${index}@example.com`,
        subject: `Page ${index}`,
        text: `Page ${index}`
      });
      expect(response.statusCode).toBe(201);
    }
    const firstPage = await agentRequest(created.token, "GET", "/api/v1/agent/email/threads");
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().threads).toHaveLength(25);
    expect(firstPage.json().nextCursor).toEqual(expect.any(String));
    const secondPage = await agentRequest(created.token, "GET", `/api/v1/agent/email/threads?cursor=${firstPage.json().nextCursor}`);
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().threads.length).toBeGreaterThanOrEqual(1);
  });

  it("malformed send payload returns validation_failed shape", async () => {
    const created = await createEmailAgent("Malformed");
    const response = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "bad@example.com",
      subject: "Missing text"
    });
    expectError(response, 400, "validation_failed", /invalid request/);
    expect(normalizeContract(response.json())).toMatchInlineSnapshot(`
      {
        "error": {
          "code": "validation_failed",
          "details": {
            "fieldErrors": {
              "text": [
                "text is required",
              ],
            },
            "formErrors": [],
          },
          "message": "invalid request",
          "requestId": "<request-id>",
        },
        "message": "invalid request",
      }
    `);
  });

  it("bad recipient email returns validation_failed", async () => {
    const created = await createEmailAgent("Bad Recipient");
    const response = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "not-an-email",
      subject: "Bad",
      text: "Bad"
    });
    expectError(response, 400, "validation_failed", /invalid request/);
  });

  it.each([
    ["send", "POST", "/api/v1/agent/email/send", { to: "unauth@example.com", subject: "Unauth", text: "Unauth" }],
    ["threads", "GET", "/api/v1/agent/email/threads", undefined],
    ["address", "GET", "/api/v1/agent/email/address", undefined],
    ["approval get", "GET", `/api/v1/agent/approvals/${new ObjectId().toHexString()}`, undefined]
  ])("unauthorized %s returns unauthorized", async (_name, method, url, payload) => {
    const response = await app.inject({ method, url, payload });
    expectError(response, 401, "unauthorized", /missing or invalid identity token/);
  });

  it("bad thread id returns not_found", async () => {
    const created = await createEmailAgent("Bad Thread");
    const response = await agentRequest(created.token, "GET", "/api/v1/agent/email/threads/not-an-id");
    expectError(response, 404, "not_found", /email thread not found/);
  });

  it("agent token routes can return rate_limited", async () => {
    const created = await createEmailAgent("Rate Limited");
    let limitedStatus = 0;
    let limitedBody: Record<string, unknown> | null = null;
    for (let index = 0; index < 70; index++) {
      const response = await agentRequest(created.token, "GET", "/api/v1/agent/email/address");
      if (response.statusCode === 429) {
        limitedStatus = response.statusCode;
        limitedBody = response.json();
        break;
      }
    }
    expect(limitedStatus).toBe(429);
    expect(limitedBody?.error).toMatchObject({ code: "rate_limited" });
  });

  it("new_recipients allows a known recipient without another approval", async () => {
    const created = await createEmailAgent("Known Recipient");
    await setEmailPolicy(created.agentId, { requireApproval: "never" });
    expect((await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "known@example.com",
      subject: "First",
      text: "First"
    })).statusCode).toBe(201);
    await setEmailPolicy(created.agentId, { requireApproval: "new_recipients" });
    const known = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "known@example.com",
      subject: "Second",
      text: "Second"
    });
    expect(known.statusCode).toBe(201);
  });

  it("send with a bad threadId returns not_found", async () => {
    const created = await createEmailAgent("Bad Send Thread");
    await setEmailPolicy(created.agentId, { requireApproval: "never" });
    const response = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "bad-thread@example.com",
      subject: "Bad thread",
      text: "Bad thread",
      threadId: "not-an-object-id"
    });
    expectError(response, 404, "not_found", /email thread not found/);
  });

  it("agent without an email account returns validation_failed", async () => {
    const created = await createEmailAgent("No Email");
    await setEmailPolicy(created.agentId, { requireApproval: "never" });
    await database.collections.emailAccounts.deleteOne({ agentId: new ObjectId(created.agentId) });
    const response = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "missing@example.com",
      subject: "Missing",
      text: "Missing"
    });
    expectError(response, 409, "validation_failed", /does not have an email address/);
  });

  it("idempotent replay with a missing thread returns internal", async () => {
    const created = await createEmailAgent("Missing Thread Replay");
    await setEmailPolicy(created.agentId, { requireApproval: "never" });
    const sent = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "missing-thread@example.com",
      subject: "Missing thread",
      text: "Missing thread",
      idempotencyKey: "missing-thread"
    });
    expect(sent.statusCode).toBe(201);
    await database.collections.emailThreads.deleteOne({ _id: new ObjectId(sent.json().thread_id) });
    const replay = await agentRequest(created.token, "POST", "/api/v1/agent/email/send", {
      to: "missing-thread@example.com",
      subject: "Missing thread",
      text: "Missing thread",
      idempotencyKey: "missing-thread"
    });
    expectError(replay, 500, "internal", /idempotent email message is missing its thread/);
  });

  it("direct service send records attachment metadata for buffer and text content", async () => {
    const created = await createEmailAgent("Attachment Metadata");
    const agent = await loadAgent(created.agentId);
    const provider = new MockEmailProvider();
    const result = await sendAgentEmail(database.collections, config, provider, {
      agent,
      to: "attachment@example.com",
      subject: "Attachments",
      text: "See files",
      attachments: [
        { filename: "buffer.txt", content: Buffer.from("abc"), contentType: "text/plain" },
        { filename: "text.txt", content: "hello" },
        { filename: false, path: "/tmp/file" }
      ]
    });
    expect(result.message.attachments).toMatchObject([
      { filename: "buffer.txt", contentType: "text/plain", sizeBytes: 3 },
      { filename: "text.txt", contentType: "application/octet-stream", sizeBytes: 5 },
      { filename: "attachment", contentType: "application/octet-stream", sizeBytes: 0 }
    ]);
  });

  it("inbound ingestion skips payloads without email ids", async () => {
    const result = await ingestResendReceivedEmail(database.collections, config, inboundClient(inboundContent("missing@example.com")), {});
    expect(result).toEqual({ status: "skipped", reason: "missing email_id" });
  });

  it("inbound ingestion audits unrouted recipients", async () => {
    const result = await ingestResendReceivedEmail(
      database.collections,
      config,
      inboundClient(inboundContent("nobody@agents.barkan.dev")),
      { data: { email_id: "inbound-unrouted" } }
    );
    expect(result).toEqual({ status: "skipped", reason: "no active recipient" });
    const audit = await database.collections.auditLogs.findOne({ action: "email.receive.unrouted", "metadata.emailId": "inbound-unrouted" });
    expect(audit?.status).toBe("blocked");
  });

  it("inbound ingestion stores cc, attachments, summary, and reuses sender thread", async () => {
    const created = await createEmailAgent("Inbound Store");
    const account = await database.collections.emailAccounts.findOne({ agentId: new ObjectId(created.agentId) });
    expect(account).not.toBeNull();
    const first = await ingestResendReceivedEmail(
      database.collections,
      config,
      inboundClient(inboundContent(account!.address, { id: "inbound-one", from: "Sender <sender@example.com>", text: "First inbound body", attachmentId: "att-one" })),
      { data: { email_id: "inbound-one" } }
    );
    const second = await ingestResendReceivedEmail(
      database.collections,
      config,
      inboundClient(inboundContent(account!.address, { id: "inbound-two", from: "sender@example.com", text: "Second inbound body" })),
      { data: { email_id: "inbound-two" } }
    );
    expect(first.status).toBe("received");
    expect(second.status).toBe("received");
    expect(second.message?.threadId.toHexString()).toBe(first.message?.threadId.toHexString());
    expect(first.message).toMatchObject({
      fromEmail: "sender@example.com",
      cc: ["cc@example.com"],
      summary: "First inbound body",
      attachments: [{ filename: "brief.pdf", providerAttachmentId: "att-one" }]
    });
  });

  it("approval executor records executionError for malformed approval payloads", async () => {
    const created = await createEmailAgent("Malformed Approval Payload");
    const agent = await loadAgent(created.agentId);
    const approvalId = new ObjectId();
    await database.collections.approvals.insertOne({
      _id: approvalId,
      agentId: agent._id,
      ownerUserId: agent.ownerUserId!,
      kind: "email.send",
      status: "pending",
      payloadSummary: "Malformed email approval",
      payload: {},
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date()
    });
    const decided = await decideApproval(database.collections, agent.ownerUserId!, approvalId, "approved");
    expect(decided.executionError).toMatch(/missing email send fields/);
  });
});

async function signup(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email, password: "password12345" }
  });
  expect(response.statusCode).toBe(200);
  await database.collections.billingAccounts.updateOne(
    { ownerUserId: (await database.collections.users.findOne({ email }))!._id },
    { $set: { plan: "scale", subscriptionStatus: "active", updatedAt: new Date() } }
  );
  return response.cookies.find((cookie) => cookie.name === config.SESSION_COOKIE_NAME)!.value;
}

async function createEmailAgent(namePrefix: string) {
  agentCounter += 1;
  const name = `${namePrefix} ${agentCounter}`;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agents",
    cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie },
    payload: { name, capabilities: { email: true }, approvalMode: "policy" }
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ agent: { id: string; emailAddress: string }; identityToken: { secret: string } }>();
  return { agentId: body.agent.id, token: body.identityToken.secret, emailAddress: body.agent.emailAddress };
}

async function setEmailPolicy(
  agentId: string,
  patch: Partial<{
    requireApproval: "always" | "new_recipients" | "never";
    allowedRecipients: string[];
    blockedRecipients: string[];
    dailySendLimit: number;
    maxRecipientsPerMessage: number;
  }>
) {
  const policy = {
    requireApproval: "new_recipients",
    allowedRecipients: [],
    blockedRecipients: [],
    dailySendLimit: 50,
    maxRecipientsPerMessage: 5,
    ...patch
  };
  const response = await app.inject({
    method: "PUT",
    url: `/api/v1/agents/${agentId}/policies/email`,
    cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie },
    payload: policy
  });
  expect(response.statusCode).toBe(200);
}

async function agentRequest(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload })
  });
}

async function waitForPendingApproval(agentId: string) {
  const objectId = new ObjectId(agentId);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const approval = await database.collections.approvals.findOne({ agentId: objectId, status: "pending" });
    if (approval) return approval;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("approval not created");
}

async function ownerDecision(approvalId: string, decision: "approve" | "reject") {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/approvals/${approvalId}/${decision}`,
    cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
  });
  expect(response.statusCode).toBe(200);
}

async function loadAgent(agentId: string): Promise<AgentDocument> {
  const agent = await database.collections.agents.findOne({ _id: new ObjectId(agentId) });
  if (!agent) throw new Error("agent not found");
  return agent;
}

function inboundClient(content: ReceivedEmailContent) {
  return {
    getReceivedEmail: async () => content,
    getAttachment: async () => ({ data: new ArrayBuffer(0), contentType: "application/octet-stream", filename: "empty.bin" })
  };
}

function inboundContent(to: string, overrides: Partial<ReceivedEmailContent> & { attachmentId?: string } = {}): ReceivedEmailContent {
  return {
    id: overrides.id ?? "inbound-id",
    from: overrides.from ?? "sender@example.com",
    to: [to],
    cc: ["cc@example.com"],
    receivedFor: [],
    subject: overrides.subject ?? "Inbound",
    text: overrides.text ?? "Inbound body",
    html: overrides.html,
    headers: overrides.headers ?? {},
    attachments: overrides.attachmentId
      ? [{ id: overrides.attachmentId, filename: "brief.pdf", sizeBytes: 42, contentType: "application/pdf" }]
      : [],
    ...overrides
  };
}

function expectError(response: { statusCode: number; json: () => { error?: { code?: string; message?: string }; message?: string } }, status: number, code: string, message: RegExp) {
  expect(response.statusCode).toBe(status);
  const body = response.json();
  expect(body.error?.code).toBe(code);
  expect(body.error?.message ?? body.message).toMatch(message);
}

function normalizeContract(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeContract);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeContract(entry)]));
  }
  if (typeof value !== "string") {
    return value;
  }
  if (/^[a-f0-9]{16}$/.test(value)) {
    return "<request-id>";
  }
  if (/^[a-f0-9]{24}$/.test(value)) {
    return "<object-id>";
  }
  if (/^mock_[a-f0-9]+$/.test(value)) {
    return "<provider-message-id>";
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return "<iso-date>";
  }
  return value.replace(/[a-z-]+-\d+@agents\.barkan\.dev/g, (address) => address.replace(/-\d+@/, "@"));
}
