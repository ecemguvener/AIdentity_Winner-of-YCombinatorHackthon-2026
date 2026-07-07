import { ObjectId } from "mongodb";
import type { AppConfig } from "./config.js";
import type { AgentDocument, Collections, PhoneNumberDocument, SmsMessageDocument } from "./db.js";
import { AUDIT_ACTIONS, recordAudit } from "./audit.js";
import { emitOwnerEvent } from "./approvals.js";
import { ApiError } from "./errors.js";
import { normalizeE164PhoneNumber } from "./lib/phone.js";
import { sendSms as sendTwilioSms } from "./providers/twilio-sms.js";

const maxSmsBodyLength = 1600;

export async function sendAgentSms(
  collections: Collections,
  config: AppConfig,
  input: { agent: AgentDocument; to: string; body: string; idempotencyKey?: string | null }
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
    actor: "agent",
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
