import { MongoServerError, ObjectId } from "mongodb";
import type { AppConfig } from "./config.js";
import type { AgentDocument, ApprovalDocument, Collections, EmailMessageDocument, EmailThreadDocument } from "./db.js";
import { AUDIT_ACTIONS, recordAudit } from "./audit.js";
import { emitOwnerEvent, registerApprovalExecutor, requestApproval, waitForDecision } from "./approvals.js";
import { ApiError } from "./errors.js";
import type { EmailAttachmentInput, EmailInboundClient, EmailProvider, ReceivedEmailContent } from "./providers/email-provider.js";
import { getEmailPolicy, isRecipientAllowedByPatterns } from "./policies.js";

export interface SendAgentEmailInput {
  agent: AgentDocument;
  actor?: "agent" | "owner";
  to: string;
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachmentInput[];
  headers?: Record<string, string>;
  threadId?: string;
  idempotencyKey?: string;
  parsedBy?: "openai" | "heuristic" | null;
}

export interface EmailApprovalOptions {
  waitMs?: number;
  async?: boolean;
}

export interface SendAgentEmailResult {
  message: EmailMessageDocument;
  thread: EmailThreadDocument;
  replayed: boolean;
}

export type PolicySendAgentEmailResult =
  | ({ approvalRequired: false } & SendAgentEmailResult)
  | { approvalRequired: true; approval: ApprovalDocument; decision: "pending" | "timeout" | "expired" };

export interface IngestResendEmailResult {
  status: "received" | "skipped";
  message?: EmailMessageDocument;
  reason?: string;
}

