import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import JSZip from "jszip";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { AgentDocument, Collections, UserDocument } from "./db.js";
import { ApiError } from "./errors.js";
import { deletedEmailHash } from "./privacy.js";
import { getProvisioner } from "./provisioning.js";
import { getStripeClient } from "./providers/stripe-client.js";
import type { EmailProvider } from "./providers/email-provider.js";
import { hashSessionToken, verifyPassword } from "./security.js";

const exportHoldMs = 72 * 60 * 60 * 1000;
const exportRateLimitMs = 24 * 60 * 60 * 1000;

const deleteAccountSchema = z.object({
  password: z.string().min(1).max(128),
  confirm: z.literal("DELETE")
});

export function registerAccountRoutes(
  app: FastifyInstance,
  collections: Collections,
  config: AppConfig,
  emailProvider: EmailProvider
): void {
  app.post("/api/v1/account/export", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const recent = await collections.accountExports.findOne({
      ownerUserId: authContext.user._id,
      createdAt: { $gt: new Date(Date.now() - exportRateLimitMs) }
    });
    if (recent) {
      throw new ApiError(429, "rate_limited", "account export can be requested once per day");
    }
    const job = await createAccountExport(collections, config, authContext.user);
    const downloadUrl = `/api/v1/account/export/${job.exportId}/download?token=${encodeURIComponent(job.token)}`;
    void emailProvider.sendEmail({
      from: config.EMAIL_PLATFORM_FROM,
      to: authContext.user.email,
      subject: "Your Barkan account export is ready",
      text: `Your export is ready for 72 hours: ${config.PUBLIC_API_URL.replace(/\/$/, "")}${downloadUrl}`
    }).catch(() => undefined);
    return reply.code(202).send({ export_id: job.exportId, download_url: downloadUrl, expires_at: job.expiresAt.toISOString() });
  });

  app.get("/api/v1/account/export/:exportId/download", async (request, reply) => {
    const params = z.object({ exportId: z.string() }).parse(request.params ?? {});
    const query = z.object({ token: z.string().min(20) }).parse(request.query ?? {});
    if (!ObjectId.isValid(params.exportId)) {
      throw new ApiError(404, "not_found", "export not found");
    }
    const exportRow = await collections.accountExports.findOne({
      _id: new ObjectId(params.exportId),
      tokenHash: hashSessionToken(query.token, config.SESSION_SECRET),
      status: "ready",
      expiresAt: { $gt: new Date() }
    });
    if (!exportRow?.downloadPath) {
      throw new ApiError(404, "not_found", "export not found");
    }
    const archive = await fs.readFile(exportRow.downloadPath);
    await collections.accountExports.updateOne(
      { _id: exportRow._id },
      { $set: { status: "downloaded", downloadedAt: new Date(), updatedAt: new Date() } }
    );
    reply.header("content-type", "application/zip");
    reply.header("content-disposition", `attachment; filename="barkan-export-${exportRow._id.toHexString()}.zip"`);
    return archive;
  });

  app.delete("/api/v1/account", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const payload = deleteAccountSchema.parse(request.body ?? {});
    if (!(await verifyPassword(payload.password, authContext.user.passwordHash))) {
      throw new ApiError(400, "validation_failed", "password is incorrect");
    }
    await runAccountDeletionJob(collections, config, authContext.user);
    return reply.code(202).send({ ok: true });
  });
}

export async function createAccountExport(
  collections: Collections,
  config: AppConfig,
  user: UserDocument,
  now = new Date()
): Promise<{ exportId: string; token: string; expiresAt: Date }> {
  await fs.mkdir(config.ACCOUNT_EXPORT_DIR, { recursive: true });
  const exportId = new ObjectId();
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + exportHoldMs);
  const downloadPath = path.join(config.ACCOUNT_EXPORT_DIR, `${exportId.toHexString()}.zip`);
  await collections.accountExports.insertOne({
    _id: exportId,
    ownerUserId: user._id,
    status: "pending",
    tokenHash: hashSessionToken(token, config.SESSION_SECRET),
    expiresAt,
    createdAt: now,
    updatedAt: now
  });

  try {
    const zip = await buildAccountExportZip(collections, user, now);
    await fs.writeFile(downloadPath, await zip.generateAsync({ type: "nodebuffer" }));
    await collections.accountExports.updateOne(
      { _id: exportId },
      { $set: { status: "ready", downloadPath, completedAt: new Date(), updatedAt: new Date() } }
    );
    await collections.opsStatus.insertOne({
      _id: new ObjectId(),
      key: `accountExport:${exportId.toHexString()}`,
      kind: "account_export",
      status: "ok",
      data: { ownerUserId: user._id.toHexString() },
      completedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    });
  } catch (error) {
    await collections.accountExports.updateOne(
      { _id: exportId },
      { $set: { status: "failed", error: error instanceof Error ? error.message : String(error), updatedAt: new Date() } }
    );
    throw error;
  }
  return { exportId: exportId.toHexString(), token, expiresAt };
}

