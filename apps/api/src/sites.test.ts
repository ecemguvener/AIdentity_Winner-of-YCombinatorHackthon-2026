import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  EMAIL_AGENT_DOMAIN: "example.test",
  EMAIL_PLATFORM_FROM: "Barkan <no-reply@barkan.dev>",
  API_RATE_LIMIT_MAX: 1000
} as unknown as AppConfig;

let mongoServer: MongoMemoryServer;
let database: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
let sessionCookie: string;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);

  const signup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "user@example.com", password: "password12345" }
  });
  const cookie = signup.cookies.find((candidate) => candidate.name === config.SESSION_COOKIE_NAME);
  if (!cookie) {
    throw new Error("signup did not set a session cookie");
  }
  sessionCookie = cookie.value;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("legacy site identity routes (agents adapter)", () => {
  it("creates and completes an agent identity setup with deprecation headers", async () => {
    const cookies = { [config.SESSION_COOKIE_NAME]: sessionCookie };
    const setupResponse = await app.inject({
      method: "POST",
      url: "/api/site-setups",
      cookies,
      payload: { name: "Ava", domain: "https://openclaw.example.com/runtime" }
    });

    expect(setupResponse.statusCode).toBe(201);
    expect(setupResponse.headers.deprecation).toBe("true");
    const setupBody = setupResponse.json();
    expect(setupBody.setup).toMatchObject({
      name: "Ava",
      domain: "openclaw.example.com"
    });
    expect(setupBody.secret).toMatch(/^brk_/);

    // Setup creates a provisioning agent under the hood.
    const agent = await database.collections.agents.findOne({ legacyProjectId: setupBody.setup.projectId });
    expect(agent?.status).toBe("provisioning");

    const completeResponse = await app.inject({
      method: "POST",
      url: `/api/site-setups/${setupBody.setup.projectId}/complete`,
      cookies
    });

    expect(completeResponse.statusCode).toBe(200);
    expect(completeResponse.headers.deprecation).toBe("true");
    expect(completeResponse.json()).toMatchObject({
      site: {
        name: "Ava",
        domain: "openclaw.example.com"
      }
    });
    expect(completeResponse.json().site.id).toBe(agent?._id.toHexString());

    const completedAgent = await database.collections.agents.findOne({ _id: agent!._id });
    expect(completedAgent?.status).toBe("active");
  });

  it("does not register removed widget and Atlas agent routes", async () => {
    await expectRouteNotFound(app, "GET", "/widget.js");
    await expectRouteNotFound(app, "GET", "/api/widget/config?siteKey=site_test");
    await expectRouteNotFound(app, "POST", "/api/widget/action");
    await expectRouteNotFound(app, "POST", "/api/atlas/connect");
    await expectRouteNotFound(app, "POST", "/api/atlas/agent/select-files");
  });
});

async function expectRouteNotFound(testApp: Awaited<ReturnType<typeof buildApp>>, method: string, url: string) {
  const response = await testApp.inject({ method: method as "GET" | "POST", url });
  expect(response.statusCode).toBe(404);
}
