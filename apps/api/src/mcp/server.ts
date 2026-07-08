import { createRequire } from "node:module";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ObjectId } from "mongodb";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { authenticateAgentRequest, type AgentAuthContext } from "../agent-auth.js";
import { serializeAuditEntry, listAuditEntries } from "../audit.js";
import type { AppConfig } from "../config.js";
import type { AgentDocument, ApprovalDocument, Collections, EmailMessageDocument, EmailThreadDocument } from "../db.js";
import { ApiError } from "../errors.js";
import {
  getAgentEmailThread,
  listAgentEmailThreads,
  replyToAgentEmailThread,
  sendAgentEmailWithPolicy
} from "../email-service.js";
import { getEmailPolicy, getPhonePolicy } from "../policies.js";
import type { EmailProvider } from "../providers/email-provider.js";
import { capabilityProvisioningSummary } from "../provisioning.js";
import { getAgentPhoneCall, placeOutboundCall, serializePhoneCall } from "../phone-service.js";
import {
  findLatestSmsCode,
  listAgentSmsConversation,
  sendAgentSmsWithPolicy,
  serializeSmsMessage
} from "../sms-service.js";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as { version?: string };

const maxApprovalWaitMs = 120_000;

export function registerMcpRoutes(
  app: FastifyInstance,
  collections: Collections,
  config: AppConfig,
  emailProvider: EmailProvider
): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const authContext = await authenticateAgentRequest(request, collections);
    if (!authContext) {
      reply.hijack();
      reply.raw.writeHead(401, { "content-type": "application/json; charset=utf-8" });
      reply.raw.end(JSON.stringify(jsonRpcError("unauthorized", "missing or invalid identity token")));
      return;
    }

    const server = await buildBarkanMcpServer(collections, config, emailProvider, authContext);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  };

  app.get("/mcp", handler);
  app.post("/mcp", handler);
}

async function buildBarkanMcpServer(
  collections: Collections,
  config: AppConfig,
  emailProvider: EmailProvider,
  authContext: AgentAuthContext
): Promise<McpServer> {
  const server = new McpServer({
    name: "barkan",
    version: packageJson.version ?? "0.0.0"
  });
  const { agent, token } = authContext;

  server.registerTool(
    "barkan_whoami",
    {
      title: "Who am I",
      description: "Return the authenticated Barkan agent identity and token scope."
    },
    async () => toolOk(await identityPayload(collections, agent, token.prefix))
  );

  if (agent.capabilities.email) {
    registerEmailTools(server, collections, config, emailProvider, agent);
  }
  if (agent.capabilities.phone) {
    registerPhoneTools(server, collections, config, agent);
  }

  server.registerTool(
    "barkan_approval_status",
    {
      title: "Approval status",
      description: "Read an owner approval request by id.",
      inputSchema: { approval_id: z.string().min(1) }
    },
    async ({ approval_id }) => withToolErrors(async () => {
      const approval = await loadAgentApproval(collections, agent, approval_id);
      return toolOk({ approval: serializeApproval(approval) });
    })
  );

  server.registerTool(
    "barkan_audit_recent",
    {
      title: "Recent audit entries",
      description: "List recent audit entries for this agent identity.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() }
    },
    async ({ limit }) => withToolErrors(async () => {
      const entries = await recentAudit(collections, agent, limit ?? 25);
      return toolOk({ entries });
    })
  );

  registerResources(server, collections, agent, token.prefix);
  return server;
}