export async function runAccountDeletionJob(
  collections: Collections,
  config: AppConfig,
  user: UserDocument,
  options: { failAfterStep?: number } = {}
): Promise<void> {
  const key = `accountDeletion:${user._id.toHexString()}`;
  const now = new Date();
  const status = await collections.opsStatus.findOne({ key });
  const completedSteps = new Set((status?.data?.completedSteps as string[] | undefined) ?? []);
  const agents = await collections.agents.find({ ownerUserId: user._id }).toArray();
  const agentIds = agents.map((agent) => agent._id);
  let stepCount = 0;

  async function completeStep(step: string, action: () => Promise<void>): Promise<void> {
    if (!completedSteps.has(step)) {
      await action();
      completedSteps.add(step);
    }
    stepCount += 1;
    await collections.opsStatus.updateOne(
      { key },
      {
        $set: {
          kind: "account_deletion",
          status: "pending",
          data: { ownerUserId: user._id.toHexString(), completedSteps: [...completedSteps] },
          updatedAt: new Date()
        },
        $setOnInsert: { _id: new ObjectId(), createdAt: now }
      },
      { upsert: true }
    );
    if (options.failAfterStep && stepCount >= options.failAfterStep) {
      throw new Error(`simulated deletion crash after ${step}`);
    }
  }

  await completeStep("immediate_revoke", async () => {
    await Promise.all([
      collections.identityTokens.updateMany({ agentId: { $in: agentIds } }, { $set: { status: "revoked", updatedAt: new Date() } }),
      collections.agents.updateMany({ ownerUserId: user._id }, { $set: { status: "revoked", updatedAt: new Date() } }),
      collections.emailAccounts.updateMany({ agentId: { $in: agentIds } }, { $set: { status: "paused", updatedAt: new Date() } }),
      collections.sessions.deleteMany({ userId: user._id })
    ]);
  });

  await completeStep("provider_teardown", async () => {
    for (const agent of agents) {
      await teardownAgentCapabilities(agent);
    }
    await teardownStripeCustomer(collections, config, user._id);
  });

  await completeStep("hard_delete_owner_data", async () => {
    await deleteOwnerScopedRows(collections, user._id, agentIds);
  });

  await completeStep("tombstone_user", async () => {
    await collections.users.updateOne(
      { _id: user._id },
      {
        $set: {
          email: `deleted:${user._id.toHexString()}`,
          emailHash: deletedEmailHash(user.email, config),
          passwordHash: "deleted",
          deletedAt: new Date(),
          updatedAt: new Date()
        },
        $unset: { displayName: "", avatarUrl: "", notificationPreferences: "", loginFailedCount: "", loginFirstFailedAt: "", loginLockedUntil: "" }
      }
    );
  });

  await collections.opsStatus.updateOne(
    { key },
    { $set: { status: "ok", completedAt: new Date(), updatedAt: new Date(), data: { ownerUserId: user._id.toHexString(), completedSteps: [...completedSteps] } } }
  );
}

