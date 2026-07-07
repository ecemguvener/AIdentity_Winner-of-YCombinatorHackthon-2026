import { ObjectId } from "mongodb";
import type { AppConfig } from "./config.js";
import type { AgentDocument, ApprovalDocument, CallDocument, Collections, PhoneNumberDocument } from "./db.js";
import { AUDIT_ACTIONS, recordAudit } from "./audit.js";
import { registerApprovalExecutor, requestApproval, waitForDecision } from "./approvals.js";
import { checkEntitlement, throwPlanLimit } from "./entitlements.js";
import { ApiError, type ApiErrorCode } from "./errors.js";
import { instrumentProviderCall } from "./metrics.js";
import { normalizeE164PhoneNumber } from "./lib/phone.js";
import { getPhonePolicy } from "./policies.js";
import { enforcePhoneCountry, quietHoursBlockReason, startOfPolicyDay } from "./phone-policy.js";

const callConversationGuidance =
  "Call naturally and keep the conversation moving. Do not repeatedly ask for confirmation; only confirm final details that affect the outcome, like time, price, address, availability, or cancellation policy.";

const mockCompletionDelayMs = 2000;

export interface PlaceOutboundCallInput {
  agent: AgentDocument;
  actor?: "agent" | "owner";
  toNumber: string;
  task: string;
  context?: string | null;
  recipientName?: string | null;
  sourceUrl?: string | null;
}

export interface PhoneApprovalOptions {
  waitMs?: number;
  async?: boolean;
}

export interface OutboundCallResult {
  callId: string;
  status: CallDocument["status"];
  from: string;
  to: string;
  simulated: boolean;
}

export interface PhoneCallTranscriptTurn {
  role: string;
  message: string;
  timeInCallSecs: number | null;
}

export class PhoneCallError extends ApiError {
  constructor(message: string, statusCode = 400, code: ApiErrorCode = "provider_error") {
    super(statusCode, code, message);
    this.name = "PhoneCallError";
  }
}

export async function placeOutboundCall(
  collections: Collections,
  config: AppConfig,
  input: PlaceOutboundCallInput,
  approvalOptions: PhoneApprovalOptions = {}
): Promise<OutboundCallResult | { approvalRequired: true; approval: ApprovalDocument; decision: "pending" | "timeout" | "expired" }> {
  const toNumber = normalizeE164PhoneNumber(input.toNumber);
  if (!toNumber) {
    throw new PhoneCallError("The phone number must be an E.164-style number, for example +14155550198.", 400, "validation_failed");
  }
  if (!input.task.trim()) {
    throw new PhoneCallError("The call task cannot be empty.", 400, "validation_failed");
  }
  const phoneNumber = await collections.phoneNumbers.findOne({ agentId: input.agent._id, status: "active" });
  if (!phoneNumber?.elevenLabsPhoneNumberId) {
    throw new PhoneCallError("phone capability not provisioned", 409, "policy_blocked");
  }
  if (input.agent.ownerUserId) {
    throwPlanLimit(await checkEntitlement(collections, input.agent.ownerUserId, { type: "usage", meter: "call_minutes" }));
  }
  const policyDecision = await evaluateCallPolicy(collections, input);
  if (policyDecision.type === "blocked") {
    await auditPhoneBlocked(collections, input, policyDecision.reason);
    throw new PhoneCallError(policyDecision.reason, 403, "policy_blocked");
  }
  if (policyDecision.type === "allowed") {
    return placeOutboundCallUnchecked(collections, config, input);
  }
  if (!input.agent.ownerUserId) {
    const reason = "phone call approval requires an owner user";
    await auditPhoneBlocked(collections, input, reason);
    throw new PhoneCallError(reason, 403, "policy_blocked");
  }
  const approval = await requestApproval(collections, {
    agentId: input.agent._id,
    ownerUserId: input.agent.ownerUserId,
    kind: "phone.call",
    payloadSummary: `Call ${toNumber} about: ${input.task.trim()}`,
    payload: serializeCallApprovalPayload(input)
  });
  if (approvalOptions.async) {
    return { approvalRequired: true, approval, decision: "pending" };
  }
  const decision = await waitForDecision(collections, approval._id, { timeoutMs: approvalOptions.waitMs ?? 90_000 });
  const updated = await collections.approvals.findOne({ _id: approval._id }) ?? approval;
  if (decision === "approved" && updated.executionResult) {
    const callId = updated.executionResult.callId;
    const call = typeof callId === "string" && ObjectId.isValid(callId)
      ? await collections.calls.findOne({ _id: new ObjectId(callId), agentId: input.agent._id })
      : null;
    if (call) {
      const phoneNumber = await collections.phoneNumbers.findOne({ _id: call.phoneNumberId });
      return { callId: call._id.toHexString(), status: call.status, from: phoneNumber?.e164 ?? "", to: call.counterpartyE164, simulated: Boolean(updated.executionResult.simulated) };
    }
  }
  if (decision === "rejected") {
    throw new PhoneCallError("phone call was rejected", 403, "approval_required");
  }
  if (decision === "expired") {
    throw new PhoneCallError("phone call approval expired", 403, "approval_required");
  }
  return { approvalRequired: true, approval: updated, decision: decision === "timeout" ? "timeout" : "pending" };
}

