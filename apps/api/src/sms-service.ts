import { ObjectId } from "mongodb";
import type { AppConfig } from "./config.js";
import type { AgentDocument, ApprovalDocument, Collections, PhoneNumberDocument, SmsMessageDocument } from "./db.js";
import { AUDIT_ACTIONS, recordAudit } from "./audit.js";
import { emitOwnerEvent, registerApprovalExecutor, requestApproval, waitForDecision } from "./approvals.js";
import { ApiError } from "./errors.js";
import { normalizeE164PhoneNumber } from "./lib/phone.js";
import { enforcePhoneCountry, startOfPolicyDay } from "./phone-policy.js";
import { getPhonePolicy } from "./policies.js";
import { sendSms as sendTwilioSms } from "./providers/twilio-sms.js";

const maxSmsBodyLength = 1600;

export interface SendAgentSmsInput {
  agent: AgentDocument;
  actor?: "agent" | "owner";
  to: string;
  body: string;
  idempotencyKey?: string | null;
}

export interface SmsApprovalOptions {
  waitMs?: number;
  async?: boolean;
}

export async function sendAgentSms(
  collections: Collections,
  config: AppConfig,
  input: SendAgentSmsInput
): Promise<SmsMessageDocument> {
  const to = normalizeE164OrThrow(input.to, "to");
  const body = input.body.trim();
  if (!body || body.length > maxSmsBodyLength) {
    throw new ApiError(400, "validation_failed", "SMS body must be 1-1600 characters");
  }
  if (input.idempotencyKey) {
    const existing = await collections.smsMessages.findOne({ agentId: input.agent._id, idempotencyKey: input.idempotencyKey });
    if (existing) return existing;
  }
  const phoneNumber = await activePhoneNumber(collections, input.agent);
  const now = new Date();
  const message: SmsMessageDocument = {
    _id: new ObjectId(),
    agentId: input.agent._id,
    phoneNumberId: phoneNumber._id,
    direction: "outbound",
    counterpartyE164: to,
    body,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    status: "queued",
    createdAt: now,
    updatedAt: now
  };
  await collections.smsMessages.insertOne(message);
  const statusCallback = `${config.PUBLIC_API_URL.replace(/\/$/, "")}/webhooks/twilio/status`;
  const sent = await sendTwilioSms(config, { from: phoneNumber.e164, to, body, statusCallback });
  const updated = await collections.smsMessages.findOneAndUpdate(
    { _id: message._id },
    { $set: { twilioMessageSid: sent.twilioMessageSid, status: "sent", updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  const finalMessage = updated ?? { ...message, twilioMessageSid: sent.twilioMessageSid, status: "sent" as const };
  await recordAudit(collections, {
    agentId: input.agent._id,
    ownerUserId: input.agent.ownerUserId,
    actor: input.actor ?? "agent",
    action: AUDIT_ACTIONS.sms.send,
    status: "allowed",
    detail: `SMS sent to ${to}.`,
    resourceType: "smsMessage",
    resourceId: finalMessage._id.toHexString(),
    metadata: { twilioMessageSid: finalMessage.twilioMessageSid ?? null }
  });
  await recordSmsUsage(collections, input.agent, new Date());
  return finalMessage;
}

export async function sendAgentSmsWithPolicy(
  collections: Collections,
  config: AppConfig,
  input: SendAgentSmsInput,
  approvalOptions: SmsApprovalOptions = {}
): Promise<SmsMessageDocument | { approvalRequired: true; approval: ApprovalDocument; decision: "pending" | "timeout" | "expired" }> {
  const to = normalizeE164OrThrow(input.to, "to");
  const body = input.body.trim();
  if (!body || body.length > maxSmsBodyLength) {
    throw new ApiError(400, "validation_failed", "SMS body must be 1-1600 characters");
  }
  await activePhoneNumber(collections, input.agent);
  const policyDecision = await evaluateSmsPolicy(collections, input);
  if (policyDecision.type === "blocked") {
    await auditSmsBlocked(collections, input, policyDecision.reason);
    throw new ApiError(403, "policy_blocked", policyDecision.reason);
  }
  if (policyDecision.type === "allowed") {
    return sendAgentSms(collections, config, input);
  }
  if (!input.agent.ownerUserId) {
    const reason = "SMS approval requires an owner user";
    await auditSmsBlocked(collections, input, reason);
    throw new ApiError(403, "policy_blocked", reason);
  }
  const approval = await requestApproval(collections, {
    agentId: input.agent._id,
    ownerUserId: input.agent.ownerUserId,
    kind: "sms.send",
    payloadSummary: `Send SMS to ${to}: ${input.body.trim().slice(0, 80)}`,
    payload: serializeSmsApprovalPayload(input)
  });
  if (approvalOptions.async) {
    return { approvalRequired: true, approval, decision: "pending" };
  }
  const decision = await waitForDecision(collections, approval._id, { timeoutMs: approvalOptions.waitMs ?? 90_000 });
  const updated = await collections.approvals.findOne({ _id: approval._id }) ?? approval;
  if (decision === "approved" && updated.executionResult) {
    const messageId = updated.executionResult.messageId;
    const message = typeof messageId === "string" && ObjectId.isValid(messageId)
      ? await collections.smsMessages.findOne({ _id: new ObjectId(messageId), agentId: input.agent._id })
      : null;
    if (message) return message;
  }
  if (decision === "rejected") {
    throw new ApiError(403, "approval_required", "SMS send was rejected");
  }
  if (decision === "expired") {
    throw new ApiError(403, "approval_required", "SMS send approval expired");
  }
  return { approvalRequired: true, approval: updated, decision: decision === "timeout" ? "timeout" : "pending" };
}

export function registerSmsApprovalExecutor(collections: Collections, config: AppConfig): void {
  registerApprovalExecutor("sms.send", async (approval) => {
    const agent = await collections.agents.findOne({ _id: approval.agentId, status: { $ne: "revoked" } });
    if (!agent) throw new Error("agent not found");
    const message = await sendAgentSms(collections, config, parseSmsApprovalPayload(agent, approval.payload));
    return {
      messageId: message._id.toHexString(),
      status: message.status,
      to: message.counterpartyE164
    };
  });
}

export async function ingestInboundSms(collections: Collections, payload: unknown): Promise<string> {
  const form = stringRecord(payload);
  const to = normalizeE164PhoneNumber(form.To ?? "");
  const from = normalizeE164PhoneNumber(form.From ?? "");
  const body = form.Body ?? "";
  const messageSid = form.MessageSid ?? "";
  if (!to || !from || !messageSid) {
    return twiml();
  }
  const phoneNumber = await collections.phoneNumbers.findOne({ e164: to, status: "active" });
  if (!phoneNumber) {
    return twiml();
  }
  const agent = await collections.agents.findOne({ _id: phoneNumber.agentId });
  if (!agent) {
    return twiml();
  }
  const existing = await collections.smsMessages.findOne({ twilioMessageSid: messageSid });
  if (existing) {
    return twiml();
  }
  const now = new Date();
  const message: SmsMessageDocument = {
    _id: new ObjectId(),
    agentId: agent._id,
    phoneNumberId: phoneNumber._id,
    direction: "inbound",
    counterpartyE164: from,
    body,
    twilioMessageSid: messageSid,
    status: "received",
    createdAt: now,
    updatedAt: now
  };
  await collections.smsMessages.insertOne(message);
  await recordAudit(collections, {
    agentId: agent._id,
    ownerUserId: agent.ownerUserId,
    actor: "system",
    action: AUDIT_ACTIONS.sms.receive,
    status: "allowed",
    detail: `SMS received from ${from}.`,
    resourceType: "smsMessage",
    resourceId: message._id.toHexString(),
    metadata: { twilioMessageSid: messageSid }
  });
  if (agent.ownerUserId) {
    emitOwnerEvent(agent.ownerUserId, "sms.received", serializeSmsMessage(message));
  }
  return twiml();
}

export async function updateSmsDeliveryStatus(collections: Collections, payload: unknown): Promise<{ ok: true; updated: boolean }> {
  const form = stringRecord(payload);
  const sid = form.MessageSid ?? form.SmsSid ?? "";
  if (!sid) return { ok: true, updated: false };
  const status = mapTwilioMessageStatus(form.MessageStatus ?? form.SmsStatus ?? "");
  const updated = await collections.smsMessages.findOneAndUpdate(
    { twilioMessageSid: sid },
    { $set: { status, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (updated && (status === "failed" || status === "undelivered")) {
    const agent = await collections.agents.findOne({ _id: updated.agentId });
    await recordAudit(collections, {
      agentId: updated.agentId,
      ownerUserId: agent?.ownerUserId,
      actor: "system",
      action: AUDIT_ACTIONS.sms.send,
      status: "blocked",
      detail: `SMS ${status}${form.ErrorCode ? ` (${form.ErrorCode})` : ""}.`,
      resourceType: "smsMessage",
      resourceId: updated._id.toHexString(),
      metadata: { twilioMessageSid: sid, errorCode: form.ErrorCode ?? null }
    });
  }
  return { ok: true, updated: Boolean(updated) };
}

export async function listAgentSmsConversation(
  collections: Collections,
  agent: AgentDocument,
  input: { with: string; cursor?: string | null; limit?: number }
): Promise<{ messages: SmsMessageDocument[]; nextCursor: string | null }> {
  const counterpartyE164 = normalizeE164OrThrow(input.with, "with");
  const limit = input.limit ?? 50;
  const query: Record<string, unknown> = { agentId: agent._id, counterpartyE164 };
  if (input.cursor && ObjectId.isValid(input.cursor)) {
    query._id = { $lt: new ObjectId(input.cursor) };
  }
  const newest = await collections.smsMessages.find(query).sort({ _id: -1 }).limit(limit + 1).toArray();
  const page = newest.slice(0, limit);
  return {
    messages: [...page].reverse(),
    nextCursor: newest.length > limit ? page.at(-1)?._id.toHexString() ?? null : null
  };
}

export async function findLatestSmsCode(
  collections: Collections,
  agent: AgentDocument,
  input: { from?: string | null; since?: Date | null } = {}
): Promise<{ code: string; receivedAt: Date; from: string }> {
  const query: Record<string, unknown> = { agentId: agent._id, direction: "inbound", status: "received" };
  if (input.from) query.counterpartyE164 = normalizeE164OrThrow(input.from, "from");
  if (input.since) query.createdAt = { $gte: input.since };
  const messages = await collections.smsMessages.find(query).sort({ createdAt: -1 }).limit(100).toArray();
  for (const message of messages) {
    const code = message.body.match(/\b\d{4,8}\b/)?.[0];
    if (code) {
      return { code, receivedAt: message.createdAt, from: message.counterpartyE164 };
    }
  }
  throw new ApiError(404, "not_found", "no recent SMS code found");
}

export function serializeSmsMessage(message: SmsMessageDocument) {
  return {
    id: message._id.toHexString(),
    direction: message.direction,
    counterparty_e164: message.counterpartyE164,
    body: message.body,
    status: message.status,
    twilio_message_sid: message.twilioMessageSid ?? null,
    created_at: message.createdAt.toISOString(),
    updated_at: message.updatedAt.toISOString()
  };
}

async function activePhoneNumber(collections: Collections, agent: AgentDocument): Promise<PhoneNumberDocument> {
  const phoneNumber = await collections.phoneNumbers.findOne({ agentId: agent._id, status: "active" });
  if (!phoneNumber) {
    throw new ApiError(409, "policy_blocked", "phone capability not provisioned");
  }
  return phoneNumber;
}

async function recordSmsUsage(collections: Collections, agent: AgentDocument, now: Date): Promise<void> {
  if (!agent.ownerUserId) return;
  await collections.usageEvents.insertOne({
    _id: new ObjectId(),
    ownerUserId: agent.ownerUserId,
    agentId: agent._id,
    meter: "sms_messages",
    quantity: 1,
    stripeReported: false,
    periodKey: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`,
    createdAt: now,
    updatedAt: now
  });
}

async function evaluateSmsPolicy(
  collections: Collections,
  input: SendAgentSmsInput
): Promise<{ type: "allowed" } | { type: "approval_required" } | { type: "blocked"; reason: string }> {
  const to = normalizeE164PhoneNumber(input.to);
  if (!to) return { type: "allowed" };
  const policy = await getPhonePolicy(collections, input.agent);
  const country = enforcePhoneCountry(policy, to);
  if (!country.ok) return { type: "blocked", reason: country.reason };
  const todaySms = await collections.smsMessages.countDocuments({
    agentId: input.agent._id,
    direction: "outbound",
    createdAt: { $gte: startOfPolicyDay(policy) }
  });
  if (todaySms >= policy.dailySmsLimit) {
    return { type: "blocked", reason: `daily SMS limit of ${policy.dailySmsLimit} reached` };
  }
  if (policy.requireApprovalSms === "never") return { type: "allowed" };
  if (policy.requireApprovalSms === "always") return { type: "approval_required" };
  const knownRecipientCount = await collections.smsMessages.countDocuments({
    agentId: input.agent._id,
    direction: "outbound",
    counterpartyE164: to,
    status: { $in: ["sent", "delivered"] }
  });
  return knownRecipientCount > 0 ? { type: "allowed" } : { type: "approval_required" };
}

async function auditSmsBlocked(collections: Collections, input: SendAgentSmsInput, reason: string): Promise<void> {
  await recordAudit(collections, {
    agentId: input.agent._id,
    ownerUserId: input.agent.ownerUserId,
    actor: input.actor ?? "agent",
    action: AUDIT_ACTIONS.sms.blocked,
    status: "blocked",
    detail: reason
  });
}

function serializeSmsApprovalPayload(input: SendAgentSmsInput): Record<string, unknown> {
  return {
    to: input.to,
    body: input.body,
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
  };
}

function parseSmsApprovalPayload(agent: AgentDocument, payload: Record<string, unknown>): SendAgentSmsInput {
  return {
    agent,
    actor: payload.actor === "owner" ? "owner" : "agent",
    to: String(payload.to ?? ""),
    body: String(payload.body ?? ""),
    idempotencyKey: typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : undefined
  };
}

function mapTwilioMessageStatus(status: string): SmsMessageDocument["status"] {
  const normalized = status.toLowerCase();
  if (normalized === "delivered") return "delivered";
  if (normalized === "failed") return "failed";
  if (normalized === "undelivered") return "undelivered";
  return "sent";
}

function normalizeE164OrThrow(value: string, label: string): string {
  const normalized = normalizeE164PhoneNumber(value);
  if (!normalized) {
    throw new ApiError(400, "validation_failed", `${label} must be an E.164 phone number`);
  }
  return normalized;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function twiml(): string {
  return "<Response/>";
}
