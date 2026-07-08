import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { connectDatabase, type AgentDocument, type Database } from "./db.js";
import { issueIdentityToken } from "./agent-auth.js";
import { AUDIT_ACTIONS, recordAudit } from "./audit.js";
import { decideApproval } from "./approvals.js";
import { defaultEmailPolicy, defaultPhonePolicy } from "./policies.js";

const config = {
  NODE_ENV: "test",
  API_PORT: 0,
  PUBLIC_APP_URL: "http://localhost:4888",
  PUBLIC_API_URL: "http://localhost:4001",
  MONGODB_URI: "mongodb://127.0.0.1:27017/barkan-mcp-test",
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

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  database = await connectDatabase({ MONGODB_URI: mongoServer.getUri() } as AppConfig);
}, 60_000);

afterAll(async () => {
  await database?.client.close();
  await mongoServer?.stop();
});

describe("MCP streamable HTTP endpoint", () => {
  it("requires a bearer identity token", async () => {
    const app = await buildApp(config, database.collections);
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      jsonrpc: "2.0",
      error: { data: { code: "unauthorized" } }
    });

    await app.close();
  });

  it("lists capability-scoped tools and reads identity resource", async () => {
    const { agent, token } = await createAgent({ email: true, phone: false });
    const { client, close } = await connectMcpClient(token);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    expect(toolNames).toContain("barkan_whoami");
    expect(toolNames).toContain("barkan_email_send");
    expect(toolNames).not.toContain("barkan_phone_call");

    const whoami = await client.callTool({ name: "barkan_whoami", arguments: {} });
    expect(whoami.structuredContent).toMatchObject({
      agent_id: agent._id.toHexString(),
      capabilities: { email: true, phone: false }
    });

    const resource = await client.readResource({ uri: "barkan://identity" });
    expect(JSON.parse(resource.contents[0]!.text as string)).toMatchObject({
      agent_id: agent._id.toHexString(),
      email: { address: `${agent.slug}@agents.barkan.dev` }
    });

    await close();
  });

  it("sends email, SMS, phone calls, and exposes approval and audit tools", async () => {
    const { agent, token } = await createAgent({ email: true, phone: true });
    const { client, close } = await connectMcpClient(token);

    const email = await client.callTool({
      name: "barkan_email_send",
      arguments: { to: "person@example.com", subject: "Hello", body: "Hi there" }
    });
    expect(email.structuredContent).toMatchObject({ ok: true });

    const sms = await client.callTool({
      name: "barkan_sms_send",
      arguments: { to: "+14155550199", body: "Code is 123456" }
    });
    expect(sms.structuredContent).toMatchObject({ message: { counterparty_e164: "+14155550199", status: "sent" } });

    const call = await client.callTool({
      name: "barkan_phone_call",
      arguments: { to: "+14155550198", task: "Ask for hours" }
    });
    expect(call.structuredContent).toMatchObject({ ok: true, simulated: true, to: "+14155550198" });

    const approvalId = new ObjectId();
    const now = new Date();
    await database.collections.approvals.insertOne({
      _id: approvalId,
      agentId: agent._id,
      ownerUserId: new ObjectId(),
      kind: "email.send",
      status: "pending",
      payloadSummary: "Send email",
      payload: { to: "person@example.com" },
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now
    });
    const approval = await client.callTool({
      name: "barkan_approval_status",
      arguments: { approval_id: approvalId.toHexString() }
    });
    expect(approval.structuredContent).toMatchObject({ approval: { status: "pending" } });

    await recordAudit(database.collections, {
      agentId: agent._id,
      ownerUserId: agent.ownerUserId,
      actor: "agent",
      action: AUDIT_ACTIONS.identity.init,
      status: "allowed",
      detail: "MCP test audit"
    });
    const audit = await client.callTool({ name: "barkan_audit_recent", arguments: { limit: 5 } });
    expect(JSON.stringify(audit.structuredContent)).toContain("MCP test audit");

    await close();
  });

  it("returns policy blocks as tool results, not protocol errors", async () => {
    const { token } = await createAgent({ email: true, phone: false, blockedRecipient: "blocked@example.com" });
    const { client, close } = await connectMcpClient(token);

    const blocked = await client.callTool({
      name: "barkan_email_send",
      arguments: { to: "blocked@example.com", subject: "Blocked", body: "Nope" }
    });
    expect(blocked.isError).not.toBe(true);
    expect(blocked.structuredContent).toMatchObject({ ok: false, code: "policy_blocked" });

    await close();
  });

  it("returns pending approval immediately for email replies by default", async () => {
    const { agent, token } = await createAgent({ email: true, phone: false });
    const { client, close } = await connectMcpClient(token);
    const sent = await client.callTool({
      name: "barkan_email_send",
      arguments: { to: "person@example.com", subject: "Reply gate", body: "Opening" }
    });
    const threadId = (sent.structuredContent as { thread_id: string }).thread_id;
    await database.collections.policies.updateOne(
      { agentId: agent._id },
      { $set: { "email.requireApproval": "always", updatedAt: new Date() } }
    );

    const reply = await client.callTool({
      name: "barkan_email_reply",
      arguments: { thread_id: threadId, body: "Needs approval" }
    });

    expect(reply.isError).not.toBe(true);
    expect(reply.structuredContent).toMatchObject({
      ok: false,
      status: "approval_required",
      decision: "pending",
      polling_required: false,
      will_execute_on_approval: true
    });
    const approvalId = (reply.structuredContent as { approval_id?: string }).approval_id;
    expect(approvalId).toBeTruthy();
    const approved = await decideApproval(database.collections, agent.ownerUserId!, approvalId!, "approved");
    expect(approved.executionResult).toMatchObject({ status: "sent", to: "person@example.com", subject: "Re: Reply gate" });
    const sentReply = await database.collections.emailMessages.findOne({
      _id: new ObjectId(approved.executionResult!.messageId as string),
      threadId: new ObjectId(threadId)
    });
    expect(sentReply).toMatchObject({ direction: "outbound", textBody: "Needs approval", status: "sent" });

    await close();
  });
});

