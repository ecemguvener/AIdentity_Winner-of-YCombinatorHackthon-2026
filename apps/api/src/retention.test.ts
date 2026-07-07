import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { connectDatabase, type Database } from "./db.js";
import { runRetentionSweep } from "./retention.js";

const config = {
  NODE_ENV: "test",
  MONGODB_URI: "set-by-beforeAll",
  RETENTION_CALL_TRANSCRIPT_DAYS: 180,
  RETENTION_EMAIL_BODY_DAYS: 365,
  RETENTION_WEBHOOK_EVENT_DAYS: 90,
  RETENTION_USAGE_REPORTED_DAYS: 400,
  RETENTION_EXPIRED_PAYLOAD_DAYS: 90,
  RETENTION_AUDIT_LOG_DAYS: 730,
  RETENTION_TOMBSTONE_DAYS: 30
} as unknown as AppConfig;

let mongoServer: MongoMemoryServer;
let database: Database;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
}, 60_000);

beforeEach(async () => {
  await Promise.all(Object.values(database.collections).map((collection) => collection.deleteMany({})));
});

afterAll(async () => {
  await database?.client.close();
  await mongoServer?.stop();
});

describe("retention sweep", () => {
  it("strips sensitive bodies and deletes expired operational rows", async () => {
    const now = new Date("2026-07-07T12:00:00Z");
    const agentId = new ObjectId();
    await database.collections.calls.insertOne({
      _id: new ObjectId(),
      agentId,
      phoneNumberId: new ObjectId(),
      direction: "outbound",
      counterpartyE164: "+15005550001",
      status: "completed",
      transcript: [{ role: "agent", message: "secret", timeInCallSecs: 1 }],
      summary: "done",
      durationSecs: 60,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      updatedAt: new Date("2025-01-01T00:00:00Z")
    });
    await database.collections.emailMessages.insertOne({
      _id: new ObjectId(),
      agentId,
      threadId: new ObjectId(),
      direction: "outbound",
      fromEmail: "a@agents.barkan.dev",
      toEmail: "b@example.com",
      subject: "Old",
      textBody: "secret",
      htmlBody: "<p>secret</p>",
      status: "sent",
      createdAt: new Date("2025-01-01T00:00:00Z"),
      updatedAt: new Date("2025-01-01T00:00:00Z")
    });
    await database.collections.webhookEvents.insertOne({
      _id: new ObjectId(),
      provider: "stripe",
      providerEventId: "evt_old",
      eventType: "invoice.paid",
      payloadHash: "hash",
      status: "processed",
      createdAt: new Date("2025-01-01T00:00:00Z"),
      updatedAt: new Date("2025-01-01T00:00:00Z")
    });
    await database.collections.usageEvents.insertOne({
      _id: new ObjectId(),
      ownerUserId: new ObjectId(),
      agentId,
      meter: "emails_sent",
      quantity: 1,
      stripeReported: true,
      periodKey: "2025-01",
      createdAt: new Date("2025-01-01T00:00:00Z"),
      updatedAt: new Date("2025-01-01T00:00:00Z")
    });

    const result = await runRetentionSweep(database.collections, config, now);

    expect(result).toMatchObject({ callTranscriptsStripped: 1, emailBodiesStripped: 1, webhookEventsDeleted: 1, usageEventsDeleted: 1 });
    expect(await database.collections.calls.findOne({ agentId })).not.toHaveProperty("transcript");
    expect(await database.collections.emailMessages.findOne({ agentId })).toMatchObject({ textBody: "" });
    expect(await database.collections.opsStatus.findOne({ key: "retention.daily" })).toMatchObject({ status: "ok" });
  });
});