function registerEmailTools(
  server: McpServer,
  collections: Collections,
  config: AppConfig,
  emailProvider: EmailProvider,
  agent: AgentDocument
): void {
  server.registerTool(
    "barkan_email_send",
    {
      title: "Send email",
      description: "Send an email as this agent identity.",
      inputSchema: {
        to: z.string().email(),
        subject: z.string().min(1).max(200),
        body: z.string().min(1).max(10_000),
        wait_for_approval: z.boolean().optional()
      }
    },
    async ({ to, subject, body, wait_for_approval }) => withToolErrors(async () => {
      const result = await sendAgentEmailWithPolicy(collections, config, emailProvider, {
        agent,
        to,
        subject,
        text: body
      }, approvalOptions(wait_for_approval));
      return emailSendResult(result);
    })
  );

  server.registerTool(
    "barkan_email_list_threads",
    {
      title: "List email threads",
      description: "List recent email threads for this agent identity.",
      inputSchema: { cursor: z.string().optional() }
    },
    async ({ cursor }) => withToolErrors(async () => toolOk(await listAgentEmailThreads(collections, agent, cursor)))
  );

  server.registerTool(
    "barkan_email_read_thread",
    {
      title: "Read email thread",
      description: "Read messages in an email thread.",
      inputSchema: { thread_id: z.string().min(1) }
    },
    async ({ thread_id }) => withToolErrors(async () => {
      const { thread, messages } = await getAgentEmailThread(collections, agent, thread_id);
      return toolOk(serializeEmailThread(thread, messages));
    })
  );

  server.registerTool(
    "barkan_email_reply",
    {
      title: "Reply to email thread",
      description: "Reply to an existing email thread.",
      inputSchema: {
        thread_id: z.string().min(1),
        body: z.string().min(1).max(10_000),
        wait_for_approval: z.boolean().optional()
      }
    },
    async ({ thread_id, body, wait_for_approval }) => withToolErrors(async () => {
      const result = await replyToAgentEmailThread(collections, config, emailProvider, {
        agent,
        threadId: thread_id,
        text: body
      }, approvalOptions(wait_for_approval));
      return emailSendResult(result);
    })
  );
}

function registerPhoneTools(
  server: McpServer,
  collections: Collections,
  config: AppConfig,
  agent: AgentDocument
): void {
  server.registerTool(
    "barkan_phone_call",
    {
      title: "Place phone call",
      description: "Place an outbound phone call as this agent identity.",
      inputSchema: {
        to: z.string().min(3).max(40),
        task: z.string().min(1).max(5000),
        context: z.string().max(8000).optional(),
        recipient_name: z.string().max(200).optional(),
        wait_for_approval: z.boolean().optional()
      }
    },
    async ({ to, task, context, recipient_name, wait_for_approval }) => withToolErrors(async () => {
      const result = await placeOutboundCall(collections, config, {
        agent,
        toNumber: to,
        task,
        context,
        recipientName: recipient_name
      }, approvalOptions(wait_for_approval));
      if ("approvalRequired" in result) {
        return toolOk(approvalPending(result.approval, result.decision));
      }
      return toolOk({ ok: true, ...result });
    })
  );

  server.registerTool(
    "barkan_phone_get_call",
    {
      title: "Get phone call",
      description: "Read phone call status and transcript.",
      inputSchema: { call_id: z.string().min(1) }
    },
    async ({ call_id }) => withToolErrors(async () => {
      const call = await getAgentPhoneCall(collections, agent, call_id);
      return toolOk({ call: serializePhoneCall(call) });
    })
  );

  server.registerTool(
    "barkan_sms_send",
    {
      title: "Send SMS",
      description: "Send an SMS as this agent identity.",
      inputSchema: {
        to: z.string().min(3).max(40),
        body: z.string().min(1).max(1600),
        wait_for_approval: z.boolean().optional()
      }
    },
    async ({ to, body, wait_for_approval }) => withToolErrors(async () => {
      const result = await sendAgentSmsWithPolicy(collections, config, {
        agent,
        to,
        body
      }, approvalOptions(wait_for_approval));
      if ("approvalRequired" in result) {
        return toolOk(approvalPending(result.approval, result.decision));
      }
      return toolOk({ message: serializeSmsMessage(result) });
    })
  );

  server.registerTool(
    "barkan_sms_conversation",
    {
      title: "Read SMS conversation",
      description: "List SMS messages with one counterparty.",
      inputSchema: {
        with: z.string().min(3).max(40),
        cursor: z.string().optional()
      }
    },
    async (input) => withToolErrors(async () => {
      const page = await listAgentSmsConversation(collections, agent, input);
      return toolOk({ messages: page.messages.map(serializeSmsMessage), next_cursor: page.nextCursor });
    })
  );

  server.registerTool(
    "barkan_sms_latest_code",
    {
      title: "Latest SMS code",
      description: "Extract the latest 4-8 digit code from inbound SMS.",
      inputSchema: {
        from: z.string().min(3).max(40).optional(),
        since_minutes: z.number().int().min(1).max(1440).optional()
      }
    },
    async ({ from, since_minutes }) => withToolErrors(async () => {
      const since = since_minutes ? new Date(Date.now() - since_minutes * 60_000) : null;
      const code = await findLatestSmsCode(collections, agent, { from, since });
      return toolOk({ code: code.code, from: code.from, received_at: code.receivedAt.toISOString() });
    })
  );
}

