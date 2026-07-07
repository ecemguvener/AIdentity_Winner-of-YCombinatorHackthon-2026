import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { connectDatabase, type Collections, type Database } from "./db.js";
import { checkEntitlement, type EntitlementCheck } from "./entitlements.js";
import type { BillingPlan } from "./billing.js";

let mongoServer: MongoMemoryServer;
let database: Database;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  database = await connectDatabase({ MONGODB_URI: mongoServer.getUri() } as AppConfig);
}, 60_000);

beforeEach(async () => {
  await Promise.all([
    database.collections.agents.deleteMany({}),
    database.collections.phoneNumbers.deleteMany({}),
    database.collections.billingAccounts.deleteMany({}),
    database.collections.usageEvents.deleteMany({})
  ]);
});

afterAll(async () => {
  await database?.client.close();
  await mongoServer?.stop();
});

describe("checkEntitlement", () => {
  const rows: Array<{
    name: string;
    plan: BillingPlan;
    check: EntitlementCheck;
    agents?: number;
    activeNumbers?: number;
    usage?: number;
    allowed: boolean;
    hint?: string;
  }> = [
    { name: "free allows first agent", plan: "free", check: { type: "agent.create" }, agents: 0, allowed: true },
    { name: "free blocks second agent", plan: "free", check: { type: "agent.create" }, agents: 1, allowed: false, hint: "Upgrade to Pro for 3 agents." },
    { name: "pro allows third agent", plan: "pro", check: { type: "agent.create" }, agents: 2, allowed: true },
    { name: "pro blocks fourth agent", plan: "pro", check: { type: "agent.create" }, agents: 3, allowed: false, hint: "Upgrade to Scale for 10 agents." },
    { name: "scale allows tenth agent", plan: "scale", check: { type: "agent.create" }, agents: 9, allowed: true },
    { name: "scale blocks eleventh agent", plan: "scale", check: { type: "agent.create" }, agents: 10, allowed: false, hint: "Upgrade to Scale for 10 agents." },
    { name: "free allows email enable", plan: "free", check: { type: "capability.enable", capability: "email" }, allowed: true },
    { name: "free blocks phone enable", plan: "free", check: { type: "capability.enable", capability: "phone" }, allowed: false, hint: "Upgrade to Pro for phone access." },
    { name: "pro allows first phone enable", plan: "pro", check: { type: "capability.enable", capability: "phone" }, activeNumbers: 0, allowed: true },
    { name: "pro blocks second phone enable", plan: "pro", check: { type: "capability.enable", capability: "phone" }, activeNumbers: 1, allowed: false, hint: "Upgrade to Scale for 3 included phone numbers." },
    { name: "scale allows third phone enable", plan: "scale", check: { type: "capability.enable", capability: "phone" }, activeNumbers: 2, allowed: true },
    { name: "scale blocks fourth phone enable", plan: "scale", check: { type: "capability.enable", capability: "phone" }, activeNumbers: 3, allowed: false, hint: "Upgrade to Scale for 3 included phone numbers." },
    { name: "free blocks number provision", plan: "free", check: { type: "number.provision" }, activeNumbers: 0, allowed: false, hint: "Upgrade to Pro for phone numbers." },
    { name: "pro allows first number provision", plan: "pro", check: { type: "number.provision" }, activeNumbers: 0, allowed: true },
    { name: "pro blocks second number provision", plan: "pro", check: { type: "number.provision" }, activeNumbers: 1, allowed: false, hint: "Upgrade to Scale for 3 included phone numbers." },
    { name: "scale allows third number provision", plan: "scale", check: { type: "number.provision" }, activeNumbers: 2, allowed: true },
    { name: "free allows 51st email", plan: "free", check: { type: "usage", meter: "email" }, usage: 50, allowed: true },
    { name: "free allows 100th email", plan: "free", check: { type: "usage", meter: "email" }, usage: 99, allowed: true },
    { name: "free blocks 101st email", plan: "free", check: { type: "usage", meter: "email" }, usage: 100, allowed: false, hint: "Upgrade to Pro for 500 included emails and metered overage." },
    { name: "free blocks first SMS", plan: "free", check: { type: "usage", meter: "sms" }, usage: 0, allowed: false, hint: "Upgrade to Pro for SMS access." },
    { name: "free blocks first call minute", plan: "free", check: { type: "usage", meter: "call_minutes" }, usage: 0, allowed: false, hint: "Upgrade to Pro for call minutes." },
    { name: "pro allows email overage", plan: "pro", check: { type: "usage", meter: "email" }, usage: 1000, allowed: true },
    { name: "pro allows SMS overage", plan: "pro", check: { type: "usage", meter: "sms" }, usage: 500, allowed: true },
    { name: "pro allows call overage", plan: "pro", check: { type: "usage", meter: "call_minutes" }, usage: 500, allowed: true }
  ];

  it.each(rows)("$name", async (row) => {
    const ownerUserId = new ObjectId();
    await insertBillingAccount(database.collections, ownerUserId, row.plan);
    await insertAgents(database.collections, ownerUserId, row.agents ?? 0);
    await insertActiveNumbers(database.collections, ownerUserId, row.activeNumbers ?? 0);
    if (row.usage !== undefined && row.check.type === "usage") {
      await insertUsage(database.collections, ownerUserId, row.check.meter, row.usage);
    }

    const result = await checkEntitlement(database.collections, ownerUserId, row.check);

    expect(result.allowed).toBe(row.allowed);
    expect(result.plan).toBe(row.plan);
    if (row.hint) {
      expect(result.upgradeHint).toBe(row.hint);
    }
  });
});