async function connectMcpClient(token: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const app = await buildApp(config, database.collections);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "barkan-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      await app.close();
    }
  };
}

async function createAgent(input: {
  email: boolean;
  phone: boolean;
  blockedRecipient?: string;
}): Promise<{ agent: AgentDocument; token: string }> {
  const now = new Date();
  const ownerUserId = new ObjectId();
  const agent: AgentDocument = {
    _id: new ObjectId(),
    ownerUserId,
    name: "MCP Bot",
    slug: `mcp-bot-${new ObjectId().toHexString()}`,
    status: "active",
    runtime: "openclaw",
    capabilities: { email: input.email, phone: input.phone },
    approvalMode: "autonomous",
    createdAt: now,
    updatedAt: now
  };
  await database.collections.agents.insertOne(agent);
  await database.collections.billingAccounts.insertOne({
    _id: new ObjectId(),
    ownerUserId,
    stripeCustomerId: `cus_${ownerUserId.toHexString()}`,
    plan: "pro",
    subscriptionStatus: "active",
    createdAt: now,
    updatedAt: now
  });
  await database.collections.policies.insertOne({
    _id: new ObjectId(),
    agentId: agent._id,
    email: {
      ...defaultEmailPolicy(agent.approvalMode),
      requireApproval: "never",
      blockedRecipients: input.blockedRecipient ? [input.blockedRecipient] : []
    },
    phone: {
      ...defaultPhonePolicy(),
      requireApprovalOutboundCall: "never",
      requireApprovalSms: "never"
    },
    createdAt: now,
    updatedAt: now
  });
  if (input.email) {
    await database.collections.emailAccounts.insertOne({
      _id: new ObjectId(),
      agentId: agent._id,
      address: `${agent.slug}@agents.barkan.dev`,
      displayName: "MCP Bot",
      status: "active",
      createdAt: now,
      updatedAt: now
    });
  }
  if (input.phone) {
    await database.collections.phoneNumbers.insertOne({
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
    });
  }
  const { plaintext } = await issueIdentityToken(database.collections, agent._id, "mcp test", { mode: "test" });
  return { agent, token: plaintext };
}
