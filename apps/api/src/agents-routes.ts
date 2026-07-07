import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { AgentDocument, Collections, IdentityTokenDocument } from "./db.js";
import { ApiError } from "./errors.js";
import { requireAuth } from "./auth.js";
import { issueIdentityToken } from "./agent-auth.js";
import { recordAudit } from "./audit.js";
import { identityTokenMode, reserveAgentSlug } from "./identity.js";
import {
  CAPABILITY_NAMES,
  capabilityProvisioningSummary,
  getProvisioner,
  isCapabilityName,
  registerStubProvisioners,
  type CapabilityName
} from "./provisioning.js";
import { defaultEmailPolicy } from "./policies.js";

// ---------------------------------------------------------------------------
// Owner-facing agents REST API (v1). Replaces the legacy sites/site-setups
// flow; sites.ts remains as a thin deprecated adapter over the same data.
// ---------------------------------------------------------------------------

export const MAX_ACTIVE_TOKENS_PER_AGENT = 5;

const createAgentSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  runtime: z.enum(["openclaw", "hermes", "api", "other"]).optional(),
  capabilities: z
    .object({
      email: z.boolean().optional(),
      phone: z.boolean().optional()
    })
    .optional(),
  approvalMode: z.enum(["always", "policy", "autonomous"]).optional()
});

const updateAgentSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
  approvalMode: z.enum(["always", "policy", "autonomous"]).optional(),
  status: z.enum(["active", "paused"]).optional()
});

const createTokenSchema = z.object({
  name: z.string().min(1).max(80).optional()
});