async function placeOutboundCallUnchecked(
  collections: Collections,
  config: AppConfig,
  input: PlaceOutboundCallInput
): Promise<OutboundCallResult> {
  const toNumber = normalizeE164PhoneNumber(input.toNumber);
  if (!toNumber) {
    throw new PhoneCallError("The phone number must be an E.164-style number, for example +14155550198.", 400, "validation_failed");
  }

  const task = input.task.trim();
  if (!task) {
    throw new PhoneCallError("The call task cannot be empty.", 400, "validation_failed");
  }

  const phoneNumber = await collections.phoneNumbers.findOne({ agentId: input.agent._id, status: "active" });
  if (!phoneNumber?.elevenLabsPhoneNumberId) {
    throw new PhoneCallError("phone capability not provisioned", 409, "policy_blocked");
  }

  const call = await insertQueuedOutboundCall(collections, input.agent, phoneNumber, toNumber, task);
  await recordAudit(collections, {
    agentId: input.agent._id,
    ownerUserId: input.agent.ownerUserId,
    actor: input.actor ?? "agent",
    action: AUDIT_ACTIONS.phone.outbound,
    status: "allowed",
    detail: `Outbound call queued to ${toNumber}.`,
    resourceType: "call",
    resourceId: call._id.toHexString(),
    metadata: { phoneNumberId: phoneNumber._id.toHexString() }
  });

  if (config.PROVIDER_MODE_PHONE === "mock") {
    scheduleMockCompletion(collections, call._id, toNumber, task);
    return { callId: call._id.toHexString(), status: "queued", from: phoneNumber.e164, to: toNumber, simulated: true };
  }

  const responseJson = await startElevenLabsOutboundCall(collections, config, input, phoneNumber, call, toNumber, task);
  const conversationId = readString(responseJson.conversation_id) || readString(responseJson.call_id);
  const providerStatus = readString(responseJson.status) || "ringing";
  const status = mapProviderStatus(providerStatus);
  await collections.calls.updateOne(
    { _id: call._id },
    {
      $set: {
        ...(conversationId ? { elevenLabsConversationId: conversationId, providerCallId: conversationId } : {}),
        status,
        updatedAt: new Date()
      }
    }
  );
  return { callId: call._id.toHexString(), status, from: phoneNumber.e164, to: toNumber, simulated: false };
}

export function registerPhoneApprovalExecutor(collections: Collections, config: AppConfig): void {
  registerApprovalExecutor("phone.call", async (approval) => {
    const agent = await collections.agents.findOne({ _id: approval.agentId, status: { $ne: "revoked" } });
    if (!agent) throw new Error("agent not found");
    const result = await placeOutboundCallUnchecked(collections, config, parseCallApprovalPayload(agent, approval.payload));
    return {
      callId: result.callId,
      status: result.status,
      to: result.to,
      simulated: result.simulated
    };
  });
}