function registerResources(
  server: McpServer,
  collections: Collections,
  agent: AgentDocument,
  tokenPrefix: string
): void {
  server.registerResource(
    "identity",
    "barkan://identity",
    { title: "Barkan identity", mimeType: "application/json" },
    async () => resourceJson("barkan://identity", await identityPayload(collections, agent, tokenPrefix))
  );

  server.registerResource(
    "policies",
    "barkan://policies",
    { title: "Barkan policies", mimeType: "application/json" },
    async () => resourceJson("barkan://policies", await policiesPayload(collections, agent))
  );

  server.registerResource(
    "audit_recent",
    "barkan://audit/recent",
    { title: "Barkan recent audit", mimeType: "application/json" },
    async () => resourceJson("barkan://audit/recent", { entries: await recentAudit(collections, agent, 25) })
  );
}

function approvalOptions(waitForApproval: boolean | undefined) {
  return waitForApproval === true
    ? { waitMs: maxApprovalWaitMs }
    : { async: true };
}

async function emailSendResult(
  result: Awaited<ReturnType<typeof sendAgentEmailWithPolicy>>
): Promise<CallToolResult> {
  if (result.approvalRequired) {
    return toolOk(approvalPending(result.approval, result.decision));
  }
  return toolOk({
    ok: true,
    replayed: result.replayed,
    message: serializeEmailMessage(result.message),
    thread_id: result.thread._id.toHexString()
  });
}

async function withToolErrors(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiError && (error.code === "policy_blocked" || error.code === "approval_required")) {
      return toolOk({ ok: false, code: error.code, message: error.message });
    }
    if (error instanceof ApiError) {
      return toolError(error.code, error.message);
    }
    return toolError("internal", (error as Error).message || "internal error");
  }
}

function toolOk(structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent
  };
}

function toolError(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { ok: false, code, message }
  };
}

function resourceJson(uri: string, payload: Record<string, unknown>): ReadResourceResult {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(payload, null, 2)
    }]
  };
}

function jsonRpcError(code: string, message: string) {
  return {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32001, message, data: { code } }
  };
}

async function identityPayload(collections: Collections, agent: AgentDocument, tokenPrefix: string) {
  return {
    agent_id: agent._id.toHexString(),
    owner_user_id: agent.ownerUserId?.toHexString() ?? null,
    name: agent.name,
    slug: agent.slug,
    status: agent.status,
    runtime: agent.runtime ?? null,
    capabilities: agent.capabilities,
    approval_mode: agent.approvalMode,
    token_prefix: tokenPrefix,
    provisioning: await capabilityProvisioningSummary(agent),
    email: await emailAccountPayload(collections, agent),
    phone: await phoneNumberPayload(collections, agent)
  };
}

