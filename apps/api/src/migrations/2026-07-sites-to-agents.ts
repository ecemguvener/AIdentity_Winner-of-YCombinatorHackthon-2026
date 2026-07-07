import { ObjectId } from "mongodb";
import type { AgentDocument, IdentityTokenDocument } from "../db.js";
import { slugify } from "../lib/slug.js";
import type { MigrationContext, MigrationResult } from "./types.js";

export const name = "2026-07-sites-to-agents";

// Migrates legacy sites -> agents, orphan atlasProjects (setups never completed)
// -> provisioning agents, and apiKeys -> identityTokens. Idempotent: rows already
// linked via legacySiteId/legacyProjectId/tokenHash are skipped.
export async function run({ collections, dryRun }: MigrationContext): Promise<MigrationResult> {
  const now = new Date();
  const stats = { migratedSites: 0, migratedSetups: 0, migratedKeys: 0, skipped: 0 };
  const usedSlugsByOwner = new Map<string, Set<string>>();
  const agentIdByLegacySiteId = new Map<string, ObjectId>();
  const agentIdByLegacyProjectId = new Map<string, ObjectId>();

  async function reserveSlug(ownerUserId: ObjectId, agentName: string): Promise<string> {
    const ownerKey = ownerUserId.toHexString();
    let ownerSlugs = usedSlugsByOwner.get(ownerKey);
    if (!ownerSlugs) {
      const existingAgents = await collections.agents
        .find({ ownerUserId }, { projection: { slug: 1 } })
        .toArray();
      ownerSlugs = new Set(existingAgents.map((agent) => agent.slug));
      usedSlugsByOwner.set(ownerKey, ownerSlugs);
    }
    const baseSlug = slugify(agentName);
    let candidate = baseSlug;
    let suffix = 2;
    while (ownerSlugs.has(candidate)) {
      candidate = `${baseSlug}-${suffix}`;
      suffix += 1;
    }
    ownerSlugs.add(candidate);
    return candidate;
  }

  const sites = await collections.sites.find({}).toArray();
  for (const site of sites) {
    const existingAgent = await collections.agents.findOne({ legacySiteId: site._id });
    if (existingAgent) {
      agentIdByLegacySiteId.set(site._id.toHexString(), existingAgent._id);
      stats.skipped += 1;
      continue;
    }
    const agent: AgentDocument = {
      _id: new ObjectId(),
      ownerUserId: site.ownerUserId,
      name: site.name,
      slug: await reserveSlug(site.ownerUserId, site.name),
      status: "active",
      runtime: "openclaw",
      capabilities: { email: false, phone: false },
      approvalMode: "always",
      legacySiteId: site._id,
      createdAt: site.createdAt,
      updatedAt: now
    };
    if (!dryRun) {
      await collections.agents.insertOne(agent);
    }
    agentIdByLegacySiteId.set(site._id.toHexString(), agent._id);
    stats.migratedSites += 1;
  }

  const orphanSetups = await collections.atlasProjects
    .find({ siteId: { $exists: false } })
    .toArray();
  for (const setup of orphanSetups) {
    const existingAgent = await collections.agents.findOne({ legacyProjectId: setup.projectId });
    if (existingAgent) {
      agentIdByLegacyProjectId.set(setup.projectId, existingAgent._id);
      stats.skipped += 1;
      continue;
    }
    const agent: AgentDocument = {
      _id: new ObjectId(),
      ownerUserId: setup.ownerUserId,
      name: setup.name,
      slug: await reserveSlug(setup.ownerUserId, setup.name),
      status: "provisioning",
      runtime: "openclaw",
      capabilities: { email: false, phone: false },
      approvalMode: "always",
      legacyProjectId: setup.projectId,
      createdAt: setup.createdAt,
      updatedAt: now
    };
    if (!dryRun) {
      await collections.agents.insertOne(agent);
    }
    agentIdByLegacyProjectId.set(setup.projectId, agent._id);
    stats.migratedSetups += 1;
  }

  const apiKeys = await collections.apiKeys.find({}).toArray();
  for (const apiKey of apiKeys) {
    const existingToken = await collections.identityTokens.findOne({ tokenHash: apiKey.keyHash });
    if (existingToken) {
      stats.skipped += 1;
      continue;
    }
    let agentId: ObjectId | undefined;
    if (apiKey.siteId) {
      agentId = agentIdByLegacySiteId.get(apiKey.siteId.toHexString());
    }
    if (!agentId && apiKey.projectId) {
      agentId = agentIdByLegacyProjectId.get(apiKey.projectId);
    }
    if (!agentId) {
      stats.skipped += 1;
      continue;
    }
    const token: IdentityTokenDocument = {
      _id: new ObjectId(),
      agentId,
      ownerUserId: apiKey.userId,
      tokenHash: apiKey.keyHash,
      prefix: apiKey.prefix,
      name: apiKey.name,
      status: "active",
      ...(apiKey.lastUsedAt ? { lastUsedAt: apiKey.lastUsedAt } : {}),
      createdAt: apiKey.createdAt,
      updatedAt: now
    };
    if (!dryRun) {
      await collections.identityTokens.insertOne(token);
    }
    stats.migratedKeys += 1;
  }

  const summary = `migrated ${stats.migratedSites} sites, ${stats.migratedSetups} setups, ${stats.migratedKeys} keys, skipped ${stats.skipped}`;
  return { stats, summary };
}
