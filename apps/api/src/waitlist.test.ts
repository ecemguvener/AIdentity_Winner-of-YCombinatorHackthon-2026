import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { connectDatabase, type Database } from "./db.js";

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
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);
}, 60_000);

beforeEach(async () => {
  await database.collections.waitlist.deleteMany({});
});

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("waitlist", () => {
  it("stores card waitlist emails and dedupes by email", async () => {
    const first = await app.inject({ method: "POST", url: "/api/v1/waitlist", payload: { email: "USER@example.com", feature: "card" } });
    const second = await app.inject({ method: "POST", url: "/api/v1/waitlist", payload: { email: "user@example.com", feature: "card" } });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(await database.collections.waitlist.countDocuments()).toBe(1);
    expect(await database.collections.waitlist.findOne()).toMatchObject({ email: "user@example.com", feature: "card" });
  });

  it("limits submissions to five per hour per IP", async () => {
    for (let index = 0; index < 5; index += 1) {
      expect((await app.inject({ method: "POST", url: "/api/v1/waitlist", payload: { email: `user${index}@example.com`, feature: "card" } })).statusCode).toBe(202);
    }
    const limited = await app.inject({ method: "POST", url: "/api/v1/waitlist", payload: { email: "six@example.com", feature: "card" } });
    expect(limited.statusCode).toBe(429);
  });
});