export async function listAgentPhoneCalls(
  collections: Collections,
  agent: AgentDocument,
  cursor?: string | null,
  limit = 25
): Promise<{ calls: CallDocument[]; nextCursor: string | null }> {
  const query: Record<string, unknown> = { agentId: agent._id };
  if (cursor && ObjectId.isValid(cursor)) {
    query._id = { $lt: new ObjectId(cursor) };
  }
  const calls = await collections.calls.find(query).sort({ _id: -1 }).limit(limit + 1).toArray();
  const page = calls.slice(0, limit);
  return {
    calls: page,
    nextCursor: calls.length > limit ? page.at(-1)?._id.toHexString() ?? null : null
  };
}

export async function getAgentPhoneCall(
  collections: Collections,
  agent: AgentDocument,
  callId: string
): Promise<CallDocument> {
  if (!ObjectId.isValid(callId)) {
    throw new ApiError(404, "not_found", "call not found");
  }
  const call = await collections.calls.findOne({ _id: new ObjectId(callId), agentId: agent._id });
  if (!call) {
    throw new ApiError(404, "not_found", "call not found");
  }
  return call;
}

export function serializePhoneCall(call: CallDocument) {
  return {
    id: call._id.toHexString(),
    agent_id: call.agentId.toHexString(),
    phone_number_id: call.phoneNumberId.toHexString(),
    direction: call.direction,
    counterparty_e164: call.counterpartyE164,
    task: call.task ?? null,
    status: call.status,
    provider_call_id: call.providerCallId ?? null,
    elevenlabs_conversation_id: call.elevenLabsConversationId ?? null,
    duration_secs: call.durationSecs ?? null,
    transcript: call.transcript ?? [],
    summary: call.summary ?? null,
    cost_cents: call.costCents ?? null,
    created_at: call.createdAt.toISOString(),
    updated_at: call.updatedAt.toISOString()
  };
}

async function insertQueuedOutboundCall(
  collections: Collections,
  agent: AgentDocument,
  phoneNumber: PhoneNumberDocument,
  toNumber: string,
  task: string
): Promise<CallDocument> {
  const now = new Date();
  const call: CallDocument = {
    _id: new ObjectId(),
    agentId: agent._id,
    phoneNumberId: phoneNumber._id,
    direction: "outbound",
    counterpartyE164: toNumber,
    task,
    status: "queued",
    createdAt: now,
    updatedAt: now
  };
  await collections.calls.insertOne(call);
  return call;
}

async function startElevenLabsOutboundCall(
  collections: Collections,
  config: AppConfig,
  input: PlaceOutboundCallInput,
  phoneNumber: PhoneNumberDocument,
  call: CallDocument,
  toNumber: string,
  task: string
): Promise<Record<string, unknown>> {
  const [owner, phonePolicy] = await Promise.all([
    input.agent.ownerUserId ? collections.users.findOne({ _id: input.agent.ownerUserId }) : Promise.resolve(null),
    getPhonePolicy(collections, input.agent)
  ]);
  const ownerName = owner?.displayName?.trim() || owner?.email.split("@", 1)[0] || "my owner";
  const callBrief = buildPersonalAssistantCallBrief({ ownerName, recipientName: input.recipientName }, task);
  const response = await instrumentProviderCall("elevenlabs", "twilio.outbound-call", () => fetch("https://api.elevenlabs.io/v1/convai/twilio/outbound-call", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "xi-api-key": config.ELEVENLABS_API_KEY ?? ""
    },
    body: JSON.stringify({
      agent_id: config.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: phoneNumber.elevenLabsPhoneNumberId,
      to_number: toNumber,
      conversation_initiation_client_data: {
        type: "conversation_initiation_client_data",
        dynamic_variables: {
          agent_identity_name: input.agent.name,
          owner_name: ownerName,
          agent_role: input.agent.description?.trim() || "personal assistant",
          inbound_guidance: phonePolicy.inboundInstructions,
          barkan_call_id: call._id.toHexString(),
          recipient_name: input.recipientName?.trim() || "the person who answers",
          task,
          call_opening: callBrief.firstMessage,
          call_guidance: callConversationGuidance,
          context: buildCallContext(input.context),
          source_url: input.sourceUrl?.trim() || ""
        }
      }
    })
  }));

  const responseText = await response.text();
  let responseJson: Record<string, unknown> = {};
  try {
    responseJson = responseText ? JSON.parse(responseText) as Record<string, unknown> : {};
  } catch {
    responseJson = {};
  }

  if (!response.ok) {
    const detail = readString(responseJson.detail) ?? readString(responseJson.message) ?? (responseText.slice(0, 500) || "ElevenLabs outbound call failed.");
    await collections.calls.updateOne(
      { _id: call._id },
      { $set: { status: "failed", updatedAt: new Date() } }
    );
    throw new PhoneCallError(detail);
  }

  return responseJson;
}

