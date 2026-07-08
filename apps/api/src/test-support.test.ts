import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { connectDatabase, type Database } from "./db.js";

const baseConfig = {
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
} as unknown as Omit<AppConfig, "NODE_ENV">;

function configFor(NODE_ENV: "test" | "production"): AppConfig {
  return { ...baseConfig, NODE_ENV } as AppConfig;
}

let mongoServer: MongoMemoryServer;
let database: Database;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (baseConfig as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(configFor("test"));
}, 60_000);

afterAll(async () => {
  await database?.client.close();
  await mongoServer?.stop();
});

describe("test support routes", () => {
  it("registers only when NODE_ENV is test", async () => {
    const testApp = await buildApp(configFor("test"), database.collections);
    const productionApp = await buildApp(configFor("production"), database.collections);

    const enabled = await testApp.inject({
      method: "POST",
      url: "/api/test-support/inbound-email",
      payload: {}
    });
    expect(enabled.statusCode).toBe(401);

    const absent = await productionApp.inject({
      method: "POST",
      url: "/api/test-support/inbound-email",
      payload: {}
    });
    expect(absent.statusCode).toBe(404);

    await testApp.close();
    await productionApp.close();
  });
});