async function insertBillingAccount(collections: Collections, ownerUserId: ObjectId, plan: BillingPlan): Promise<void> {
  const now = new Date("2026-07-07T00:00:00.000Z");
  await collections.billingAccounts.insertOne({
    _id: new ObjectId(),
    ownerUserId,
    stripeCustomerId: `cus_${ownerUserId.toHexString()}`,
    plan,
    subscriptionStatus: plan === "free" ? undefined : "active",
    currentPeriodEnd: new Date("2026-07-31T00:00:00.000Z"),
    createdAt: now,
    updatedAt: now
  });
}

async function insertAgents(collections: Collections, ownerUserId: ObjectId, count: number): Promise<ObjectId[]> {
  const ids: ObjectId[] = [];
  const now = new Date("2026-07-07T00:00:00.000Z");
  for (let index = 0; index < count; index++) {
    const agentId = new ObjectId();
    ids.push(agentId);
    await collections.agents.insertOne({
      _id: agentId,
      ownerUserId,
      name: `Agent ${index}`,
      slug: `agent-${index}-${ownerUserId.toHexString()}`,
      status: "active",
      capabilities: { email: false, phone: false },
      approvalMode: "always",
      createdAt: now,
      updatedAt: now
    });
  }
  return ids;
}

async function insertActiveNumbers(collections: Collections, ownerUserId: ObjectId, count: number): Promise<void> {
  const agentIds = await insertAgents(collections, ownerUserId, count);
  const now = new Date("2026-07-07T00:00:00.000Z");
  for (const [index, agentId] of agentIds.entries()) {
    await collections.phoneNumbers.insertOne({
      _id: new ObjectId(),
      agentId,
      e164: `+15005550${String(index).padStart(3, "0")}`,
      country: "US",
      twilioSid: `PN${index}`,
      elevenLabsPhoneNumberId: `el-phone-${index}`,
      capabilitiesVoice: true,
      capabilitiesSms: true,
      status: "active",
      createdAt: now,
      updatedAt: now
    });
  }
}

async function insertUsage(collections: Collections, ownerUserId: ObjectId, meter: "email" | "call_minutes" | "sms", quantity: number): Promise<void> {
  const now = new Date("2026-07-07T00:00:00.000Z");
  await collections.usageEvents.insertOne({
    _id: new ObjectId(),
    ownerUserId,
    agentId: new ObjectId(),
    meter: meter === "email" ? "emails_sent" : meter === "sms" ? "sms_messages" : "call_minutes",
    quantity,
    stripeReported: false,
    periodKey: "2026-07",
    createdAt: now,
    updatedAt: now
  });
}
