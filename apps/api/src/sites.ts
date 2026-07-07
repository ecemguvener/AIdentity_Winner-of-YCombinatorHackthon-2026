import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { AgentDocument, Collections, IdentityTokenDocument } from "./db.js";
import { ApiError } from "./errors.js";
import { requireAuth } from "./auth.js";
import { recordAudit } from "./audit.js";
import { findOwnedLegacyAgent, issueOwnerToken, revokeAgentAndTokens } from "./agents-routes.js";
import { identityTokenMode, reserveAgentSlug } from "./identity.js";
import { createAtlasProjectId, isAtlasProjectId, serializeSite } from "./security.js";
import { issueIdentityToken } from "./agent-auth.js";

// ---------------------------------------------------------------------------
// DEPRECATED legacy sites/site-setups routes, kept as thin adapters over the
// `agents` collection until the web UI migrates to /api/v1/agents (task 012).
// Response shapes match apps/web/src/api.ts; every response carries a
// `deprecation: true` header.
//   site           -> agent (site id = agent id)
//   site setup     -> provisioning agent (projectId = agent.legacyProjectId)
//   site api key   -> identity token
// ---------------------------------------------------------------------------

const updateSiteSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  domain: z.string().min(1).max(255).optional()
});

const createSiteApiKeySchema = z.object({
  name: z.string().min(1).max(80).optional()
});

const siteSetupSchema = z.object({
  name: z.string().min(1).max(80),
  domain: z.string().min(1).max(255)
});