export function registerAgentRoutes(app: FastifyInstance, collections: Collections, config: AppConfig) {
  registerStubProvisioners(collections);

  app.post("/api/v1/agents", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const payload = createAgentSchema.parse(request.body ?? {});

    const now = new Date();
    const agent: AgentDocument = {
      _id: new ObjectId(),
      ownerUserId: authContext.user._id,
      name: payload.name.trim(),
      slug: await reserveAgentSlug(collections, authContext.user._id, payload.name),
      status: "active",
      ...(payload.description?.trim() ? { description: payload.description.trim() } : {}),
      runtime: payload.runtime ?? "openclaw",
      capabilities: {
        email: payload.capabilities?.email ?? false,
        phone: payload.capabilities?.phone ?? false
      },
      approvalMode: payload.approvalMode ?? "always",
      createdAt: now,
      updatedAt: now
    };
    await collections.agents.insertOne(agent);
    await collections.policies.insertOne({
      _id: new ObjectId(),
      agentId: agent._id,
      email: defaultEmailPolicy(agent.approvalMode),
      phone: {},
      createdAt: now,
      updatedAt: now
    });
    try {
      await provisionInitialCapabilities(agent);
    } catch (error) {
      await Promise.all([
        collections.agents.deleteOne({ _id: agent._id }),
        collections.policies.deleteMany({ agentId: agent._id }),
        collections.emailAccounts.deleteMany({ agentId: agent._id })
      ]);
      throw error;
    }

    const { plaintext, tokenDoc } = await issueIdentityToken(collections, agent._id, "default", {
      mode: identityTokenMode(config)
    });
    await recordAudit(collections, {
      agentId: agent._id,
      ownerUserId: authContext.user._id,
      actor: "owner",
      action: "agent.create",
      status: "allowed",
      detail: `Agent ${agent.name} created.`
    });

    return reply.code(201).send({
      agent: await serializeAgentWithContacts(collections, agent),
      identityToken: { secret: plaintext, prefix: tokenDoc.prefix }
    });
  });

  app.get("/api/v1/agents", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const agents = await collections.agents
      .find({ ownerUserId: authContext.user._id, status: { $ne: "revoked" } })
      .sort({ createdAt: -1 })
      .toArray();
    const contacts = await loadContactPoints(collections, agents.map((agent) => agent._id));
    return {
      agents: await Promise.all(
        agents.map(async (agent) => ({
          ...serializeAgent(agent, contacts.get(agent._id.toHexString())),
          provisioning: await capabilityProvisioningSummary(agent)
        }))
      )
    };
  });

  app.get("/api/v1/agents/:agentId", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const agent = await findOwnedAgent(collections, authContext.user._id, request.params);
    const tokens = await collections.identityTokens
      .find({ agentId: agent._id })
      .sort({ createdAt: -1 })
      .toArray();
    return {
      agent: await serializeAgentWithContacts(collections, agent),
      tokens: tokens.map(serializeTokenRedacted),
      provisioning: await capabilityProvisioningSummary(agent)
    };
  });

  app.patch("/api/v1/agents/:agentId", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const agent = await findOwnedAgent(collections, authContext.user._id, request.params);
    requireNotRevoked(agent);
    const payload = updateAgentSchema.parse(request.body ?? {});

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (payload.name) update.name = payload.name.trim();
    if (payload.description !== undefined) update.description = payload.description?.trim() || undefined;
    if (payload.approvalMode) update.approvalMode = payload.approvalMode;
    if (payload.status) update.status = payload.status;

    const updated = await collections.agents.findOneAndUpdate(
      { _id: agent._id },
      { $set: update },
      { returnDocument: "after" }
    );
    if (!updated) {
      throw new ApiError(404, "not_found", "agent not found");
    }

    await recordAudit(collections, {
      agentId: agent._id,
      ownerUserId: authContext.user._id,
      actor: "owner",
      action: "agent.update",
      status: "allowed",
      detail: `Agent ${updated.name} updated (${Object.keys(update).filter((key) => key !== "updatedAt").join(", ") || "no-op"}).`
    });
    return { agent: await serializeAgentWithContacts(collections, updated) };
  });

  app.delete("/api/v1/agents/:agentId", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const agent = await findOwnedAgent(collections, authContext.user._id, request.params);
    await revokeAgentAndTokens(collections, agent, authContext.user._id);
    return { ok: true };
  });

  app.post("/api/v1/agents/:agentId/tokens", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const agent = await findOwnedAgent(collections, authContext.user._id, request.params);
    requireNotRevoked(agent);
    const payload = createTokenSchema.parse(request.body ?? {});

    const { plaintext, tokenDoc } = await issueOwnerToken(
      collections,
      config,
      agent,
      payload.name?.trim() || "api token"
    );
    await recordAudit(collections, {
      agentId: agent._id,
      ownerUserId: authContext.user._id,
      actor: "owner",
      action: "agent.token.create",
      status: "allowed",
      detail: `Identity token ${tokenDoc.prefix}… (${tokenDoc.name}) created.`
    });
    return reply.code(201).send({
      id: tokenDoc._id.toHexString(),
      name: tokenDoc.name,
      secret: plaintext,
      prefix: tokenDoc.prefix
    });
  });

  app.delete("/api/v1/agents/:agentId/tokens/:tokenId", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const agent = await findOwnedAgent(collections, authContext.user._id, request.params);
    const { tokenId } = request.params as { tokenId: string };
    if (!ObjectId.isValid(tokenId)) {
      throw new ApiError(404, "not_found", "token not found");
    }

    const token = await collections.identityTokens.findOneAndUpdate(
      { _id: new ObjectId(tokenId), agentId: agent._id },
      { $set: { status: "revoked", updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    if (!token) {
      throw new ApiError(404, "not_found", "token not found");
    }

    await recordAudit(collections, {
      agentId: agent._id,
      ownerUserId: authContext.user._id,
      actor: "owner",
      action: "agent.token.revoke",
      status: "allowed",
      detail: `Identity token ${token.prefix}… (${token.name}) revoked.`
    });
    return { ok: true };
  });

  app.post("/api/v1/agents/:agentId/capabilities/:capability/enable", (request, reply) =>
    handleCapabilityToggle(request, reply, "enable")
  );
  app.post("/api/v1/agents/:agentId/capabilities/:capability/disable", (request, reply) =>
    handleCapabilityToggle(request, reply, "disable")
  );

  async function handleCapabilityToggle(request: FastifyRequest, reply: FastifyReply, action: "enable" | "disable") {
    const authContext = await requireAuth(request, reply, collections, config);
    const capability = parseCapabilityParam(request.params);
    const agent = await findOwnedAgent(collections, authContext.user._id, request.params);
    requireNotRevoked(agent);

    const provisioner = getProvisioner(capability);
    // Provisioning runs async; the UI polls GET /api/v1/agents/:agentId.
    void Promise.resolve(action === "enable" ? provisioner.provision(agent) : provisioner.deprovision(agent)).catch(
      async (error) => {
        request.log.error({ error, capability, agentId: agent._id.toHexString() }, "capability provisioning failed");
        await recordAudit(collections, {
          agentId: agent._id,
          ownerUserId: authContext.user._id,
          actor: "system",
          action: `agent.capability.${action}`,
          status: "error",
          detail: `${capability} ${action} failed: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    );

    await recordAudit(collections, {
      agentId: agent._id,
      ownerUserId: authContext.user._id,
      actor: "owner",
      action: `agent.capability.${action}`,
      status: "pending",
      detail: `${capability} capability ${action} requested.`
    });
    return reply.code(202).send({ provisioning: { state: "pending", capability } });
  }

  async function provisionInitialCapabilities(agent: AgentDocument): Promise<void> {
    for (const capability of CAPABILITY_NAMES) {
      if (agent.capabilities[capability]) {
        await getProvisioner(capability).provision(agent);
      }
    }
  }
}

/** Issues a token for an owner-managed agent, enforcing the active-token cap. */
export async function issueOwnerToken(
  collections: Collections,
  config: AppConfig,
  agent: AgentDocument,
  name: string
): Promise<{ plaintext: string; tokenDoc: IdentityTokenDocument }> {
  const activeTokens = await collections.identityTokens.countDocuments({ agentId: agent._id, status: "active" });
  if (activeTokens >= MAX_ACTIVE_TOKENS_PER_AGENT) {
    throw new ApiError(
      409,
      "validation_failed",
      `an agent can have at most ${MAX_ACTIVE_TOKENS_PER_AGENT} active tokens; revoke one first`
    );
  }
  return issueIdentityToken(collections, agent._id, name, { mode: identityTokenMode(config) });
}

/** Soft delete: revoke the agent + every active token, then run capability teardown hooks. */
export async function revokeAgentAndTokens(
  collections: Collections,
  agent: AgentDocument,
  ownerUserId: ObjectId
): Promise<void> {
  const now = new Date();
  await collections.agents.updateOne({ _id: agent._id }, { $set: { status: "revoked", updatedAt: now } });
  await collections.identityTokens.updateMany(
    { agentId: agent._id, status: "active" },
    { $set: { status: "revoked", updatedAt: now } }
  );

  for (const capability of CAPABILITY_NAMES) {
    if (!agent.capabilities[capability]) {
      continue;
    }
    try {
      await getProvisioner(capability).deprovision(agent);
    } catch (error) {
      console.error(`capability ${capability} teardown failed for agent ${agent._id.toHexString()}`, error);
    }
  }

  await recordAudit(collections, {
    agentId: agent._id,
    ownerUserId,
    actor: "owner",
    action: "agent.delete",
    status: "allowed",
    detail: `Agent ${agent.name} revoked; all active tokens revoked.`
  });
}

export async function findOwnedAgent(
  collections: Collections,
  ownerUserId: ObjectId,
  params: unknown
): Promise<AgentDocument> {
  const agentId = (params as { agentId?: string }).agentId ?? "";
  if (!ObjectId.isValid(agentId)) {
    throw new ApiError(404, "not_found", "agent not found");
  }
  const agent = await collections.agents.findOne({ _id: new ObjectId(agentId), ownerUserId });
  if (!agent) {
    throw new ApiError(404, "not_found", "agent not found");
  }
  return agent;
}

/**
 * Legacy adapter lookup: accepts either the agent id or the pre-migration
 * legacy site id (stale ids from open dashboard tabs), and hides revoked
 * agents the way deleted sites used to 404.
 */
export async function findOwnedLegacyAgent(
  collections: Collections,
  ownerUserId: ObjectId,
  params: unknown
): Promise<AgentDocument> {
  const siteId = (params as { siteId?: string }).siteId ?? "";
  if (!ObjectId.isValid(siteId)) {
    throw new ApiError(404, "not_found", "site not found");
  }
  const id = new ObjectId(siteId);
  const agent = await collections.agents.findOne({
    ownerUserId,
    status: { $ne: "revoked" },
    $or: [{ _id: id }, { legacySiteId: id }]
  });
  if (!agent) {
    throw new ApiError(404, "not_found", "site not found");
  }
  return agent;
}

function requireNotRevoked(agent: AgentDocument): void {
  if (agent.status === "revoked") {
    throw new ApiError(409, "validation_failed", "agent is revoked");
  }
}

function parseCapabilityParam(params: unknown): CapabilityName {
  const capability = (params as { capability?: string }).capability ?? "";
  if (capability === "card") {
    throw new ApiError(400, "validation_failed", "card capability is coming soon");
  }
  if (!isCapabilityName(capability)) {
    throw new ApiError(400, "validation_failed", `unknown capability: ${capability}`);
  }
  return capability;
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

export interface AgentContactPoints {
  emailAddress?: string;
  phoneE164?: string;
}

export function serializeAgent(agent: AgentDocument, contacts?: AgentContactPoints) {
  return {
    id: agent._id.toHexString(),
    name: agent.name,
    slug: agent.slug,
    status: agent.status,
    description: agent.description ?? null,
    runtime: agent.runtime ?? null,
    capabilities: { email: agent.capabilities.email, phone: agent.capabilities.phone },
    approvalMode: agent.approvalMode,
    emailAddress: contacts?.emailAddress ?? null,
    phoneE164: contacts?.phoneE164 ?? null,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString()
  };
}

async function serializeAgentWithContacts(collections: Collections, agent: AgentDocument) {
  const contacts = await loadContactPoints(collections, [agent._id]);
  return serializeAgent(agent, contacts.get(agent._id.toHexString()));
}

async function loadContactPoints(
  collections: Collections,
  agentIds: ObjectId[]
): Promise<Map<string, AgentContactPoints>> {
  const contacts = new Map<string, AgentContactPoints>();
  if (agentIds.length === 0) {
    return contacts;
  }

  const [emailAccounts, phoneNumbers] = await Promise.all([
    collections.emailAccounts.find({ agentId: { $in: agentIds } }).toArray(),
    collections.phoneNumbers.find({ agentId: { $in: agentIds }, status: { $in: ["provisioning", "active"] } }).toArray()
  ]);
  for (const account of emailAccounts) {
    const key = account.agentId.toHexString();
    contacts.set(key, { ...contacts.get(key), emailAddress: account.address });
  }
  for (const phoneNumber of phoneNumbers) {
    const key = phoneNumber.agentId.toHexString();
    contacts.set(key, { ...contacts.get(key), phoneE164: phoneNumber.e164 });
  }
  return contacts;
}

function serializeTokenRedacted(token: IdentityTokenDocument) {
  return {
    id: token._id.toHexString(),
    name: token.name,
    prefix: token.prefix,
    status: token.status,
    lastUsedAt: token.lastUsedAt ? token.lastUsedAt.toISOString() : null,
    createdAt: token.createdAt.toISOString()
  };
}
