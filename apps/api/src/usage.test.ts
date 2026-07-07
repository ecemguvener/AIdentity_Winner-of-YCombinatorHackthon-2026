import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { connectDatabase, type Database } from "./db.js";
import { getUsageSummary, recordActiveNumberUsageSnapshot, recordUsage, reportUsageToStripe } from "./usage.js";
import type { Stripe } from "./providers/stripe-client.js";

const config = {
  STRIPE_SECRET_KEY: "sk_test_usage",
  STRIPE_WEBHOOK_SECRET: "whsec_usage"
} as AppConfig;

let mongoServer: MongoMemoryServer;
let database: Database;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  database = await connectDatabase({ MONGODB_URI: mongoServer.getUri() } as AppConfig);
}, 60_000);

beforeEach(async () => {
  await Promise.all([
    database.collections.users.deleteMany({}),
    database.collections.agents.deleteMany({}),
    database.collections.phoneNumbers.deleteMany({}),
    database.collections.billingAccounts.deleteMany({}),
    database.collections.usageEvents.deleteMany({}),
    database.collections.usageReports.deleteMany({})
  ]);
});

afterAll(async () => {
  await database?.client.close();
  await mongoServer?.stop();
});

describe("usage metering", () => {
  it("anchors period keys to the billing period end", async () => {
    const { ownerUserId, agentId } = await insertBillingFixture({ currentPeriodEnd: new Date("2026-08-01T00:00:00Z") });

    await recordUsage(database.collections, { ownerUserId, agentId, meter: "emails_sent", quantity: 3 }, new Date("2026-07-15T10:00:00Z"));

    expect(await database.collections.usageEvents.findOne({ ownerUserId })).toMatchObject({ periodKey: "2026-08" });
  });

  it("summarizes included and overage quantities by plan", async () => {
    const { ownerUserId, agentId } = await insertBillingFixture({ plan: "pro" });
    await recordUsage(database.collections, { ownerUserId, agentId, meter: "emails_sent", quantity: 520 }, new Date("2026-07-07T10:00:00Z"));
    await recordUsage(database.collections, { ownerUserId, agentId, meter: "sms_messages", quantity: 180 }, new Date("2026-07-07T10:00:00Z"));

    const summary = await getUsageSummary(database.collections, ownerUserId, "2026-07");

    expect(summary.perMeter.emails_sent).toEqual({ used: 520, included: 500, overage: 20 });
    expect(summary.perMeter.sms_messages).toEqual({ used: 180, included: 200, overage: 0 });
  });

  it("reports only overage deltas with deterministic identifiers", async () => {
    const { ownerUserId, agentId, accountId } = await insertBillingFixture({ plan: "pro", stripeCustomerId: "cus_usage" });
    const stripe = createStripeUsageMock();
    await recordUsage(database.collections, { ownerUserId, agentId, meter: "emails_sent", quantity: 480 }, new Date("2026-07-07T10:00:00Z"));
    expect(await reportUsageToStripe(database.collections, config, { stripe: stripe.client })).toEqual([]);

    await recordUsage(database.collections, { ownerUserId, agentId, meter: "emails_sent", quantity: 40 }, new Date("2026-07-07T10:00:00Z"));
    const first = await reportUsageToStripe(database.collections, config, { stripe: stripe.client });
    expect(first).toEqual([{
      ownerUserId: ownerUserId.toHexString(),
      meter: "emails_sent",
      periodKey: "2026-07",
      delta: 20,
      identifier: `${accountId.toHexString()}_emails_sent_2026-07_1`
    }]);

    await recordUsage(database.collections, { ownerUserId, agentId, meter: "emails_sent", quantity: 10 }, new Date("2026-07-07T10:00:00Z"));
    const second = await reportUsageToStripe(database.collections, config, { stripe: stripe.client });
    expect(second[0]?.delta).toBe(10);
    expect(second[0]?.identifier).toBe(`${accountId.toHexString()}_emails_sent_2026-07_2`);
    expect(stripe.events.map((event) => event.identifier)).toEqual([
      `${accountId.toHexString()}_emails_sent_2026-07_1`,
      `${accountId.toHexString()}_emails_sent_2026-07_2`
    ]);
  });

  it("retries failed reports without marking rows", async () => {
    const { ownerUserId, agentId, accountId } = await insertBillingFixture({ plan: "pro", stripeCustomerId: "cus_usage" });
    await recordUsage(database.collections, { ownerUserId, agentId, meter: "emails_sent", quantity: 520 }, new Date("2026-07-07T10:00:00Z"));
    const failingStripe = createStripeUsageMock({ fail: true });

    await expect(reportUsageToStripe(database.collections, config, { stripe: failingStripe.client })).rejects.toThrow("Stripe down");
    expect(await database.collections.usageReports.countDocuments()).toBe(0);
    expect(await database.collections.usageEvents.countDocuments({ stripeReported: true })).toBe(0);

    const stripe = createStripeUsageMock();
    await reportUsageToStripe(database.collections, config, { stripe: stripe.client });
    expect(stripe.events[0]?.identifier).toBe(`${accountId.toHexString()}_emails_sent_2026-07_1`);
  });

  it("samples active phone numbers once per number per day", async () => {
    const { ownerUserId, agentId } = await insertBillingFixture({ plan: "pro" });
    await database.collections.phoneNumbers.insertOne({
      _id: new ObjectId(),
      agentId,
      e164: "+15005550001",
      country: "US",
      capabilitiesVoice: true,
      capabilitiesSms: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date()
    });

    expect(await recordActiveNumberUsageSnapshot(database.collections, new Date("2026-07-07T10:00:00Z"))).toBe(1);
    expect(await recordActiveNumberUsageSnapshot(database.collections, new Date("2026-07-07T12:00:00Z"))).toBe(0);
    expect(await database.collections.usageEvents.countDocuments({ ownerUserId, meter: "active_numbers" })).toBe(1);
  });
});