export async function sendAgentEmail(
  collections: Collections,
  config: AppConfig,
  provider: EmailProvider,
  input: SendAgentEmailInput
): Promise<SendAgentEmailResult> {
  const now = new Date();
  const idempotencyKey = input.idempotencyKey?.trim() || undefined;
  if (idempotencyKey) {
    const existing = await collections.emailMessages.findOne({ agentId: input.agent._id, idempotencyKey });
    if (existing) {
      const existingThread = await collections.emailThreads.findOne({ _id: existing.threadId, agentId: input.agent._id });
      if (!existingThread) {
        throw new ApiError(500, "internal", "idempotent email message is missing its thread");
      }
      return { message: existing, thread: existingThread, replayed: true };
    }
  }

  const account = await collections.emailAccounts.findOne({ agentId: input.agent._id });
  if (!account) {
    throw new ApiError(409, "validation_failed", "agent does not have an email address");
  }
  if (account.status !== "active") {
    throw new ApiError(403, "policy_blocked", "email identity is paused");
  }

  const to = normalizeEmailAddress(input.to);
  const thread = await resolveThread(collections, input.agent, {
    threadId: input.threadId,
    counterpartyEmail: to,
    subject: input.subject,
    now
  });

  const messageId = new ObjectId();
  const outboundHeaders = normalizeHeaders({
    ...(input.headers ?? {}),
    "Message-ID": input.headers?.["Message-ID"] ?? input.headers?.["message-id"] ?? `<${messageId.toHexString()}@${config.EMAIL_AGENT_DOMAIN}>`
  });
  const message: EmailMessageDocument = {
    _id: messageId,
    agentId: input.agent._id,
    threadId: thread._id,
    direction: "outbound",
    fromEmail: account.address,
    toEmail: to,
    ...(input.cc?.length ? { cc: input.cc.map(normalizeEmailAddress) } : {}),
    subject: input.subject,
    textBody: input.text,
    ...(input.html ? { htmlBody: input.html } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    parsedBy: input.parsedBy ?? null,
    headers: outboundHeaders,
    status: "queued",
    attachments: input.attachments?.map((attachment) => ({
      filename: typeof attachment.filename === "string" ? attachment.filename : "attachment",
      contentType: attachment.contentType ?? "application/octet-stream",
      sizeBytes: readAttachmentSize(attachment)
    })),
    createdAt: now,
    updatedAt: now
  };

  try {
    await collections.emailMessages.insertOne(message);
  } catch (error) {
    if (idempotencyKey && isDuplicateKey(error)) {
      const existing = await collections.emailMessages.findOne({ agentId: input.agent._id, idempotencyKey });
      const existingThread = existing
        ? await collections.emailThreads.findOne({ _id: existing.threadId, agentId: input.agent._id })
        : null;
      if (existing && existingThread) {
        return { message: existing, thread: existingThread, replayed: true };
      }
    }
    throw error;
  }

  try {
    const sendResult = await provider.sendEmail({
      from: formatFrom(input.agent.name, account.address),
      to,
      cc: input.cc?.map(normalizeEmailAddress),
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments,
      headers: {
        ...outboundHeaders,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
      }
    });
    const sentAt = new Date();
    const updated = await collections.emailMessages.findOneAndUpdate(
      { _id: message._id },
      {
        $set: {
          providerMessageId: sendResult.providerMessageId,
          status: "sent",
          updatedAt: sentAt
        }
      },
      { returnDocument: "after" }
    );
    await bumpThread(collections, thread._id, sentAt);
    await recordAudit(collections, {
      agentId: input.agent._id,
      ownerUserId: input.agent.ownerUserId,
      actor: input.actor ?? "agent",
      action: AUDIT_ACTIONS.email.send,
      status: "allowed",
      detail: `Email sent to ${to}: ${input.subject}`,
      resourceType: "emailMessage",
      resourceId: message._id.toHexString(),
      metadata: { providerMessageId: sendResult.providerMessageId }
    });
    recordEmailUsageEvent();
    return { message: updated ?? { ...message, providerMessageId: sendResult.providerMessageId, status: "sent", updatedAt: sentAt }, thread, replayed: false };
  } catch (error) {
    const failedAt = new Date();
    const messageText = (error as Error).message;
    await collections.emailMessages.updateOne(
      { _id: message._id },
      { $set: { status: "failed", providerError: messageText, updatedAt: failedAt } }
    );
    await bumpThread(collections, thread._id, failedAt);
    throw new ApiError(502, "provider_error", `email provider error: ${messageText}`);
  }
}

export async function sendAgentEmailWithPolicy(
  collections: Collections,
  config: AppConfig,
  provider: EmailProvider,
  input: SendAgentEmailInput,
  approvalOptions: EmailApprovalOptions = {}
): Promise<PolicySendAgentEmailResult> {
  const policyDecision = await evaluateEmailPolicy(collections, input);
  if (policyDecision.type === "blocked") {
    await auditEmailBlocked(collections, input, policyDecision.reason);
    throw new ApiError(403, "policy_blocked", policyDecision.reason);
  }
  if (policyDecision.type === "allowed") {
    return { approvalRequired: false, ...(await sendAgentEmail(collections, config, provider, input)) };
  }
  if (!input.agent.ownerUserId) {
    const reason = "email approval requires an owner user";
    await auditEmailBlocked(collections, input, reason);
    throw new ApiError(403, "policy_blocked", reason);
  }

  const approval = await requestApproval(collections, {
    agentId: input.agent._id,
    ownerUserId: input.agent.ownerUserId,
    kind: "email.send",
    payloadSummary: `Send email to ${normalizeEmailAddress(input.to)}: ${input.subject}`,
    payload: serializeSendPayload(input)
  });
  if (approvalOptions.async) {
    return { approvalRequired: true, approval, decision: "pending" };
  }

  const decision = await waitForDecision(collections, approval._id, {
    timeoutMs: approvalOptions.waitMs ?? 90_000
  });
  const updated = await collections.approvals.findOne({ _id: approval._id }) ?? approval;
  if (decision === "approved" && updated.executionResult) {
    const messageId = updated.executionResult.messageId;
    const message = typeof messageId === "string" && ObjectId.isValid(messageId)
      ? await collections.emailMessages.findOne({ _id: new ObjectId(messageId), agentId: input.agent._id })
      : null;
    const thread = message
      ? await collections.emailThreads.findOne({ _id: message.threadId, agentId: input.agent._id })
      : null;
    if (message && thread) {
      return { approvalRequired: false, message, thread, replayed: false };
    }
  }
  if (decision === "rejected") {
    throw new ApiError(403, "approval_required", "email send was rejected");
  }
  if (decision === "expired") {
    throw new ApiError(403, "approval_required", "email send approval expired");
  }
  return { approvalRequired: true, approval: updated, decision: decision === "timeout" ? "timeout" : "pending" };
}

export function registerEmailApprovalExecutor(collections: Collections, config: AppConfig, provider: EmailProvider): void {
  registerApprovalExecutor("email.send", async (approval) => {
    const agent = await collections.agents.findOne({ _id: approval.agentId, status: { $ne: "revoked" } });
    if (!agent) {
      throw new Error("agent not found");
    }
    const input = parseApprovalSendPayload(agent, approval.payload);
    const { message, thread } = await sendAgentEmail(collections, config, provider, input);
    return {
      messageId: message._id.toHexString(),
      threadId: thread._id.toHexString(),
      status: message.status,
      to: message.toEmail,
      subject: message.subject
    };
  });
}

export async function ingestResendReceivedEmail(
  collections: Collections,
  config: AppConfig,
  inboundClient: EmailInboundClient,
  payload: unknown
): Promise<IngestResendEmailResult> {
  const emailId = readInboundEmailId(payload);
  if (!emailId) {
    return { status: "skipped", reason: "missing email_id" };
  }
  const content = await inboundClient.getReceivedEmail(emailId);
  const account = await resolveInboundAccount(collections, content);
  if (!account) {
    await recordAudit(collections, {
      agentId: new ObjectId(),
      actor: "system",
      action: AUDIT_ACTIONS.email.receiveUnrouted,
      status: "blocked",
      detail: `Inbound email ${emailId} was not addressed to an active agent.`,
      metadata: { emailId, recipients: recipientCandidates(content) }
    });
    return { status: "skipped", reason: "no active recipient" };
  }
  const agent = await collections.agents.findOne({ _id: account.agentId });
  if (!agent) {
    return { status: "skipped", reason: "agent not found" };
  }
  const from = extractEmailAddress(content.from).toLowerCase();
  const now = new Date();
  const thread = await resolveInboundThread(collections, agent, content, from, now);
  const summary = summarizeHeuristic(content.text || content.html || "");
  const message: EmailMessageDocument = {
    _id: new ObjectId(),
    agentId: agent._id,
    threadId: thread._id,
    direction: "inbound",
    fromEmail: from,
    toEmail: account.address,
    cc: content.cc.map(extractEmailAddress).map((value) => value.toLowerCase()),
    subject: content.subject || "(no subject)",
    textBody: content.text,
    ...(content.html ? { htmlBody: content.html } : {}),
    providerMessageId: content.id,
    headers: content.headers,
    status: "received",
    attachments: content.attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      providerAttachmentId: attachment.id
    })),
    summary,
    suggestedReply: "Thanks for getting back to me. I'll follow up shortly.",
    createdAt: now,
    updatedAt: now
  };
  await collections.emailMessages.insertOne(message);
  await bumpThread(collections, thread._id, now);
  await recordAudit(collections, {
    agentId: agent._id,
    ownerUserId: agent.ownerUserId,
    actor: "system",
    action: AUDIT_ACTIONS.email.receive,
    status: "allowed",
    detail: `Reply from ${from}: ${summary}`,
    resourceType: "emailMessage",
    resourceId: message._id.toHexString(),
    metadata: { emailId }
  });
  if (agent.ownerUserId) {
    emitOwnerEvent(agent.ownerUserId, "email.received", {
      agentId: agent._id.toHexString(),
      threadId: thread._id.toHexString(),
      messageId: message._id.toHexString(),
      from,
      subject: message.subject,
      summary
    });
  }
  return { status: "received", message };
}

