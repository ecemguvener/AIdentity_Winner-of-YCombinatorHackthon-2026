import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { connectDatabase, type Database } from "./db.js";

let mongoServer: MongoMemoryServer;
let database: Database;

function testConfig(mongoUri: string): AppConfig {
  return { MONGODB_URI: mongoUri } as AppConfig;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  database = await connectDatabase(testConfig(mongoServer.getUri()));
}, 60_000);

afterAll(async () => {
  await database?.client.close();
  await mongoServer?.stop();
});

describe("connectDatabase", () => {
  it("creates indexes idempotently (second connect does not error)", async () => {
    const secondDatabase = await connectDatabase(testConfig(mongoServer.getUri()));
    await secondDatabase.client.close();
  });

  it("exposes every collection", () => {
    const expectedCollectionNames = [
      "users",
      "sessions",
      "sites",
      "apiKeys",
      "atlasProjects",
      "interactionLogs",
      "agents",
      "identityTokens",
      "auditLogs",
      "approvals",
      "emailAccounts",
      "emailThreads",
      "emailMessages",
      "phoneNumbers",
      "calls",
      "smsMessages",
      "policies",
      "webhookEvents",
      "billingAccounts",
      "usageEvents"
    ] as const;
    for (const collectionName of expectedCollectionNames) {
      expect(database.collections[collectionName].collectionName).toBe(collectionName);
    }
  });
});

describe("uniqueness constraints", () => {
  it("rejects duplicate identityTokens.tokenHash", async () => {
    const base = {
      agentId: new ObjectId(),
      ownerUserId: new ObjectId(),
      tokenHash: "hash-1",
      prefix: "bk_test",
      name: "primary",
      status: "active" as const,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await database.collections.identityTokens.insertOne({ _id: new ObjectId(), ...base });
    await expect(
      database.collections.identityTokens.insertOne({ _id: new ObjectId(), ...base })
    ).rejects.toThrow(/duplicate key/i);
  });

  it("rejects duplicate agents slug per owner but allows same slug across owners", async () => {
    const ownerUserId = new ObjectId();
    const base = {
      name: "Ava",
      slug: "ava",
      status: "active" as const,
      capabilities: { email: true, phone: false },
      approvalMode: "policy" as const,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await database.collections.agents.insertOne({ _id: new ObjectId(), ownerUserId, ...base });
    await expect(
      database.collections.agents.insertOne({ _id: new ObjectId(), ownerUserId, ...base })
    ).rejects.toThrow(/duplicate key/i);
    await database.collections.agents.insertOne({
      _id: new ObjectId(),
      ownerUserId: new ObjectId(),
      ...base
    });
  });

  it("rejects duplicate emailAccounts.address", async () => {
    const base = {
      agentId: new ObjectId(),
      address: "ava@agents.example.com",
      displayName: "Ava",
      status: "active" as const,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await database.collections.emailAccounts.insertOne({ _id: new ObjectId(), ...base });
    await expect(
      database.collections.emailAccounts.insertOne({ _id: new ObjectId(), ...base })
    ).rejects.toThrow(/duplicate key/i);
  });

  it("rejects duplicate phoneNumbers.e164", async () => {
    const base = {
      agentId: new ObjectId(),
      e164: "+15550001111",
      country: "US",
      twilioSid: "PN123",
      capabilitiesVoice: true,
      capabilitiesSms: true,
      status: "active" as const,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await database.collections.phoneNumbers.insertOne({ _id: new ObjectId(), ...base });
    await expect(
      database.collections.phoneNumbers.insertOne({ _id: new ObjectId(), ...base })
    ).rejects.toThrow(/duplicate key/i);
  });

  it("rejects duplicate webhookEvents providerEventId per provider but allows across providers", async () => {
    const base = {
      providerEventId: "evt_1",
      eventType: "message.delivered",
      payloadHash: "abc",
      status: "received" as const,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await database.collections.webhookEvents.insertOne({
      _id: new ObjectId(),
      provider: "twilio",
      ...base
    });
    await expect(
      database.collections.webhookEvents.insertOne({
        _id: new ObjectId(),
        provider: "twilio",
        ...base
      })
    ).rejects.toThrow(/duplicate key/i);
    await database.collections.webhookEvents.insertOne({
      _id: new ObjectId(),
      provider: "resend",
      ...base
    });
  });

  it("rejects duplicate billingAccounts.ownerUserId", async () => {
    const ownerUserId = new ObjectId();
    const base = {
      ownerUserId,
      stripeCustomerId: "cus_123",
      plan: "free" as const,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await database.collections.billingAccounts.insertOne({ _id: new ObjectId(), ...base });
    await expect(
      database.collections.billingAccounts.insertOne({ _id: new ObjectId(), ...base })
    ).rejects.toThrow(/duplicate key/i);
  });

  it("rejects duplicate policies.agentId", async () => {
    const agentId = new ObjectId();
    const base = {
      agentId,
      email: {},
      phone: {},
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await database.collections.policies.insertOne({ _id: new ObjectId(), ...base });
    await expect(
      database.collections.policies.insertOne({ _id: new ObjectId(), ...base })
    ).rejects.toThrow(/duplicate key/i);
  });

  it("enforces sparse unique twilioMessageSid: missing sids allowed, duplicate sid rejected", async () => {
    const base = {
      agentId: new ObjectId(),
      phoneNumberId: new ObjectId(),
      direction: "outbound" as const,
      counterpartyE164: "+15550002222",
      body: "hello",
      status: "queued" as const,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await database.collections.smsMessages.insertOne({ _id: new ObjectId(), ...base });
    await database.collections.smsMessages.insertOne({ _id: new ObjectId(), ...base });
    await database.collections.smsMessages.insertOne({
      _id: new ObjectId(),
      ...base,
      twilioMessageSid: "SM123"
    });
    await expect(
      database.collections.smsMessages.insertOne({
        _id: new ObjectId(),
        ...base,
        twilioMessageSid: "SM123"
      })
    ).rejects.toThrow(/duplicate key/i);
  });
});
