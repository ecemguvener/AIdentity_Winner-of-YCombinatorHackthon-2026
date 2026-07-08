import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { AUDIT_ACTIONS, recordAudit } from "./audit.js";
import { requireAuth } from "./auth.js";
import type { AgentDocument, Collections, EmailPolicy, PhonePolicy } from "./db.js";
import { normalizeE164PhoneNumber } from "./lib/phone.js";
import { ApiError } from "./errors.js";
import type { AppConfig } from "./config.js";

const defaultDailySendLimit = 50;
const defaultMaxRecipientsPerMessage = 5;

const emailPolicySchema = z.object({
  requireApproval: z.enum(["always", "new_recipients", "never"]),
  allowedRecipients: z.array(z.string().min(1).max(320)).max(200).default([]),
  blockedRecipients: z.array(z.string().min(1).max(320)).max(200).default([]),
  dailySendLimit: z.number().int().min(0).max(10_000).default(defaultDailySendLimit),
  maxRecipientsPerMessage: z.number().int().min(1).max(50).default(defaultMaxRecipientsPerMessage)
});

const defaultInboundInstructions =
  "Answer naturally as the agent identity. Be helpful, concise, and collect the caller's name, reason for calling, and any callback details.";

const quietHoursSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().min(1).max(80)
});

const phonePolicySchema = z.object({
  requireApprovalOutboundCall: z.enum(["always", "new_recipients", "never"]).default("always"),
  requireApprovalSms: z.enum(["always", "new_recipients", "never"]).default("new_recipients"),
  allowedCountries: z.array(z.string().min(2).max(2)).max(100).default([]),
  inboundEnabled: z.boolean().default(true),
  blockedCallers: z.array(z.string().min(1).max(32)).max(500).default([]),
  inboundInstructions: z.string().max(2000).default(defaultInboundInstructions),
  dailyCallLimit: z.number().int().min(0).max(10_000).default(20),
  dailySmsLimit: z.number().int().min(0).max(10_000).default(50),
  quietHours: quietHoursSchema.nullable().default(null),
  storeTranscripts: z.boolean().default(true)
});

export function defaultEmailPolicy(approvalMode: AgentDocument["approvalMode"]): EmailPolicy {
  return {
    requireApproval: approvalMode === "always" ? "always" : "new_recipients",
    allowedRecipients: [],
    blockedRecipients: [],
    dailySendLimit: defaultDailySendLimit,
    maxRecipientsPerMessage: defaultMaxRecipientsPerMessage
  };
}

export function normalizeEmailPolicy(value: unknown, approvalMode: AgentDocument["approvalMode"] = "policy"): EmailPolicy {
  const defaults = defaultEmailPolicy(approvalMode);
  const parsed = emailPolicySchema.partial().parse(value ?? {});
  return {
    ...defaults,
    ...parsed,
    allowedRecipients: normalizeRecipientPatterns(parsed.allowedRecipients ?? defaults.allowedRecipients),
    blockedRecipients: normalizeRecipientPatterns(parsed.blockedRecipients ?? defaults.blockedRecipients)
  };
}

export function defaultPhonePolicy(): PhonePolicy {
  return {
    requireApprovalOutboundCall: "always",
    requireApprovalSms: "new_recipients",
    allowedCountries: [],
    inboundEnabled: true,
    blockedCallers: [],
    inboundInstructions: defaultInboundInstructions,
    dailyCallLimit: 20,
    dailySmsLimit: 50,
    quietHours: null,
    storeTranscripts: true
  };
}

function normalizePhonePolicy(value: unknown): PhonePolicy {
  const defaults = defaultPhonePolicy();
  const parsed = phonePolicySchema.partial().parse(value ?? {});
  return {
    ...defaults,
    ...parsed,
    allowedCountries: normalizeCountryCodes(parsed.allowedCountries ?? defaults.allowedCountries),
    blockedCallers: normalizePhonePatterns(parsed.blockedCallers ?? defaults.blockedCallers),
    inboundInstructions: parsed.inboundInstructions?.trim() || defaults.inboundInstructions,
    quietHours: parsed.quietHours ? normalizeQuietHours(parsed.quietHours) : null
  };
}

export async function getPhonePolicy(collections: Collections, agent: AgentDocument): Promise<PhonePolicy> {
  const policy = await collections.policies.findOne({ agentId: agent._id });
  if (!policy) {
    const now = new Date();
    const phone = defaultPhonePolicy();
    await collections.policies.insertOne({
      _id: new ObjectId(),
      agentId: agent._id,
      email: defaultEmailPolicy(agent.approvalMode),
      phone,
      createdAt: now,
      updatedAt: now
    });
    return phone;
  }
  return normalizePhonePolicy(policy.phone);
}

export async function getEmailPolicy(collections: Collections, agent: AgentDocument): Promise<EmailPolicy> {
  const policy = await collections.policies.findOne({ agentId: agent._id });
  if (!policy) {
    const now = new Date();
    const email = defaultEmailPolicy(agent.approvalMode);
    await collections.policies.insertOne({
      _id: new ObjectId(),
      agentId: agent._id,
      email,
      phone: {},
      createdAt: now,
      updatedAt: now
    });
    return email;
  }
  return normalizeEmailPolicy(policy.email, agent.approvalMode);
}