export async function listAgentEmailThreads(collections: Collections, agent: AgentDocument, cursor?: string) {
  const query = {
    agentId: agent._id,
    ...(cursor && ObjectId.isValid(cursor) ? { _id: { $lt: new ObjectId(cursor) } } : {})
  };
  const threads = await collections.emailThreads.find(query).sort({ lastMessageAt: -1, _id: -1 }).limit(25).toArray();
  const unreadCounts = await collections.emailMessages.aggregate<{ _id: ObjectId; count: number }>([
    { $match: { agentId: agent._id, direction: "inbound", readAt: { $exists: false } } },
    { $group: { _id: "$threadId", count: { $sum: 1 } } }
  ]).toArray();
  const unreadByThread = Object.fromEntries(unreadCounts.map((entry) => [entry._id.toHexString(), entry.count]));
  return {
    threads: threads.map((thread) => ({
      id: thread._id.toHexString(),
      counterparty: thread.counterpartyEmail,
      subject: thread.subject,
      lastMessageAt: thread.lastMessageAt.toISOString(),
      unreadCount: unreadByThread[thread._id.toHexString()] ?? 0
    })),
    nextCursor: threads.length === 25 ? threads[threads.length - 1]!._id.toHexString() : null
  };
}

export async function getAgentEmailThread(collections: Collections, agent: AgentDocument, threadId: string) {
  const thread = await loadAgentThread(collections, agent, threadId);
  const messages = await collections.emailMessages.find({ agentId: agent._id, threadId: thread._id }).sort({ createdAt: 1 }).toArray();
  await collections.emailMessages.updateMany(
    { agentId: agent._id, threadId: thread._id, direction: "inbound", readAt: { $exists: false } },
    { $set: { readAt: new Date() } }
  );
  return { thread, messages };
}

