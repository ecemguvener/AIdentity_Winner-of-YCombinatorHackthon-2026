import { ObjectId } from "mongodb";
import type { AppConfig } from "./config.js";
import type { AgentDocument, CallDocument, Collections } from "./db.js";
import { AUDIT_ACTIONS, recordAudit } from "./audit.js";
import { emitOwnerEvent } from "./approvals.js";
import { getPhonePolicy } from "./policies.js";
import { recordUsage } from "./usage.js";

type TranscriptTurn = NonNullable<CallDocument["transcript"]>[number];

export async function handleElevenLabsPostCall(
  collections: Collections,
  config: AppConfig,
  payload: unknown
): Promise<{ ok: true; call_id: string } | { skipped: true; reason: string }> {
  const body = root(payload);
  const conversationId = readString(body.conversation_id) ?? readString(body.conversationId);
  const dynamicVariables = readDynamicVariables(body);
  const barkanCallId = readString(dynamicVariables.barkan_call_id);
  const metadata = record(body.metadata);
  const callSid = readString(metadata.call_sid) ?? readString(metadata.callSid);
  const call = await findMatchingCall(collections, { conversationId, barkanCallId, callSid });
  if (!call) {
    return { skipped: true, reason: "call not found" };
  }

  const agent = await collections.agents.findOne({ _id: call.agentId });
  if (!agent) {
    return { skipped: true, reason: "agent not found" };
  }

  const durationSecs = readNumber(metadata.call_duration_secs) ?? readNumber(metadata.duration_secs) ?? readNumber(body.duration_secs) ?? 0;
  const transcript = mapTranscript(body.transcript);
  const summary = readProviderSummary(body) ?? summarizeTranscript(transcript);
  const status = mapPostCallStatus(readString(body.status) ?? readString(body.call_status) ?? "completed");
  const costCents = estimateCallCostCents(durationSecs, config.CALL_COST_CENTS_PER_MINUTE ?? 15);
  const phonePolicy = await getPhonePolicy(collections, agent);
  const now = new Date();
  const update: Record<string, unknown> = {
    status,
    durationSecs,
    summary,
    costCents,
    updatedAt: now,
    ...(conversationId ? { elevenLabsConversationId: conversationId } : {})
  };
  if (phonePolicy.storeTranscripts) {
    update.transcript = transcript;
  } else {
    update.transcript = [];
  }

  await collections.calls.updateOne({ _id: call._id }, { $set: update });
  await recordCallCompletionAudit(collections, agent, call, status, durationSecs, summary);
  await recordUsageEvent(collections, agent, call, durationSecs, now);
  if (agent.ownerUserId) {
    const payload = {
      agentId: agent._id.toHexString(),
      callId: call._id.toHexString(),
      direction: call.direction,
      status,
      durationSecs,
      summary,
      followUpSuggested: suggestsFollowUp(summary)
    };
    emitOwnerEvent(agent.ownerUserId, "call.completed", payload);
    if (payload.followUpSuggested) {
      emitOwnerEvent(agent.ownerUserId, "dashboard.notification", {
        kind: "info",
        title: "Call follow-up suggested",
        message: "Call summary mentions a callback or scheduled follow-up.",
        callId: call._id.toHexString()
      });
    }
  }

  return { ok: true, call_id: call._id.toHexString() };
}

export function mapPostCallStatus(status: string): CallDocument["status"] {
  const normalized = status.toLowerCase();
  if (["failed", "error"].includes(normalized)) return "failed";
  if (["no_answer", "no-answer", "no answer", "missed"].includes(normalized)) return "no_answer";
  return "completed";
}

export function estimateCallCostCents(durationSecs: number, centsPerMinute = 15): number {
  if (!Number.isFinite(durationSecs) || durationSecs <= 0 || centsPerMinute <= 0) {
    return 0;
  }
  return Math.ceil(durationSecs / 60) * centsPerMinute;
}

async function findMatchingCall(
  collections: Collections,
  input: { conversationId: string | null; barkanCallId: string | null; callSid: string | null }
): Promise<CallDocument | null> {
  if (input.conversationId) {
    const call = await collections.calls.findOne({ elevenLabsConversationId: input.conversationId });
    if (call) return call;
  }
  if (input.barkanCallId && ObjectId.isValid(input.barkanCallId)) {
    const call = await collections.calls.findOne({ _id: new ObjectId(input.barkanCallId) });
    if (call) return call;
  }
  if (input.callSid) {
    return collections.calls.findOne({ providerCallId: input.callSid });
  }
  return null;
}

async function recordCallCompletionAudit(
  collections: Collections,
  agent: AgentDocument,
  call: CallDocument,
  status: CallDocument["status"],
  durationSecs: number,
  summary: string
): Promise<void> {
  await recordAudit(collections, {
    agentId: agent._id,
    ownerUserId: agent.ownerUserId,
    actor: "system",
    action: call.direction === "outbound" ? AUDIT_ACTIONS.phone.outbound : AUDIT_ACTIONS.phone.inbound,
    status: status === "completed" ? "allowed" : "blocked",
    detail: `Call ${status} after ${durationSecs}s. ${summary.slice(0, 180)}`,
    resourceType: "call",
    resourceId: call._id.toHexString(),
    metadata: { durationSecs }
  });
}

async function recordUsageEvent(
  collections: Collections,
  agent: AgentDocument,
  call: CallDocument,
  durationSecs: number,
  now: Date
): Promise<void> {
  if (!agent.ownerUserId) return;
  const quantity = Math.ceil(Math.max(durationSecs, 0) / 60);
  if (quantity <= 0) return;
  await recordUsage(collections, {
    ownerUserId: agent.ownerUserId,
    agentId: agent._id,
    meter: "call_minutes",
    quantity
  }, now);
}

function readDynamicVariables(body: Record<string, unknown>): Record<string, unknown> {
  const direct = record(body.dynamic_variables);
  if (Object.keys(direct).length) return direct;
  return record(record(body.conversation_initiation_client_data).dynamic_variables);
}

function mapTranscript(value: unknown): TranscriptTurn[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((turn) => {
    const item = record(turn);
    const message = readString(item.message) ?? readString(item.text);
    if (!message) return [];
    return [{
      role: readString(item.role) ?? "speaker",
      message,
      timeInCallSecs: readNumber(item.time_in_call_secs) ?? readNumber(item.timeInCallSecs) ?? 0
    }];
  });
}

function readProviderSummary(body: Record<string, unknown>): string | null {
  const analysis = record(body.analysis);
  return readString(analysis.transcript_summary) ?? readString(analysis.summary) ?? readString(body.summary);
}

function summarizeTranscript(transcript: TranscriptTurn[]): string {
  const firstAgentLine = transcript.find((turn) => turn.role.toLowerCase() === "agent")?.message ?? transcript[0]?.message;
  return firstAgentLine?.slice(0, 500) || "Call completed.";
}

function suggestsFollowUp(summary: string): boolean {
  return /will call back|scheduled/i.test(summary);
}

function root(payload: unknown): Record<string, unknown> {
  const outer = record(payload);
  return record(outer.data, outer);
}

function record(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fallback;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}