function scheduleMockCompletion(collections: Collections, callId: ObjectId, toNumber: string, task: string): void {
  const timer = setTimeout(() => {
    void collections.calls.updateOne(
      { _id: callId },
      {
        $set: {
          status: "completed",
          durationSecs: 0,
          transcript: [{ role: "agent", message: `[mock] Called ${toNumber} about: ${task}`, timeInCallSecs: 0 }],
          updatedAt: new Date()
        }
      }
    );
  }, mockCompletionDelayMs);
  timer.unref?.();
}

async function evaluateCallPolicy(
  collections: Collections,
  input: PlaceOutboundCallInput
): Promise<{ type: "allowed" } | { type: "approval_required" } | { type: "blocked"; reason: string }> {
  const toNumber = normalizeE164PhoneNumber(input.toNumber);
  if (!toNumber) {
    return { type: "allowed" };
  }
  const policy = await getPhonePolicy(collections, input.agent);
  const country = enforcePhoneCountry(policy, toNumber);
  if (!country.ok) return { type: "blocked", reason: country.reason };
  const quietReason = quietHoursBlockReason(policy);
  if (quietReason) return { type: "blocked", reason: quietReason };
  const todayCalls = await collections.calls.countDocuments({
    agentId: input.agent._id,
    direction: "outbound",
    createdAt: { $gte: startOfPolicyDay(policy) }
  });
  if (todayCalls >= policy.dailyCallLimit) {
    return { type: "blocked", reason: `daily call limit of ${policy.dailyCallLimit} reached` };
  }
  if (policy.requireApprovalOutboundCall === "never") return { type: "allowed" };
  if (policy.requireApprovalOutboundCall === "always") return { type: "approval_required" };
  const knownRecipientCount = await collections.calls.countDocuments({
    agentId: input.agent._id,
    direction: "outbound",
    counterpartyE164: toNumber,
    status: { $in: ["ringing", "in_progress", "completed", "no_answer"] }
  });
  return knownRecipientCount > 0 ? { type: "allowed" } : { type: "approval_required" };
}

async function auditPhoneBlocked(collections: Collections, input: PlaceOutboundCallInput, reason: string): Promise<void> {
  await recordAudit(collections, {
    agentId: input.agent._id,
    ownerUserId: input.agent.ownerUserId,
    actor: input.actor ?? "agent",
    action: AUDIT_ACTIONS.phone.blocked,
    status: "blocked",
    detail: reason
  });
}

function serializeCallApprovalPayload(input: PlaceOutboundCallInput): Record<string, unknown> {
  return {
    toNumber: input.toNumber,
    task: input.task,
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.context ? { context: input.context } : {}),
    ...(input.recipientName ? { recipientName: input.recipientName } : {}),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {})
  };
}

function parseCallApprovalPayload(agent: AgentDocument, payload: Record<string, unknown>): PlaceOutboundCallInput {
  return {
    agent,
    actor: payload.actor === "owner" ? "owner" : "agent",
    toNumber: String(payload.toNumber ?? ""),
    task: String(payload.task ?? ""),
    context: typeof payload.context === "string" ? payload.context : undefined,
    recipientName: typeof payload.recipientName === "string" ? payload.recipientName : undefined,
    sourceUrl: typeof payload.sourceUrl === "string" ? payload.sourceUrl : undefined
  };
}