export function registerSiteRoutes(
  app: FastifyInstance,
  collections: Collections,
  config: AppConfig
) {
  app.register(async (legacyApp) => {
    legacyApp.addHook("onSend", async (_request, reply, payload) => {
      reply.header("deprecation", "true");
      return payload;
    });

    legacyApp.get("/api/sites", async (request, reply) => {
      const authContext = await requireAuth(request, reply, collections, config);
      const agents = await collections.agents
        .find({ ownerUserId: authContext.user._id, status: { $ne: "revoked" } })
        .sort({ createdAt: -1 })
        .toArray();
      const domains = await loadLegacyDomains(collections, agents);
      return { sites: agents.map((agent) => serializeAgentAsSite(agent, domains)) };
    });

    legacyApp.post("/api/sites", async (request, reply) => {
      await requireAuth(request, reply, collections, config);
      throw new ApiError(409, "validation_failed", "Create an agent identity setup before creating the identity.");
    });

    legacyApp.post("/api/site-setups", async (request, reply) => {
      const authContext = await requireAuth(request, reply, collections, config);
      const payload = siteSetupSchema.parse(request.body);

      const now = new Date();
      const agent: AgentDocument = {
        _id: new ObjectId(),
        ownerUserId: authContext.user._id,
        name: payload.name.trim(),
        slug: await reserveAgentSlug(collections, authContext.user._id, payload.name),
        status: "provisioning",
        runtime: "openclaw",
        capabilities: { email: false, phone: false },
        approvalMode: "always",
        legacyProjectId: createAtlasProjectId(),
        legacyDomain: normalizeDomain(payload.domain),
        createdAt: now,
        updatedAt: now
      };
      await collections.agents.insertOne(agent);
      await collections.policies.insertOne({
        _id: new ObjectId(),
        agentId: agent._id,
        email: {},
        phone: {},
        createdAt: now,
        updatedAt: now
      });
      const { plaintext, tokenDoc } = await issueIdentityToken(collections, agent._id, `${agent.name} link token`, {
        mode: identityTokenMode(config)
      });
      await recordAudit(collections, {
        agentId: agent._id,
        ownerUserId: authContext.user._id,
        actor: "owner",
        action: "agent.create",
        status: "allowed",
        detail: `Agent ${agent.name} created via legacy site setup.`
      });

      return reply.code(201).send({
        setup: serializeAgentAsSetup(agent),
        apiKey: serializeTokenAsApiKey(tokenDoc),
        secret: plaintext
      });
    });

    legacyApp.get("/api/site-setups/:projectId", async (request, reply) => {
      const authContext = await requireAuth(request, reply, collections, config);
      const agent = await findAgentBySetupProjectId(collections, authContext.user._id, request.params);
      return {
        setup: serializeAgentAsSetup(agent),
        apiKeys: await listActiveTokensAsApiKeys(collections, agent)
      };
    });

    legacyApp.post("/api/site-setups/:projectId/complete", async (request, reply) => {
      const authContext = await requireAuth(request, reply, collections, config);
      const agent = await findAgentBySetupProjectId(collections, authContext.user._id, request.params);
      if (agent.status === "provisioning") {
        agent.status = "active";
        agent.updatedAt = new Date();
        await collections.agents.updateOne(
          { _id: agent._id },
          { $set: { status: "active", updatedAt: agent.updatedAt } }
        );
      }

      const domains = await loadLegacyDomains(collections, [agent]);
      return {
        site: serializeAgentAsSite(agent, domains),
        apiKeys: await listActiveTokensAsApiKeys(collections, agent)
      };
    });

    legacyApp.get("/api/sites/:siteId", async (request, reply) => {
      const authContext = await requireAuth(request, reply, collections, config);
      const agent = await findOwnedLegacyAgent(collections, authContext.user._id, request.params);
      const domains = await loadLegacyDomains(collections, [agent]);
      return {
        site: serializeAgentAsSite(agent, domains),
        apiKeys: await listActiveTokensAsApiKeys(collections, agent)
      };
    });

    legacyApp.patch("/api/sites/:siteId", async (request, reply) => {
      const authContext = await requireAuth(request, reply, collections, config);
      const agent = await findOwnedLegacyAgent(collections, authContext.user._id, request.params);
      const payload = updateSiteSchema.parse(request.body);

      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (payload.name) {
        update.name = payload.name.trim();
      }
      if (payload.domain) {
        update.legacyDomain = normalizeDomain(payload.domain);
      }

      const updated = await collections.agents.findOneAndUpdate(
        { _id: agent._id },
        { $set: update },
        { returnDocument: "after" }
      );
      if (!updated) {
        throw new ApiError(404, "not_found", "site not found");
      }
      await recordAudit(collections, {
        agentId: agent._id,
        ownerUserId: authContext.user._id,
        actor: "owner",
        action: "agent.update",
        status: "allowed",
        detail: `Agent ${updated.name} updated via legacy site route.`
      });

      const domains = await loadLegacyDomains(collections, [updated]);
      return { site: serializeAgentAsSite(updated, domains) };
    });

    legacyApp.delete("/api/sites/:siteId", async (request, reply) => {
      const authContext = await requireAuth(request, reply, collections, config);
      const agent = await findOwnedLegacyAgent(collections, authContext.user._id, request.params);
      await revokeAgentAndTokens(collections, agent, authContext.user._id);
      return { ok: true };
    });

    legacyApp.post("/api/sites/:siteId/api-keys", async (request, reply) => {
      const authContext = await requireAuth(request, reply, collections, config);
      const agent = await findOwnedLegacyAgent(collections, authContext.user._id, request.params);
      const payload = createSiteApiKeySchema.parse(request.body ?? {});

      const name = payload.name?.trim() || `${agent.name} link token`;
      const { plaintext, tokenDoc } = await issueOwnerToken(collections, config, agent, name);
      await recordAudit(collections, {
        agentId: agent._id,
        ownerUserId: authContext.user._id,
        actor: "owner",
        action: "agent.token.create",
        status: "allowed",
        detail: `Identity token ${tokenDoc.prefix}… (${name}) created via legacy site route.`
      });

      return reply.code(201).send({
        apiKey: serializeTokenAsApiKey(tokenDoc),
        secret: plaintext
      });
    });

    legacyApp.delete("/api/sites/:siteId/api-keys/:apiKeyId", async (request, reply) => {
      const authContext = await requireAuth(request, reply, collections, config);
      const agent = await findOwnedLegacyAgent(collections, authContext.user._id, request.params);
      const { apiKeyId } = request.params as { apiKeyId: string };
      if (!ObjectId.isValid(apiKeyId)) {
        throw new ApiError(404, "not_found", "link token not found");
      }

      const token = await collections.identityTokens.findOneAndUpdate(
        { _id: new ObjectId(apiKeyId), agentId: agent._id },
        { $set: { status: "revoked", updatedAt: new Date() } },
        { returnDocument: "after" }
      );
      if (!token) {
        throw new ApiError(404, "not_found", "link token not found");
      }
      await recordAudit(collections, {
        agentId: agent._id,
        ownerUserId: authContext.user._id,
        actor: "owner",
        action: "agent.token.revoke",
        status: "allowed",
        detail: `Identity token ${token.prefix}… (${token.name}) revoked via legacy site route.`
      });

      return { ok: true };
    });
  });
}