async function insertBillingFixture(input: {
  plan?: "free" | "pro" | "scale";
  currentPeriodEnd?: Date;
  stripeCustomerId?: string;
} = {}) {
  const ownerUserId = new ObjectId();
  const agentId = new ObjectId();
  const accountId = new ObjectId();
  const now = new Date();
  await database.collections.users.insertOne({
    _id: ownerUserId,
    email: "owner@example.com",
    passwordHash: "hash",
    createdAt: now,
    updatedAt: now
  });
  await database.collections.agents.insertOne({
    _id: agentId,
    ownerUserId,
    name: "Usage Agent",
    slug: `usage-agent-${Math.random().toString(36).slice(2)}`,
    status: "active",
    capabilities: { email: true, phone: true },
    approvalMode: "policy",
    createdAt: now,
    updatedAt: now
  });
  await database.collections.billingAccounts.insertOne({
    _id: accountId,
    ownerUserId,
    stripeCustomerId: input.stripeCustomerId ?? "cus_usage",
    plan: input.plan ?? "pro",
    subscriptionId: "sub_usage",
    subscriptionStatus: "active",
    currentPeriodEnd: input.currentPeriodEnd,
    createdAt: now,
    updatedAt: now
  });
  return { ownerUserId, agentId, accountId };
}

function createStripeUsageMock(input: { fail?: boolean } = {}) {
  const events: Array<{ event_name: string; identifier: string; payload: Record<string, string> }> = [];
  const client = {
    billing: {
      meterEvents: {
        create: async (event: { event_name: string; identifier: string; payload: Record<string, string> }) => {
          if (input.fail) throw new Error("Stripe down");
          events.push(event);
          return { object: "billing.meter_event" };
        }
      }
    }
  } as unknown as Stripe;
  return { client, events };
}