async function buildAccountExportZip(collections: Collections, user: UserDocument, now: Date): Promise<JSZip> {
  const zip = new JSZip();
  const agents = await collections.agents.find({ ownerUserId: user._id }).toArray();
  const agentIds = agents.map((agent) => agent._id);
  const files = {
    "profile.json": [redactUser(user)],
    "agents.json": agents,
    "tokens.json": await collections.identityTokens.find({ agentId: { $in: agentIds } }, { projection: { tokenHash: 0 } }).toArray(),
    "audit.json": await collections.auditLogs.find({ agentId: { $in: agentIds } }).toArray(),
    "email-accounts.json": await collections.emailAccounts.find({ agentId: { $in: agentIds } }).toArray(),
    "email-threads.json": await collections.emailThreads.find({ agentId: { $in: agentIds } }).toArray(),
    "email-messages.json": await collections.emailMessages.find({ agentId: { $in: agentIds } }).toArray(),
    "calls.json": await collections.calls.find({ agentId: { $in: agentIds } }).toArray(),
    "sms.json": await collections.smsMessages.find({ agentId: { $in: agentIds } }).toArray(),
    "billing.json": await collections.billingAccounts.find({ ownerUserId: user._id }).toArray(),
    "usage.json": await collections.usageEvents.find({ ownerUserId: user._id }).toArray()
  };
  const counts: Record<string, number> = {};
  for (const [name, rows] of Object.entries(files)) {
    counts[name] = rows.length;
    zip.file(name, JSON.stringify(rows, jsonReplacer, 2));
  }
  zip.file("export-manifest.json", JSON.stringify({ generated_at: now.toISOString(), owner_user_id: user._id.toHexString(), counts }, null, 2));
  return zip;
}

async function deleteOwnerScopedRows(collections: Collections, ownerUserId: ObjectId, agentIds: ObjectId[]): Promise<void> {
  await Promise.all([
    collections.apiKeys.deleteMany({ userId: ownerUserId }),
    collections.atlasProjects.deleteMany({ ownerUserId }),
    collections.sites.deleteMany({ ownerUserId }),
    collections.identityTokens.deleteMany({ agentId: { $in: agentIds } }),
    collections.auditLogs.deleteMany({ agentId: { $in: agentIds } }),
    collections.approvals.deleteMany({ ownerUserId }),
    collections.emailAccounts.deleteMany({ agentId: { $in: agentIds } }),
    collections.emailThreads.deleteMany({ agentId: { $in: agentIds } }),
    collections.emailMessages.deleteMany({ agentId: { $in: agentIds } }),
    collections.phoneNumbers.deleteMany({ agentId: { $in: agentIds } }),
    collections.calls.deleteMany({ agentId: { $in: agentIds } }),
    collections.smsMessages.deleteMany({ agentId: { $in: agentIds } }),
    collections.policies.deleteMany({ agentId: { $in: agentIds } }),
    collections.billingAccounts.deleteMany({ ownerUserId }),
    collections.usageEvents.deleteMany({ ownerUserId }),
    collections.usageReports.deleteMany({ ownerUserId }),
    collections.pairingRequests.deleteMany({ ownerUserId }),
    collections.accountExports.deleteMany({ ownerUserId }),
    collections.agents.deleteMany({ ownerUserId })
  ]);
}

async function teardownAgentCapabilities(agent: AgentDocument): Promise<void> {
  for (const capability of ["email", "phone"] as const) {
    if (!agent.capabilities[capability]) {
      continue;
    }
    await Promise.resolve(getProvisioner(capability).deprovision(agent)).catch(() => undefined);
  }
}

async function teardownStripeCustomer(collections: Collections, config: AppConfig, ownerUserId: ObjectId): Promise<void> {
  if (!config.STRIPE_SECRET_KEY) {
    return;
  }
  const account = await collections.billingAccounts.findOne({ ownerUserId });
  if (!account) {
    return;
  }
  const stripe = getStripeClient(config) as unknown as {
    subscriptions?: { cancel(id: string): Promise<unknown> };
    customers?: { del(id: string): Promise<unknown>; delete?(id: string): Promise<unknown> };
  };
  if (account.subscriptionId) {
    await stripe.subscriptions?.cancel(account.subscriptionId).catch(() => undefined);
  }
  const customerDelete = stripe.customers?.del?.(account.stripeCustomerId) ?? stripe.customers?.delete?.(account.stripeCustomerId);
  await customerDelete?.catch(() => undefined);
}

function redactUser(user: UserDocument): Partial<UserDocument> {
  const { passwordHash, loginFailedCount, loginFirstFailedAt, loginLockedUntil, ...safe } = user;
  void passwordHash;
  void loginFailedCount;
  void loginFirstFailedAt;
  void loginLockedUntil;
  return safe;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  return value;
}
