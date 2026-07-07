import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { connectDatabase, type Database } from "./db.js";
import { assertDemoSeedAllowed, seedDemoWithDatabase } from "./seed-demo.js";

const config = {
  NODE_ENV: "test",
  API_PORT: 0,
  PUBLIC_APP_URL: "http://localhost:4888",
  PUBLIC_API_URL: "http://localhost:4001",
  MONGODB_URI: "set-by-beforeAll",
  SESSION_COOKIE_NAME: "barkan_session",
  SESSION_SECRET: "test-barkan-session-secret",
  PROVIDER_MODE_EMAIL: "mock",
  PROVIDER_MODE_PHONE: "mock",
  TWILIO_NUMBER_COUNTRY: "US",
  ELEVENLABS_VOICE_ID: "voice",
  OPENAI_DASHBOARD_CHAT_MODEL: "gpt-5.4-2026-03-05",
  EMAIL_AGENT_DOMAIN: "agents.barkan.dev",
  EMAIL_PLATFORM_FROM: "Barkan <no-reply@barkan.dev>",
  API_RATE_LIMIT_MAX: 1000
} as unknown as AppConfig;

let mongoServer: MongoMemoryServer;
let database: Database;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
}, 60_000);

afterAll(async () => {
  await database?.client.close();
  await mongoServer?.stop();
});

describe("seed demo", () => {
  it("creates stable current-model demo data idempotently", async () => {
    const now = new Date("2026-07-07T12:00:00.000Z");
    const first = await seedDemoWithDatabase(database, config, { now });
    const second = await seedDemoWithDatabase(database, config, { now });

    expect(second.counts).toEqual(first.counts);
    expect(second).toMatchObject({
      email: "demo@barkan.dev",
      password: "demo-password",
      agents: [
        "Maya - Executive assistant",
        "Scout - Recruiting outreach",
        "Sentinelle - Support line"
      ],
      counts: {
        agents: 3,
        emailThreads: 10,
        emailMessages: 19,
        calls: 14,
        smsMessages: 3,
        approvals: 2,
        usageEvents: 3,
        auditLogs: 72
      }
    });

    const billing = await database.collections.billingAccounts.findOne({});
    expect(billing).toMatchObject({ plan: "pro", stripeCustomerId: "cus_demo_barkan_local" });
    const usage = await database.collections.usageEvents.find({}).sort({ meter: 1 }).toArray();
    expect(usage.map((event) => [event.meter, event.quantity])).toEqual([
      ["call_minutes", 74],
      ["emails_sent", 340],
      ["sms_messages", 41]
    ]);
  });

  it("refuses production-looking targets", () => {
    expect(() => assertDemoSeedAllowed({ ...config, NODE_ENV: "production" } as AppConfig, database)).toThrow(/NODE_ENV=production/);
    expect(() => assertDemoSeedAllowed(config, { db: { databaseName: "barkan-prod" } } as Database)).toThrow(/production database/);
  });
});
