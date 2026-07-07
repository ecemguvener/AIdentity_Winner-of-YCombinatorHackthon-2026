import { MongoServerError, ObjectId } from "mongodb";
import type { AppConfig } from "./config.js";
import type { AgentDocument, Collections, EmailMessageDocument, EmailThreadDocument } from "./db.js";
import { AUDIT_ACTIONS, recordAudit } from "./audit.js";
import { ApiError } from "./errors.js";
import type { EmailAttachmentInput, EmailProvider } from "./providers/email-provider.js";

export interface SendAgentEmailInput {
  agent: AgentDocument;
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

export interface SendAgentEmailResult {
  message: EmailMessageDocument;
  thread: EmailThreadDocument;
  replayed: boolean;
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

  const message: EmailMessageDocument = {
    _id: new ObjectId(),
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
        ...(input.headers ?? {}),
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
      actor: "agent",
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