// ---------------------------------------------------------------------------
// Adapter helpers
// ---------------------------------------------------------------------------

async function findAgentBySetupProjectId(
  collections: Collections,
  ownerUserId: ObjectId,
  params: unknown
): Promise<AgentDocument> {
  const projectId = (params as { projectId?: string }).projectId ?? "";
  if (!isAtlasProjectId(projectId)) {
    throw new ApiError(404, "not_found", "site setup not found");
  }
  const agent = await collections.agents.findOne({
    ownerUserId,
    legacyProjectId: projectId,
    status: { $ne: "revoked" }
  });
  if (!agent) {
    throw new ApiError(404, "not_found", "site setup not found");
  }
  return agent;
}

async function listActiveTokensAsApiKeys(collections: Collections, agent: AgentDocument) {
  const tokens = await collections.identityTokens
    .find({ agentId: agent._id, status: "active" })
    .sort({ createdAt: -1 })
    .toArray();
  return tokens.map(serializeTokenAsApiKey);
}

/**
 * Migrated agents (task 005) carry no legacyDomain of their own — resolve it
 * from the linked legacy site row in one batch.
 */
async function loadLegacyDomains(collections: Collections, agents: AgentDocument[]): Promise<Map<string, string>> {
  const domains = new Map<string, string>();
  const legacySiteIds = agents
    .filter((agent) => !agent.legacyDomain && agent.legacySiteId)
    .map((agent) => agent.legacySiteId as ObjectId);
  if (legacySiteIds.length === 0) {
    return domains;
  }

  const sites = await collections.sites.find({ _id: { $in: legacySiteIds } }).toArray();
  const domainBySiteId = new Map(sites.map((site) => [site._id.toHexString(), site.domain]));
  for (const agent of agents) {
    if (!agent.legacyDomain && agent.legacySiteId) {
      const domain = domainBySiteId.get(agent.legacySiteId.toHexString());
      if (domain) {
        domains.set(agent._id.toHexString(), domain);
      }
    }
  }
  return domains;
}

function serializeAgentAsSite(agent: AgentDocument, legacyDomains: Map<string, string>) {
  return serializeSite({
    _id: agent._id,
    name: agent.name,
    domain: agent.legacyDomain ?? legacyDomains.get(agent._id.toHexString()) ?? "",
    publicSiteKey: `site_${agent._id.toHexString()}`,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  });
}

function serializeAgentAsSetup(agent: AgentDocument) {
  return {
    projectId: agent.legacyProjectId ?? "",
    name: agent.name,
    domain: agent.legacyDomain ?? "",
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString()
  };
}

function serializeTokenAsApiKey(token: IdentityTokenDocument) {
  return {
    id: token._id.toHexString(),
    name: token.name,
    prefix: token.prefix,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt ? token.lastUsedAt.toISOString() : null
  };
}

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}