async function policiesPayload(collections: Collections, agent: AgentDocument) {
  const [email, phone] = await Promise.all([
    getEmailPolicy(collections, agent),
    getPhonePolicy(collections, agent)
  ]);
  return { agent_id: agent._id.toHexString(), email, phone };
}

async function recentAudit(collections: Collections, agent: AgentDocument, limit: number) {
  const { entries, nextCursor } = await listAuditEntries(collections, { agentId: agent._id, limit });
  return {
    entries: entries.map(serializeAuditEntry),
    next_cursor: nextCursor
  };
}

async function emailAccountPayload(collections: Collections, agent: AgentDocument) {
  const account = await collections.emailAccounts.findOne({ agentId: agent._id });
  return account
    ? {
        address: account.address,
        display_name: account.displayName,
        status: account.status,
        created_at: account.createdAt.toISOString()
      }
    : null;
}

async function phoneNumberPayload(collections: Collections, agent: AgentDocument) {
  const phoneNumber = await collections.phoneNumbers.findOne({ agentId: agent._id, status: { $in: ["provisioning", "active", "releasing"] } });
  return phoneNumber
    ? {
        e164: phoneNumber.e164,
        country: phoneNumber.country,
        status: phoneNumber.status,
        capabilities: { voice: phoneNumber.capabilitiesVoice, sms: phoneNumber.capabilitiesSms },
        created_at: phoneNumber.createdAt.toISOString()
      }
    : null;
}

async function loadAgentApproval(collections: Collections, agent: AgentDocument, approvalId: string): Promise<ApprovalDocument> {
  if (!ObjectId.isValid(approvalId)) {
    throw new ApiError(404, "not_found", "approval not found");
  }
  const approval = await collections.approvals.findOne({ _id: new ObjectId(approvalId), agentId: agent._id });
  if (!approval) {
    throw new ApiError(404, "not_found", "approval not found");
  }
  return approval;
}

function approvalPending(approval: ApprovalDocument, decision: "pending" | "timeout" | "expired") {
  return {
    ok: false,
    status: "approval_required",
    decision,
    approval_id: approval._id.toHexString(),
    approval: serializeApproval(approval)
  };
}

function serializeApproval(approval: ApprovalDocument) {
  return {
    id: approval._id.toHexString(),
    kind: approval.kind,
    status: approval.status,
    payload_summary: approval.payloadSummary,
    payload: approval.payload,
    decision_note: approval.decisionNote ?? null,
    execution_result: approval.executionResult ?? null,
    execution_error: approval.executionError ?? null,
    decided_at: approval.decidedAt?.toISOString() ?? null,
    expires_at: approval.expiresAt.toISOString(),
    created_at: approval.createdAt.toISOString(),
    updated_at: approval.updatedAt.toISOString()
  };
}

function serializeEmailThread(thread: EmailThreadDocument, messages: EmailMessageDocument[]) {
  return {
    thread: {
      id: thread._id.toHexString(),
      counterparty: thread.counterpartyEmail,
      subject: thread.subject,
      last_message_at: thread.lastMessageAt.toISOString(),
      message_count: thread.messageCount
    },
    messages: messages.map(serializeEmailMessage)
  };
}

function serializeEmailMessage(message: EmailMessageDocument) {
  return {
    id: message._id.toHexString(),
    thread_id: message.threadId.toHexString(),
    direction: message.direction,
    from_email: message.fromEmail,
    to_email: message.toEmail,
    cc: message.cc ?? [],
    subject: message.subject,
    body: message.textBody,
    html: message.htmlBody ?? null,
    provider_message_id: message.providerMessageId ?? null,
    status: message.status,
    parsed_by: message.parsedBy ?? null,
    summary: message.summary ?? null,
    suggested_reply: message.suggestedReply ?? null,
    attachments: (message.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      content_type: attachment.contentType,
      size_bytes: attachment.sizeBytes,
      id: attachment.providerAttachmentId ?? null
    })),
    created_at: message.createdAt.toISOString()
  };
}