async function updateEmailPolicy(
  collections: Collections,
  agent: AgentDocument,
  ownerUserId: ObjectId,
  input: unknown
): Promise<EmailPolicy> {
  const previous = await getEmailPolicy(collections, agent);
  const next = normalizeEmailPolicy(input, agent.approvalMode);
  const now = new Date();
  await collections.policies.updateOne(
    { agentId: agent._id },
    {
      $set: { email: next, updatedAt: now },
      $setOnInsert: { _id: new ObjectId(), agentId: agent._id, phone: {}, createdAt: now }
    },
    { upsert: true }
  );
  await recordAudit(collections, {
    agentId: agent._id,
    ownerUserId,
    actor: "owner",
    action: AUDIT_ACTIONS.policy.updated,
    status: "allowed",
    detail: summarizePolicyDiff(previous, next),
    resourceType: "policy",
    resourceId: agent._id.toHexString(),
    metadata: { section: "email", previous, next }
  });
  return next;
}

async function updatePhonePolicy(
  collections: Collections,
  agent: AgentDocument,
  ownerUserId: ObjectId,
  input: unknown
): Promise<PhonePolicy> {
  const previous = await getPhonePolicy(collections, agent);
  const next = normalizePhonePolicy(input);
  const now = new Date();
  await collections.policies.updateOne(
    { agentId: agent._id },
    {
      $set: { phone: next, updatedAt: now },
      $setOnInsert: { _id: new ObjectId(), agentId: agent._id, email: defaultEmailPolicy(agent.approvalMode), createdAt: now }
    },
    { upsert: true }
  );
  await recordAudit(collections, {
    agentId: agent._id,
    ownerUserId,
    actor: "owner",
    action: AUDIT_ACTIONS.policy.updated,
    status: "allowed",
    detail: summarizePhonePolicyDiff(previous, next),
    resourceType: "policy",
    resourceId: agent._id.toHexString(),
    metadata: { section: "phone", previous, next }
  });
  return next;
}

export function isRecipientAllowedByPatterns(email: string, patterns: string[]): boolean {
  const normalized = normalizeEmail(email);
  return patterns.some((pattern) => recipientPatternMatches(normalized, pattern));
}

export function recipientPatternMatches(email: string, pattern: string): boolean {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPattern = normalizeRecipientPattern(pattern);
  if (normalizedPattern.startsWith("@")) {
    const domain = normalizedPattern.slice(1);
    const [, emailDomain = ""] = normalizedEmail.split("@");
    return emailDomain === domain;
  }
  return normalizedEmail === normalizedPattern;
}

export function registerPolicyRoutes(app: FastifyInstance, collections: Collections, config: AppConfig): void {
  app.get("/api/v1/agents/:agentId/policies/email", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const agent = await findOwnedAgent(collections, authContext.user._id, request.params);
    return { policy: await getEmailPolicy(collections, agent) };
  });

  app.put("/api/v1/agents/:agentId/policies/email", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const agent = await findOwnedAgent(collections, authContext.user._id, request.params);
    const payload = emailPolicySchema.parse(request.body ?? {});
    return { policy: await updateEmailPolicy(collections, agent, authContext.user._id, payload) };
  });

  app.get("/api/v1/agents/:agentId/policies/phone", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const agent = await findOwnedAgent(collections, authContext.user._id, request.params);
    return { policy: await getPhonePolicy(collections, agent) };
  });

  app.put("/api/v1/agents/:agentId/policies/phone", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const agent = await findOwnedAgent(collections, authContext.user._id, request.params);
    const payload = phonePolicySchema.parse(request.body ?? {});
    return { policy: await updatePhonePolicy(collections, agent, authContext.user._id, payload) };
  });
}

function normalizeRecipientPatterns(patterns: string[]): string[] {
  return [...new Set(patterns.map(normalizeRecipientPattern).filter(Boolean))];
}

function normalizeRecipientPattern(pattern: string): string {
  return pattern.trim().toLowerCase();
}

function normalizePhonePatterns(patterns: string[]): string[] {
  return [...new Set(patterns.map((pattern) => normalizeE164PhoneNumber(pattern)).filter((value): value is string => Boolean(value)))];
}

function normalizeCountryCodes(countries: string[]): string[] {
  return [...new Set(countries.map((country) => country.trim().toUpperCase()).filter(Boolean))];
}

function normalizeQuietHours(quietHours: { start: string; end: string; timezone: string }): NonNullable<PhonePolicy["quietHours"]> {
  return {
    start: quietHours.start,
    end: quietHours.end,
    timezone: quietHours.timezone.trim() || "UTC"
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function findOwnedAgent(collections: Collections, ownerUserId: ObjectId, params: unknown): Promise<AgentDocument> {
  const { agentId } = params as { agentId?: string };
  if (!agentId || !ObjectId.isValid(agentId)) {
    throw new ApiError(404, "not_found", "agent not found");
  }
  const agent = await collections.agents.findOne({ _id: new ObjectId(agentId), ownerUserId, status: { $ne: "revoked" } });
  if (!agent) {
    throw new ApiError(404, "not_found", "agent not found");
  }
  return agent;
}

function summarizePolicyDiff(previous: EmailPolicy, next: EmailPolicy): string {
  const changed = (Object.keys(next) as Array<keyof EmailPolicy>)
    .filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
  return changed.length ? `Email policy updated (${changed.join(", ")}).` : "Email policy updated (no changes).";
}

function summarizePhonePolicyDiff(previous: PhonePolicy, next: PhonePolicy): string {
  const changed = (Object.keys(next) as Array<keyof PhonePolicy>)
    .filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
  return changed.length ? `Phone policy updated (${changed.join(", ")}).` : "Phone policy updated (no changes).";
}