function buildCallContext(context: string | null | undefined): string {
  const trimmedContext = context?.trim();
  return [trimmedContext, callConversationGuidance].filter(Boolean).join("\n\n");
}

export function buildPersonalAssistantCallBrief(
  request: { ownerName: string; recipientName?: string | null },
  task: string
): { firstMessage: string } {
  const callerName = request.ownerName.trim() || "the account owner";
  const firstMessage = `Hi, I'm calling on behalf of ${callerName}. ${buildNaturalRequest(task, request.recipientName)}`;
  return { firstMessage };
}

function buildNaturalRequest(task: string, recipientName: string | null | undefined): string {
  const trimmed = task.trim().replace(/[.!?]+$/g, "");
  const withoutPlease = trimmed.replace(/^please\s+/i, "");
  const directCallPhrase = withoutPlease.match(/^(?:i\s+need\s+to|i\s+want\s+to|the\s+goal\s+is\s+to)\s+(.+)$/i);
  const request = stripOutboundCallWrapper(directCallPhrase?.[1] ?? withoutPlease, recipientName);
  const firstWord = request.split(/\s+/, 1)[0] ?? "";

  if (/^(?:i\s+am|i'm)\s+calling\b/i.test(request)) {
    return punctuate(capitalizeFirst(request));
  }

  if (/^(can|could|would|is|are|do|does|did|will|has|have)\b/i.test(firstWord)) {
    return punctuate(`I'm calling to ask if ${questionToStatement(request)}`);
  }

  if (/^(ask|book|cancel|change|check|confirm|contact|find|get|invite|move|order|propose|request|reserve|schedule|see|tell|try|update)\b/i.test(firstWord)) {
    return punctuate(`I'm calling to ${lowercaseFirst(request)}`);
  }

  return punctuate(`I'm calling about ${lowercaseFirst(request)}`);
}

function stripOutboundCallWrapper(value: string, recipientName: string | null | undefined): string {
  const callWrapperMatch = value.match(/^(?:call|phone|ring|contact|reach\s+out\s+to)\s+(.+?)(?:\s+(?:and|to)\s+(.+))$/i);
  if (callWrapperMatch?.[2]) {
    return callWrapperMatch[2].trim();
  }

  if (/^(?:call|phone|ring|contact|reach\s+out\s+to)\b/i.test(value)) {
    const recipient = recipientName?.trim() || "the recipient";
    return `speak with ${recipient} about the user's request`;
  }

  return value;
}

function mapProviderStatus(status: string): CallDocument["status"] {
  const normalized = status.toLowerCase();
  if (["started", "in_progress", "ongoing", "connected"].includes(normalized)) return "in_progress";
  if (["done", "completed", "complete", "success"].includes(normalized)) return "completed";
  if (["failed", "error"].includes(normalized)) return "failed";
  if (["no_answer", "no-answer"].includes(normalized)) return "no_answer";
  return "ringing";
}

function lowercaseFirst(value: string): string {
  return value ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : value;
}

function capitalizeFirst(value: string): string {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function questionToStatement(value: string): string {
  const words = value.split(/\s+/);
  const auxiliary = words[0]?.toLowerCase() ?? "";
  const subject = words[1]?.toLowerCase() ?? "";
  const rest = words.slice(2).join(" ");

  if (!subject || !rest) {
    return lowercaseFirst(value);
  }

  if (/^(can|could|would|will|has|have)$/.test(auxiliary)) {
    return `${subject} ${auxiliary} ${rest}`;
  }

  if (/^(is|are)$/.test(auxiliary)) {
    return `${subject} ${auxiliary} ${rest}`;
  }

  if (/^(do|did)$/.test(auxiliary)) {
    return `${subject} ${rest}`;
  }

  if (auxiliary === "does") {
    return `${subject} ${rest.replace(/^have\b/i, "has")}`;
  }

  return lowercaseFirst(value);
}

function punctuate(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
