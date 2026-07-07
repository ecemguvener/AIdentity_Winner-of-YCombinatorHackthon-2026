import { ObjectId } from "mongodb";
import { z } from "zod";
import { AUDIT_ACTIONS, recordAudit } from "./audit.js";
import { emitOwnerEvent } from "./approvals.js";
import type { AgentDocument, CallDocument, Collections, PhoneNumberDocument, PhonePolicy, UserDocument } from "./db.js";
import { ApiError } from "./errors.js";
import { normalizeE164PhoneNumber } from "./lib/phone.js";
import { defaultPhonePolicy, getPhonePolicy } from "./policies.js";

const defaultAgentRole = "personal assistant";
const notInServiceMessage = "This number is not in service.";
const blockedMessage = "This assistant is not available for this call.";

export const elevenLabsPersonalizationPayloadSchema = z.object({
  caller_id: z.string().min(1),
  agent_id: z.string().min(1).optional(),
  called_number: z.string().min(1),
  call_sid: z.string().min(1)
});

export type ElevenLabsPersonalizationResponse = ReturnType<typeof buildResponse>;

export function validateElevenLabsPersonalizationPayload(payload: unknown): void {
  const parsed = parsePayload(payload);
  normalizeE164OrThrow(parsed.caller_id, "caller_id");
  normalizeE164OrThrow(parsed.called_number, "called_number");
}

export async function handleElevenLabsPersonalization(
  collections: Collections,
  payload: unknown
): Promise<ElevenLabsPersonalizationResponse> {
  const parsed = parsePayload(payload);
  const callerE164 = normalizeE164OrThrow(parsed.caller_id, "caller_id");
  const calledE164 = normalizeE164OrThrow(parsed.called_number, "called_number");

  const phoneNumber = await collections.phoneNumbers.findOne({ e164: calledE164, status: "active" });
  if (!phoneNumber) {
    return notInServiceResponse();
  }

  const agent = await collections.agents.findOne({ _id: phoneNumber.agentId, status: { $ne: "revoked" } });
  if (!agent) {
    return notInServiceResponse();
  }

  const [owner, policy] = await Promise.all([
    agent.ownerUserId ? collections.users.findOne({ _id: agent.ownerUserId }) : Promise.resolve(null),
    getPhonePolicy(collections, agent)
  ]);
  const blocked = !policy.inboundEnabled || policy.blockedCallers.includes(callerE164);
  const call = await ensureInboundCall(collections, agent, phoneNumber, callerE164, parsed.call_sid);
  await recordInboundAudit(collections, agent, call, callerE164, blocked, policy.inboundEnabled);

  if (!blocked && agent.ownerUserId) {
    emitOwnerEvent(agent.ownerUserId, "call.started", serializeCallStarted(agent, call));
  }

  if (blocked) {
    return blockedResponse(agent, owner, policy, call);
  }

  return personalizedResponse(agent, owner, policy, call);
}

export async function replayElevenLabsPersonalization(
  collections: Collections,
  payload: unknown
): Promise<ElevenLabsPersonalizationResponse> {
  const parsed = parsePayload(payload);
  const existingCall = await collections.calls.findOne({ providerCallId: parsed.call_sid });
  if (!existingCall) {
    return handleElevenLabsPersonalization(collections, payload);
  }
  const [agent, policy, owner] = await loadCallContext(collections, existingCall);
  if (!agent) {
    return notInServiceResponse(existingCall._id);
  }
  if (!policy.inboundEnabled || policy.blockedCallers.includes(existingCall.counterpartyE164)) {
    return blockedResponse(agent, owner, policy, existingCall);
  }
  return personalizedResponse(agent, owner, policy, existingCall);
}

async function ensureInboundCall(
  collections: Collections,
  agent: AgentDocument,
  phoneNumber: PhoneNumberDocument,
  callerE164: string,
  callSid: string
): Promise<CallDocument> {
  const now = new Date();
  const inserted = await collections.calls.findOneAndUpdate(
    { providerCallId: callSid },
    {
      $setOnInsert: {
        _id: new ObjectId(),
        agentId: agent._id,
        phoneNumberId: phoneNumber._id,
        direction: "inbound",
        counterpartyE164: callerE164,
        providerCallId: callSid,
        status: "in_progress",
        createdAt: now
      },
      $set: { updatedAt: now }
    },
    { upsert: true, returnDocument: "after" }
  );
  if (!inserted) {
    throw new ApiError(500, "internal", "could not create inbound call");
  }
  return inserted;
}

