import { MongoServerError, ObjectId } from "mongodb";
import type { AppConfig } from "./config.js";
import type { AgentDocument, Collections, EmailAccountDocument } from "./db.js";
import { ApiError } from "./errors.js";
import { getDomainStatus, type ResendDomainsClient } from "./providers/resend-domain.js";
import { registerProvisioner } from "./provisioning.js";
import { AUDIT_ACTIONS, recordAudit } from "./audit.js";
import { slugify } from "./lib/slug.js";

const maxLocalPartLength = 30;
const reservedLocalParts = new Set(["admin", "postmaster", "abuse", "no-reply", "support", "billing"]);

export function registerEmailProvisioner(
  collections: Collections,
  config: AppConfig,
  domainsClient?: ResendDomainsClient
): void {
  registerProvisioner("email", {
    provision: async (agent) => {
      await provisionAgentEmailAccount(collections, config, agent, domainsClient);
    },
    deprovision: (agent) => pauseAgentEmailAccount(collections, agent),
    status: (agent) => getAgentEmailProvisioningStatus(collections, agent)
  });
}

export async function provisionAgentEmailAccount(
  collections: Collections,
  config: AppConfig,
  agent: AgentDocument,
  domainsClient?: ResendDomainsClient
): Promise<EmailAccountDocument> {
  const existing = await collections.emailAccounts.findOne({
    agentId: agent._id,
    status: { $in: ["active", "paused"] }
  });
  if (existing) {
    if (existing.status === "paused") {
      const reactivated = await collections.emailAccounts.findOneAndUpdate(
        { _id: existing._id },
        { $set: { status: "active", displayName: agent.name, updatedAt: new Date() } },
        { returnDocument: "after" }
      );
      await setAgentEmailFlag(collections, agent, true);
      return reactivated ?? existing;
    }
    await setAgentEmailFlag(collections, agent, true);
    return existing;
  }

  await assertEmailDomainReady(config, domainsClient);

  const now = new Date();
  for (const localPart of candidateLocalParts(agent.name)) {
    const account: EmailAccountDocument = {
      _id: new ObjectId(),
      agentId: agent._id,
      address: `${localPart}@${config.EMAIL_AGENT_DOMAIN.toLowerCase()}`,
      displayName: agent.name,
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    try {
      await collections.emailAccounts.insertOne(account);
      await setAgentEmailFlag(collections, agent, true);
      await recordAudit(collections, {
        agentId: agent._id,
        ownerUserId: agent.ownerUserId,
        actor: "system",
        action: AUDIT_ACTIONS.email.provisioned,
        status: "allowed",
        detail: `Email address ${account.address} provisioned.`,
        resourceType: "emailAccount",
        resourceId: account._id.toHexString()
      });
      return account;
    } catch (error) {
      if (isDuplicateKey(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new ApiError(409, "validation_failed", "could not allocate a unique email address");
}

export async function pauseAgentEmailAccount(collections: Collections, agent: AgentDocument): Promise<void> {
  const now = new Date();
  const account = await collections.emailAccounts.findOneAndUpdate(
    { agentId: agent._id, status: "active" },
    { $set: { status: "paused", updatedAt: now } },
    { returnDocument: "after" }
  );
  await setAgentEmailFlag(collections, agent, false);
  if (account) {
    await recordAudit(collections, {
      agentId: agent._id,
      ownerUserId: agent.ownerUserId,
      actor: "system",
      action: AUDIT_ACTIONS.email.paused,
      status: "allowed",
      detail: `Email address ${account.address} paused.`,
      resourceType: "emailAccount",
      resourceId: account._id.toHexString()
    });
  }
}

export async function getAgentEmailProvisioningStatus(collections: Collections, agent: AgentDocument) {
  const account = await collections.emailAccounts.findOne(
    { agentId: agent._id },
    { sort: { createdAt: -1 } }
  );
  if (!account) {
    return { state: "not_provisioned" as const };
  }
  return { state: account.status, detail: account.address };
}

export function allocateEmailLocalPartCandidates(agentName: string): string[] {
  return [...candidateLocalParts(agentName)];
}

function* candidateLocalParts(agentName: string): Generator<string> {
  const rawBase = clampLocalPart(slugify(agentName));
  const base = reservedLocalParts.has(rawBase) ? clampLocalPart(`agent-${rawBase}`) : rawBase;
  yield base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const suffixText = `-${suffix}`;
    yield `${base.slice(0, maxLocalPartLength - suffixText.length).replace(/-+$/, "")}${suffixText}`;
  }
}

function clampLocalPart(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLocalPartLength)
    .replace(/-+$/g, "");
  return cleaned || "agent";
}

async function assertEmailDomainReady(config: AppConfig, domainsClient?: ResendDomainsClient): Promise<void> {
  if (config.PROVIDER_MODE_EMAIL !== "live") {
    return;
  }
  let status;
  try {
    status = await getDomainStatus(config, domainsClient);
  } catch (error) {
    throw new ApiError(
      502,
      "provider_error",
      `could not verify Resend domain ${config.EMAIL_AGENT_DOMAIN}: ${(error as Error).message}`
    );
  }
  if (status.verified) {
    return;
  }
  throw new ApiError(
    502,
    "provider_error",
    `Resend domain ${status.name} is not verified; add the missing DNS records`,
    { records: status.records }
  );
}

async function setAgentEmailFlag(collections: Collections, agent: AgentDocument, enabled: boolean): Promise<void> {
  await collections.agents.updateOne(
    { _id: agent._id },
    { $set: { "capabilities.email": enabled, updatedAt: new Date() } }
  );
  agent.capabilities.email = enabled;
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}
