import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { AgentDocument, Collections, PolicyDocument } from "./db.js";
import {
  authenticateAgentRequest,
  issueIdentityToken,
  type IdentityTokenMode
} from "./agent-auth.js";
import { AUDIT_ACTIONS, listAuditEntries, recordAudit, serializeAuditEntry } from "./audit.js";
import { ApiError } from "./errors.js";
import { slugify } from "./lib/slug.js";
import { normalizeEmail } from "./security.js";
import { getProvisioner } from "./provisioning.js";
import { registerEmailProvisioner } from "./email-provisioning.js";

type ToolName = "email" | "phone" | "calendar" | "payment";
type PermissionName = "email.send" | "phone.call" | "calendar.create" | "payment.purchase";

// Compatibility view over a persisted agent, consumed by the email/payment
// tool modules (whose own stores are still in-memory and keyed by the agent's
// hex id). Calendar/payment capability flags land in later tasks; until then
// those demo tools gate only on agent status + approval mode.
export interface AgentIdentity {
  id: string;
  name: string;
  status: "active" | "revoked";
  permissions: Record<PermissionName, boolean> & {
    requiresHumanApproval: boolean;
  };
}

export function agentIdentityView(agent: AgentDocument): AgentIdentity {
  return {
    id: agent._id.toHexString(),
    name: agent.name,
    status: agent.status === "active" ? "active" : "revoked",
    permissions: {
      "email.send": agent.capabilities.email,
      "phone.call": agent.capabilities.phone,
      "calendar.create": true,
      "payment.purchase": true,
      requiresHumanApproval: agent.approvalMode !== "autonomous"
    }
  };
}

export async function loadAgentIdentityFromRequest(
  request: FastifyRequest,
  collections: Collections
): Promise<AgentIdentity | null> {
  const agentContext = await authenticateAgentRequest(request, collections);
  return agentContext ? agentIdentityView(agentContext.agent) : null;
}

const initIdentitySchema = z.object({
  agent_name: z.string().min(1).max(80),
  agent_runtime: z.string().min(1).max(80).default("openclaw"),
  use_case: z.string().min(1).max(120).default("automation"),
  owner_email: z.string().email().optional(),
  tools: z
    .array(z.enum(["email", "phone", "calendar", "payment"]))
    .min(1)
    .default(["email", "phone", "calendar", "payment"]),
  permissions: z
    .object({
      "email.send": z.boolean().optional(),
      "phone.call": z.boolean().optional(),
      "calendar.create": z.boolean().optional(),
      "payment.purchase": z.boolean().optional(),
      requires_human_approval: z.boolean().optional()
    })
    .optional()
});

const phoneCallSchema = z.object({
  to: z.string().min(3).max(40),
  script: z.string().min(1).max(5000),
  approved: z.boolean().optional()
});

const calendarBookSchema = z.object({
  title: z.string().min(1).max(200),
  attendee_email: z.string().email(),
  start_time: z.string().min(1),
  approved: z.boolean().optional()
});

