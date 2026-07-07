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
  await Promise.all([
    database.collections.users.deleteMany({}),
    database.collections.sessions.deleteMany({}),
    database.collections.agents.deleteMany({}),
    database.collections.identityTokens.deleteMany({}),
    database.collections.approvals.deleteMany({}),
    database.collections.emailAccounts.deleteMany({}),
    database.collections.emailMessages.deleteMany({}),
    database.collections.emailThreads.deleteMany({}),
    database.collections.policies.deleteMany({}),
    database.collections.billingAccounts.deleteMany({})
  ]);
});

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("first-run onboarding", () => {
  it("tracks create, runtime connection, first email, approval, dismissal, and activation metrics", async () => {
    const cookie = await signup("first-run@example.com");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: { cookie },
      payload: {
        name: "First Agent",
        runtime: "openclaw",
        capabilities: { email: true },
        approvalMode: "always"
      }
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json<{ agent: { id: string }; identityToken: { secret: string } }>();
    let me = await getMe(cookie);
    expect(me.user.onboarding.steps.agent_created).toEqual(expect.any(String));

    const whoami = await app.inject({
      method: "GET",
      url: "/api/v1/agent/whoami",
      headers: { authorization: `Bearer ${createdBody.identityToken.secret}` }
    });
    expect(whoami.statusCode).toBe(200);
    me = await getMe(cookie);
    expect(me.user.onboarding.steps.runtime_connected).toEqual(expect.any(String));

    const send = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${createdBody.agent.id}/email/send?mode=async`,
      headers: { cookie },
      payload: {
        to: "first-run@example.com",
        subject: "First action",
        text: "Hello from the first-run drill."
      }
    });
    expect(send.statusCode).toBe(202);
    const approvalId = send.json<{ approval_id: string }>().approval_id;

    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/approve`,
      headers: { cookie },
      payload: { note: "Looks good" }
    });
    expect(approved.statusCode).toBe(200);
    me = await getMe(cookie);
    expect(me.user.onboarding.steps.first_email_sent).toEqual(expect.any(String));
    expect(me.user.onboarding.steps.approval_decided).toEqual(expect.any(String));
    expect(me.user.onboarding.completedAt).toEqual(expect.any(String));

    const dismissed = await app.inject({
      method: "PATCH",
      url: "/api/v1/onboarding",
      headers: { cookie },
      payload: { dismissed: true }
    });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json().onboarding.dismissedAt).toEqual(expect.any(String));

    const activation = await app.inject({ method: "GET", url: "/api/v1/ops/activation", headers: { cookie } });
    expect(activation.statusCode).toBe(200);
    expect(activation.json()).toMatchObject({
      usersStarted: 1,
      stepCounts: {
        agent_created: 1,
        runtime_connected: 1,
        first_email_sent: 1,
        approval_decided: 1
      }
    });
    expect(activation.json().medianTimeToFirstActionMs).toEqual(expect.any(Number));
  });
});

async function signup(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email, password: "password123" }
  });
  expect(response.statusCode).toBe(200);
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function getMe(cookie: string) {
  const response = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json<{
    user: {
      onboarding: {
        completedAt: string | null;
        steps: Record<string, string | null>;
      };
    };
  }>();
}