async function loadCallContext(
  collections: Collections,
  call: CallDocument
): Promise<[AgentDocument | null, PhonePolicy, UserDocument | null]> {
  const agent = await collections.agents.findOne({ _id: call.agentId, status: { $ne: "revoked" } });
  if (!agent) {
    return [null, { ...defaultPhonePolicy(), inboundEnabled: false, inboundInstructions: "" }, null];
  }
  const [policy, owner] = await Promise.all([
    getPhonePolicy(collections, agent),
    agent.ownerUserId ? collections.users.findOne({ _id: agent.ownerUserId }) : Promise.resolve(null)
  ]);
  return [agent, policy, owner];
}

async function recordInboundAudit(
  collections: Collections,
  agent: AgentDocument,
  call: CallDocument,
  callerE164: string,
  blocked: boolean,
  inboundEnabled: boolean
): Promise<void> {
  await recordAudit(collections, {
    agentId: agent._id,
    ownerUserId: agent.ownerUserId,
    actor: "system",
    action: AUDIT_ACTIONS.phone.inbound,
    status: blocked ? "blocked" : "allowed",
    detail: blocked
      ? `Inbound call from ${callerE164} blocked${inboundEnabled ? "." : ": inbound disabled."}`
      : `Inbound call from ${callerE164} started.`,
    resourceType: "call",
    resourceId: call._id.toHexString(),
    metadata: { callerE164, providerCallId: call.providerCallId ?? null }
  });
}

function personalizedResponse(
  agent: AgentDocument,
  owner: UserDocument | null,
  policy: PhonePolicy,
  call: CallDocument
) {
  const ownerName = ownerDisplayName(owner);
  const agentRole = agent.description?.trim() || defaultAgentRole;
  return buildResponse({
    agentIdentityName: agent.name,
    ownerName,
    agentRole,
    inboundGuidance: policy.inboundInstructions,
    barkanCallId: call._id.toHexString(),
    firstMessage: `Hi, this is ${agent.name}, ${possessive(ownerName)} assistant. How can I help?`
  });
}

function blockedResponse(
  agent: AgentDocument,
  owner: UserDocument | null,
  policy: PhonePolicy,
  call: CallDocument
) {
  return buildResponse({
    agentIdentityName: agent.name,
    ownerName: ownerDisplayName(owner),
    agentRole: agent.description?.trim() || defaultAgentRole,
    inboundGuidance: policy.inboundInstructions,
    barkanCallId: call._id.toHexString(),
    firstMessage: blockedMessage
  });
}

function notInServiceResponse(callId?: ObjectId) {
  return buildResponse({
    agentIdentityName: "Barkan",
    ownerName: "my owner",
    agentRole: defaultAgentRole,
    inboundGuidance: notInServiceMessage,
    barkanCallId: callId?.toHexString() ?? "",
    firstMessage: notInServiceMessage
  });
}

function buildResponse(input: {
  agentIdentityName: string;
  ownerName: string;
  agentRole: string;
  inboundGuidance: string;
  barkanCallId: string;
  firstMessage: string;
}) {
  return {
    type: "conversation_initiation_client_data",
    dynamic_variables: {
      agent_identity_name: input.agentIdentityName,
      owner_name: input.ownerName,
      agent_role: input.agentRole,
      inbound_guidance: input.inboundGuidance,
      barkan_call_id: input.barkanCallId
    },
    conversation_config_override: {
      agent: {
        first_message: input.firstMessage
      }
    }
  } as const;
}

function serializeCallStarted(agent: AgentDocument, call: CallDocument) {
  return {
    agentId: agent._id.toHexString(),
    callId: call._id.toHexString(),
    direction: call.direction,
    counterpartyE164: call.counterpartyE164,
    status: call.status,
    providerCallId: call.providerCallId ?? null,
    createdAt: call.createdAt.toISOString()
  };
}

function parsePayload(payload: unknown): z.infer<typeof elevenLabsPersonalizationPayloadSchema> {
  return elevenLabsPersonalizationPayloadSchema.parse(payload);
}

function normalizeE164OrThrow(value: string, label: string): string {
  const normalized = normalizeE164PhoneNumber(value);
  if (!normalized) {
    throw new ApiError(400, "validation_failed", `${label} must be an E.164 phone number`);
  }
  return normalized;
}

function ownerDisplayName(owner: UserDocument | null): string {
  return owner?.displayName?.trim() || "my owner";
}

function possessive(value: string): string {
  return value.endsWith("s") ? `${value}'` : `${value}'s`;
}