export function registerIdentityRoutes(app: FastifyInstance, collections: Collections, config: AppConfig) {
  registerEmailProvisioner(collections, config);

  app.post("/api/identity/init", async (request, reply) => {
    const payload = initIdentitySchema.parse(request.body ?? {});
    const tools = [...new Set(payload.tools)] as ToolName[];

    let ownerUserId: ObjectId | null = null;
    if (payload.owner_email) {
      const owner = await collections.users.findOne({ email: normalizeEmail(payload.owner_email) });
      if (!owner) {
        throw new ApiError(404, "not_found", "owner_email does not match an existing user");
      }
      ownerUserId = owner._id;
    }

    const now = new Date();
    const agent: AgentDocument = {
      _id: new ObjectId(),
      ownerUserId,
      name: payload.agent_name.trim(),
      slug: await reserveAgentSlug(collections, ownerUserId, payload.agent_name),
      status: "active",
      description: payload.use_case.trim(),
      runtime: normalizeRuntime(payload.agent_runtime),
      capabilities: { email: tools.includes("email"), phone: tools.includes("phone") },
      approvalMode: (payload.permissions?.requires_human_approval ?? true) ? "always" : "autonomous",
      createdAt: now,
      updatedAt: now
    };
    await collections.agents.insertOne(agent);

    // Default policies row; the email/phone policy shapes land in tasks 019/028.
    const policy: PolicyDocument = {
      _id: new ObjectId(),
      agentId: agent._id,
      email: {},
      phone: {},
      createdAt: now,
      updatedAt: now
    };
    await collections.policies.insertOne(policy);
    let emailAddress: string | null = null;
    if (agent.capabilities.email) {
      try {
        await getProvisioner("email").provision(agent);
        emailAddress = (await collections.emailAccounts.findOne({ agentId: agent._id, status: "active" }))?.address ?? null;
      } catch (error) {
        await Promise.all([
          collections.agents.deleteOne({ _id: agent._id }),
          collections.policies.deleteMany({ agentId: agent._id }),
          collections.emailAccounts.deleteMany({ agentId: agent._id })
        ]);
        throw error;
      }
    }

    const { plaintext } = await issueIdentityToken(collections, agent._id, "default", {
      mode: identityTokenMode(config)
    });

    await recordAudit(collections, {
      agentId: agent._id,
      ownerUserId,
      actor: "system",
      action: AUDIT_ACTIONS.identity.init,
      status: "allowed",
      detail: `${agent.name} initialized for ${agent.runtime}.`
    });

    const identity = agentIdentityView(agent);
    return reply.code(201).send({
      agent_id: identity.id,
      identity_token: plaintext,
      status: agent.status,
      runtime: agent.runtime,
      use_case: agent.description,
      // Real phone provisioning lands in a later task; card is deferred.
      email: emailAddress,
      phone: null,
      payment: null,
      tools,
      permissions: serializePermissions(identity),
      openclaw_env: {
        IDENTITY_LAYER_API_URL: config.PUBLIC_API_URL,
        AGENT_IDENTITY_TOKEN: plaintext
      },
      tool_endpoints: {
        email_request: `${config.PUBLIC_API_URL}/api/tools/email/request`,
        email_send: `${config.PUBLIC_API_URL}/api/tools/email/send`,
        email_send_v1: `${config.PUBLIC_API_URL}/api/v1/agent/email/send`,
        email_pause: `${config.PUBLIC_API_URL}/api/tools/email/pause`,
        email_resume: `${config.PUBLIC_API_URL}/api/tools/email/resume`,
        email_activity: `${config.PUBLIC_API_URL}/api/identity/${identity.id}/email-activity`,
        phone_call: `${config.PUBLIC_API_URL}/api/tools/phone/call`,
        calendar_book: `${config.PUBLIC_API_URL}/api/tools/calendar/book`,
        payment_request_purchase: `${config.PUBLIC_API_URL}/api/tools/payments/request-purchase`,
        payment_request_purchase_from_text: `${config.PUBLIC_API_URL}/api/tools/payments/request-purchase-from-text`,
        payment_activity: `${config.PUBLIC_API_URL}/api/identity/${identity.id}/payment-activity`,
        audit_log: `${config.PUBLIC_API_URL}/api/identity/${identity.id}/audit-log`,
        token_rotate: `${config.PUBLIC_API_URL}/api/identity/tokens/rotate`
      }
    });
  });

  app.post("/api/tools/phone/call", async (request, reply) => {
    const agentContext = await authenticateAgentRequest(request, collections);
    if (!agentContext) {
      throw new ApiError(401, "unauthorized", "missing or invalid identity token");
    }
    const identity = agentIdentityView(agentContext.agent);

    const payload = phoneCallSchema.parse(request.body ?? {});
    const block = checkAction(identity, "phone.call", payload.approved);
    if (block) {
      await recordAudit(collections, {
        agentId: agentContext.agent._id,
        ownerUserId: agentContext.agent.ownerUserId,
        actor: "agent",
        action: AUDIT_ACTIONS.phone.outbound,
        status: "blocked",
        detail: block
      });
      throw new ApiError(403, block === "human approval is required for this action" ? "approval_required" : "forbidden", block);
    }

    const transcript = [
      `${identity.name}: Hi, I am calling on behalf of the team to ask two quick validation questions.`,
      "Prospect: Sure, I can spare a minute.",
      `${identity.name}: What is painful about the current workflow?`,
      "Prospect: The manual follow-up is the part we never keep up with."
    ];
    await recordAudit(collections, {
      agentId: agentContext.agent._id,
      ownerUserId: agentContext.agent.ownerUserId,
      actor: "agent",
      action: AUDIT_ACTIONS.phone.outbound,
      status: "allowed",
      detail: `Simulated call placed to ${payload.to}.`
    });
    return {
      ok: true,
      provider: "demo-twilio",
      call_id: `call_${randomId(12)}`,
      // Real phone number provisioning lands in a later task.
      from: null,
      to: payload.to,
      transcript
    };
  });

  app.post("/api/tools/calendar/book", async (request, reply) => {
    const agentContext = await authenticateAgentRequest(request, collections);
    if (!agentContext) {
      throw new ApiError(401, "unauthorized", "missing or invalid identity token");
    }
    const identity = agentIdentityView(agentContext.agent);

    const payload = calendarBookSchema.parse(request.body ?? {});
    const block = checkAction(identity, "calendar.create", payload.approved);
    if (block) {
      await recordAudit(collections, {
        agentId: agentContext.agent._id,
        ownerUserId: agentContext.agent.ownerUserId,
        actor: "agent",
        action: "calendar.create",
        status: "blocked",
        detail: block
      });
      throw new ApiError(403, block === "human approval is required for this action" ? "approval_required" : "forbidden", block);
    }

    await recordAudit(collections, {
      agentId: agentContext.agent._id,
      ownerUserId: agentContext.agent.ownerUserId,
      actor: "agent",
      action: "calendar.create",
      status: "allowed",
      detail: `Meeting booked with ${payload.attendee_email}: ${payload.title}`
    });
    return {
      ok: true,
      provider: "demo-calendar",
      event_id: `evt_${randomId(12)}`,
      title: payload.title,
      attendee_email: payload.attendee_email,
      start_time: payload.start_time
    };
  });

  app.get("/api/identity/:agentId/audit-log", async (request, reply) => {
    const agentContext = await authenticateAgentRequest(request, collections);
    if (!agentContext) {
      throw new ApiError(401, "unauthorized", "missing or invalid identity token");
    }

    const { agentId } = request.params as { agentId: string };
    if (agentContext.agent._id.toHexString() !== agentId) {
      throw new ApiError(403, "forbidden", "identity token does not match requested agent");
    }

    const { entries } = await listAuditEntries(collections, {
      agentId: agentContext.agent._id,
      limit: 100
    });

    return {
      agent_id: agentId,
      status: agentContext.agent.status,
      audit_log: entries.map((entry) => {
        const serialized = serializeAuditEntry(entry);
        return {
          id: serialized.id,
          agent_id: serialized.agent_id,
          action: serialized.action,
          status: serialized.status,
          detail: serialized.detail,
          created_at: serialized.created_at
        };
      })
    };
  });

  app.post("/api/identity/revoke", async (request, reply) => {
    const agentContext = await authenticateAgentRequest(request, collections);
    if (!agentContext) {
      throw new ApiError(401, "unauthorized", "missing or invalid identity token");
    }

    await collections.identityTokens.updateOne(
      { _id: agentContext.token._id },
      { $set: { status: "revoked", updatedAt: new Date() } }
    );
    await recordAudit(collections, {
      agentId: agentContext.agent._id,
      ownerUserId: agentContext.agent.ownerUserId,
      actor: "agent",
      action: AUDIT_ACTIONS.identity.revoke,
      status: "allowed",
      detail: `Identity token ${agentContext.token.prefix}… revoked.`
    });
    return {
      ok: true,
      agent_id: agentContext.agent._id.toHexString(),
      status: "revoked"
    };
  });

  app.post("/api/identity/tokens/rotate", async (request, reply) => {
    const agentContext = await authenticateAgentRequest(request, collections);
    if (!agentContext) {
      throw new ApiError(401, "unauthorized", "missing or invalid identity token");
    }

    // Issue the replacement before revoking the old token so the agent is
    // never left without a working credential.
    const { plaintext, tokenDoc } = await issueIdentityToken(
      collections,
      agentContext.agent._id,
      agentContext.token.name,
      { mode: identityTokenMode(config) }
    );
    await collections.identityTokens.updateOne(
      { _id: agentContext.token._id },
      { $set: { status: "revoked", updatedAt: new Date() } }
    );
    await recordAudit(collections, {
      agentId: agentContext.agent._id,
      ownerUserId: agentContext.agent.ownerUserId,
      actor: "agent",
      action: AUDIT_ACTIONS.identity.tokenRotate,
      status: "allowed",
      detail: `Identity token ${agentContext.token.prefix}… rotated to ${tokenDoc.prefix}….`
    });
    return {
      ok: true,
      agent_id: agentContext.agent._id.toHexString(),
      identity_token: plaintext,
      token_prefix: tokenDoc.prefix
    };
  });
}