export async function replyToAgentEmailThread(
  collections: Collections,
  config: AppConfig,
  provider: EmailProvider,
  input: { agent: AgentDocument; actor?: "agent" | "owner"; threadId: string; text: string; idempotencyKey?: string },
  approvalOptions: EmailApprovalOptions = {}
) {
  const { thread, messages } = await getAgentEmailThread(collections, input.agent, input.threadId);
  const lastInbound = [...messages].reverse().find((message) => message.direction === "inbound");
  const headers: Record<string, string> = {};
  const messageId = lastInbound?.headers?.["message-id"] ?? lastInbound?.providerMessageId;
  if (messageId) {
    headers["In-Reply-To"] = messageId;
    headers.References = [lastInbound?.headers?.references, messageId].filter(Boolean).join(" ");
  }
  return sendAgentEmailWithPolicy(collections, config, provider, {
    agent: input.agent,
    actor: input.actor ?? "agent",
    to: thread.counterpartyEmail,
    subject: thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`,
    text: input.text,
    threadId: thread._id.toHexString(),
    idempotencyKey: input.idempotencyKey,
    headers
  }, approvalOptions);
}

async function evaluateEmailPolicy(
  collections: Collections,
  input: SendAgentEmailInput
): Promise<{ type: "allowed" } | { type: "approval_required" } | { type: "blocked"; reason: string }> {
  const policy = await getEmailPolicy(collections, input.agent);
  const recipients = [input.to, ...(input.cc ?? [])].map(normalizeEmailAddress);
  if (recipients.length > policy.maxRecipientsPerMessage) {
    return { type: "blocked", reason: `email has ${recipients.length} recipients; limit is ${policy.maxRecipientsPerMessage}` };
  }
  const blocked = recipients.find((recipient) => isRecipientAllowedByPatterns(recipient, policy.blockedRecipients));
  if (blocked) {
    return { type: "blocked", reason: `${blocked} is blocked by email policy` };
  }
  if (policy.allowedRecipients.length > 0) {
    const disallowed = recipients.find((recipient) => !isRecipientAllowedByPatterns(recipient, policy.allowedRecipients));
    if (disallowed) {
      return { type: "blocked", reason: `${disallowed} is not in the allowed recipients policy` };
    }
  }
  const todaySent = await collections.emailMessages.countDocuments({
    agentId: input.agent._id,
    direction: "outbound",
    status: { $in: ["sent", "delivered"] },
    createdAt: { $gte: startOfUtcDay(new Date()) }
  });
  if (todaySent >= policy.dailySendLimit) {
    return { type: "blocked", reason: `daily email send limit of ${policy.dailySendLimit} reached` };
  }
  if (policy.requireApproval === "never") {
    return { type: "allowed" };
  }
  if (policy.requireApproval === "always") {
    return { type: "approval_required" };
  }
  const knownRecipientCount = await collections.emailMessages.countDocuments({
    agentId: input.agent._id,
    direction: "outbound",
    toEmail: normalizeEmailAddress(input.to),
    status: { $in: ["sent", "delivered"] }
  });
  return knownRecipientCount > 0 ? { type: "allowed" } : { type: "approval_required" };
}

async function auditEmailBlocked(collections: Collections, input: SendAgentEmailInput, reason: string): Promise<void> {
  await recordAudit(collections, {
    agentId: input.agent._id,
    ownerUserId: input.agent.ownerUserId,
    actor: input.actor ?? "agent",
    action: AUDIT_ACTIONS.email.blocked,
    status: "blocked",
    detail: reason
  });
}

export function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function serializeSendPayload(input: SendAgentEmailInput): Record<string, unknown> {
  return {
    to: input.to,
    cc: input.cc ?? [],
    subject: input.subject,
    text: input.text,
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.html ? { html: input.html } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.headers ? { headers: input.headers } : {})
  };
}

function parseApprovalSendPayload(agent: AgentDocument, payload: Record<string, unknown>): SendAgentEmailInput {
  const to = String(payload.to ?? "");
  const subject = String(payload.subject ?? "");
  const text = String(payload.text ?? "");
  if (!to || !subject || !text) {
    throw new Error("approval payload is missing email send fields");
  }
  return {
    agent,
    actor: payload.actor === "owner" ? "owner" : "agent",
    to,
    cc: Array.isArray(payload.cc) ? payload.cc.map(String) : undefined,
    subject,
    text,
    html: typeof payload.html === "string" ? payload.html : undefined,
    threadId: typeof payload.threadId === "string" ? payload.threadId : undefined,
    idempotencyKey: typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : undefined,
    headers: payload.headers && typeof payload.headers === "object" && !Array.isArray(payload.headers)
      ? payload.headers as Record<string, string>
      : undefined
  };
}

async function resolveThread(
  collections: Collections,
  agent: AgentDocument,
  input: { threadId?: string; counterpartyEmail: string; subject: string; now: Date }
): Promise<EmailThreadDocument> {
  if (input.threadId) {
    if (!ObjectId.isValid(input.threadId)) {
      throw new ApiError(404, "not_found", "email thread not found");
    }
    const thread = await collections.emailThreads.findOne({ _id: new ObjectId(input.threadId), agentId: agent._id });
    if (!thread) {
      throw new ApiError(404, "not_found", "email thread not found");
    }
    return thread;
  }

  const existing = await collections.emailThreads.findOne({
    agentId: agent._id,
    counterpartyEmail: input.counterpartyEmail
  });
  if (existing) {
    return existing;
  }

  const thread: EmailThreadDocument = {
    _id: new ObjectId(),
    agentId: agent._id,
    subject: input.subject,
    counterpartyEmail: input.counterpartyEmail,
    lastMessageAt: input.now,
    messageCount: 0,
    createdAt: input.now,
    updatedAt: input.now
  };
  await collections.emailThreads.insertOne(thread);
  return thread;
}

async function resolveInboundAccount(collections: Collections, content: ReceivedEmailContent) {
  for (const recipient of recipientCandidates(content)) {
    const account = await collections.emailAccounts.findOne({ address: recipient, status: "active" });
    if (account) {
      return account;
    }
  }
  return null;
}

function recipientCandidates(content: ReceivedEmailContent): string[] {
  return [...content.to, ...content.cc, ...content.receivedFor]
    .map(extractEmailAddress)
    .filter(Boolean)
    .map((address) => address.toLowerCase());
}

async function resolveInboundThread(
  collections: Collections,
  agent: AgentDocument,
  content: ReceivedEmailContent,
  from: string,
  now: Date
): Promise<EmailThreadDocument> {
  const references = [
    content.headers["in-reply-to"],
    ...(content.headers.references?.split(/\s+/) ?? [])
  ].filter(Boolean);
  if (references.length) {
    const referenced = await collections.emailMessages.findOne({
      agentId: agent._id,
      $or: [
        { providerMessageId: { $in: references } },
        { "headers.message-id": { $in: references } }
      ]
    });
    if (referenced) {
      const thread = await collections.emailThreads.findOne({ _id: referenced.threadId, agentId: agent._id });
      if (thread) {
        return thread;
      }
    }
  }
  const existing = await collections.emailThreads.findOne({ agentId: agent._id, counterpartyEmail: from });
  if (existing) {
    return existing;
  }
  const thread: EmailThreadDocument = {
    _id: new ObjectId(),
    agentId: agent._id,
    subject: content.subject || "(no subject)",
    counterpartyEmail: from,
    lastMessageAt: now,
    messageCount: 0,
    createdAt: now,
    updatedAt: now
  };
  await collections.emailThreads.insertOne(thread);
  return thread;
}

async function loadAgentThread(collections: Collections, agent: AgentDocument, threadId: string): Promise<EmailThreadDocument> {
  if (!ObjectId.isValid(threadId)) {
    throw new ApiError(404, "not_found", "email thread not found");
  }
  const thread = await collections.emailThreads.findOne({ _id: new ObjectId(threadId), agentId: agent._id });
  if (!thread) {
    throw new ApiError(404, "not_found", "email thread not found");
  }
  return thread;
}

function readInboundEmailId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : record;
  for (const key of ["email_id", "id"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function extractEmailAddress(value: string): string {
  return value.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? value.trim();
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function summarizeHeuristic(body: string): string {
  const firstLine = body.split(/\n+/).map((line) => line.trim()).find(Boolean) ?? "";
  return firstLine ? (firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine) : "(empty reply)";
}

async function bumpThread(collections: Collections, threadId: ObjectId, at: Date): Promise<void> {
  await collections.emailThreads.updateOne(
    { _id: threadId },
    { $set: { lastMessageAt: at, updatedAt: at }, $inc: { messageCount: 1 } }
  );
}

function formatFrom(name: string, address: string): string {
  return `"${name.replace(/"/g, "'")}" <${address}>`;
}

function normalizeEmailAddress(value: string): string {
  return value.trim().toLowerCase();
}

function readAttachmentSize(attachment: EmailAttachmentInput): number {
  if (Buffer.isBuffer(attachment.content)) {
    return attachment.content.byteLength;
  }
  if (typeof attachment.content === "string") {
    return Buffer.byteLength(attachment.content);
  }
  return 0;
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

function recordEmailUsageEvent(): void {
  // Usage metering lands in task 042.
}
