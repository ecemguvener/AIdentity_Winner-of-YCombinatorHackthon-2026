import { ObjectId } from "mongodb";
import type { AppConfig } from "./config.js";
import type { Collections } from "./db.js";

export interface RetentionResult {
  callTranscriptsStripped: number;
  emailBodiesStripped: number;
  webhookEventsDeleted: number;
  usageEventsDeleted: number;
  approvalsPayloadsStripped: number;
  pairingSecretsStripped: number;
  auditLogsDeleted: number;
  tombstonesDeleted: number;
}

export async function runRetentionSweep(collections: Collections, config: AppConfig, now = new Date()): Promise<RetentionResult> {
  const callsBefore = daysBefore(now, config.RETENTION_CALL_TRANSCRIPT_DAYS);
  const emailsBefore = daysBefore(now, config.RETENTION_EMAIL_BODY_DAYS);
  const webhookBefore = daysBefore(now, config.RETENTION_WEBHOOK_EVENT_DAYS);
  const usageBefore = daysBefore(now, config.RETENTION_USAGE_REPORTED_DAYS);
  const expiredPayloadBefore = daysBefore(now, config.RETENTION_EXPIRED_PAYLOAD_DAYS);
  const auditBefore = daysBefore(now, config.RETENTION_AUDIT_LOG_DAYS);
  const tombstoneBefore = daysBefore(now, config.RETENTION_TOMBSTONE_DAYS);

  const [
    callTranscripts,
    emailBodies,
    webhookEvents,
    usageEvents,
    approvalsPayloads,
    pairingSecrets,
    auditLogs,
    tombstones
  ] = await Promise.all([
    collections.calls.updateMany(
      { createdAt: { $lt: callsBefore }, transcript: { $exists: true } },
      { $unset: { transcript: "" }, $set: { updatedAt: now } }
    ),
    collections.emailMessages.updateMany(
      { createdAt: { $lt: emailsBefore }, $or: [{ textBody: { $ne: "" } }, { htmlBody: { $exists: true } }] },
      { $set: { textBody: "", updatedAt: now }, $unset: { htmlBody: "" } }
    ),
    collections.webhookEvents.deleteMany({ createdAt: { $lt: webhookBefore } }),
    collections.usageEvents.deleteMany({ stripeReported: true, createdAt: { $lt: usageBefore } }),
    collections.approvals.updateMany(
      { status: { $in: ["approved", "rejected", "expired"] }, updatedAt: { $lt: expiredPayloadBefore }, payload: { $exists: true } },
      { $set: { payload: {}, updatedAt: now }, $unset: { executionResult: "" } }
    ),
    collections.pairingRequests.updateMany(
      { status: { $in: ["claimed", "expired"] }, updatedAt: { $lt: expiredPayloadBefore } },
      { $unset: { identityTokenPlaintext: "" }, $set: { updatedAt: now } }
    ),
    collections.auditLogs.deleteMany({ createdAt: { $lt: auditBefore } }),
    collections.users.deleteMany({ deletedAt: { $lt: tombstoneBefore } })
  ]);

  const result = {
    callTranscriptsStripped: callTranscripts.modifiedCount,
    emailBodiesStripped: emailBodies.modifiedCount,
    webhookEventsDeleted: webhookEvents.deletedCount,
    usageEventsDeleted: usageEvents.deletedCount,
    approvalsPayloadsStripped: approvalsPayloads.modifiedCount,
    pairingSecretsStripped: pairingSecrets.modifiedCount,
    auditLogsDeleted: auditLogs.deletedCount,
    tombstonesDeleted: tombstones.deletedCount
  };
  await collections.opsStatus.updateOne(
    { key: "retention.daily" },
    {
      $set: {
        kind: "retention",
        status: "ok",
        data: result,
        completedAt: now,
        updatedAt: now
      },
      $setOnInsert: { _id: new ObjectId(), createdAt: now }
    },
    { upsert: true }
  );
  return result;
}

export function startRetentionLoop(collections: Collections, config: AppConfig): NodeJS.Timeout | null {
  if (config.NODE_ENV === "test") {
    return null;
  }
  return setInterval(() => {
    void runRetentionSweep(collections, config).catch((error) => {
      console.error("retention sweep failed", error);
    });
  }, 24 * 60 * 60 * 1000).unref();
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