function checkAction(identity: AgentIdentity, permission: PermissionName, approved: boolean | undefined): string | null {
  if (identity.status !== "active") {
    return "identity is revoked";
  }

  if (!identity.permissions[permission]) {
    return `permission denied: ${permission}`;
  }

  if (identity.permissions.requiresHumanApproval && approved !== true) {
    return "human approval is required for this action";
  }

  return null;
}

export async function reserveAgentSlug(
  collections: Collections,
  ownerUserId: ObjectId | null,
  agentName: string
): Promise<string> {
  const baseSlug = slugify(agentName);
  let candidate = baseSlug;
  let suffix = 2;
  while (await collections.agents.findOne({ ownerUserId, slug: candidate })) {
    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function normalizeRuntime(runtime: string): NonNullable<AgentDocument["runtime"]> {
  const normalized = runtime.trim().toLowerCase();
  if (normalized === "openclaw" || normalized === "hermes" || normalized === "api") {
    return normalized;
  }
  return "other";
}

export function identityTokenMode(config: AppConfig): IdentityTokenMode {
  return config.PROVIDER_MODE_EMAIL === "mock" && config.PROVIDER_MODE_PHONE === "mock" ? "test" : "live";
}

function serializePermissions(identity: AgentIdentity) {
  return {
    "email.send": identity.permissions["email.send"],
    "phone.call": identity.permissions["phone.call"],
    "calendar.create": identity.permissions["calendar.create"],
    "payment.purchase": identity.permissions["payment.purchase"],
    requires_human_approval: identity.permissions.requiresHumanApproval
  };
}

function randomId(byteLength: number): string {
  return crypto.randomBytes(byteLength).toString("base64url");
}
