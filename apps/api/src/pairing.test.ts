import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
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
  EMAIL_AGENT_DOMAIN: "agents.barkan.dev",
  EMAIL_PLATFORM_FROM: "Barkan <no-reply@barkan.dev>",
  API_RATE_LIMIT_MAX: 1000
} as unknown as AppConfig;

let mongoServer: MongoMemoryServer;
let database: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
let ownerCookie: string;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);
  ownerCookie = await signup("pairing-owner@example.com");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("pairing flow", () => {
  it("starts, confirms, returns token once, then scrubs it", async () => {
    const agent = await createAgent("Pairable");
    const start = await app.inject({ method: "POST", url: "/api/v1/pairing/start" });
    expect(start.statusCode).toBe(200);
    const started = start.json<{ code: string; confirmUrl: string }>();
    expect(started.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(started.confirmUrl).toContain(`/pair?code=${started.code}`);

    const pending = await app.inject({
      method: "POST",
      url: "/api/v1/pairing/poll",
      payload: { code: started.code }
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toEqual({ status: "pending" });

    const confirm = await app.inject({
      method: "POST",
      url: `/api/v1/pairing/${started.code}/confirm`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie },
      payload: { agentId: agent.id }
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json()).toMatchObject({ status: "confirmed", agentId: agent.id });

    const firstPoll = await app.inject({
      method: "POST",
      url: "/api/v1/pairing/poll",
      payload: { code: started.code.replace("-", "") }
    });
    expect(firstPoll.statusCode).toBe(200);
    const claimed = firstPoll.json<{ status: string; identityToken: string; agentId: string; apiUrl: string }>();
    expect(claimed).toMatchObject({ status: "confirmed", agentId: agent.id, apiUrl: "http://localhost:4001" });
    expect(claimed.identityToken).toMatch(/^brk_test_/);

    const stored = await database.collections.pairingRequests.findOne({ code: started.code.replace("-", "") });
    expect(stored?.status).toBe("claimed");
    expect(stored?.identityTokenPlaintext).toBeUndefined();

    const secondPoll = await app.inject({
      method: "POST",
      url: "/api/v1/pairing/poll",
      payload: { code: started.code }
    });
    expect(secondPoll.statusCode).toBe(409);
    expect(secondPoll.json().error.code).toBe("already_claimed");

    const token = await database.collections.identityTokens.findOne({ agentId: new ObjectId(agent.id), name: "Paired runtime" });
    expect(token?.prefix).toBe(claimed.identityToken.slice(0, 12));
  });

  it("expires stale codes and rejects unknown codes", async () => {
    const now = new Date();
    await database.collections.pairingRequests.insertOne({
      _id: new ObjectId(),
      code: "EXPIRED1",
      status: "pending",
      expiresAt: new Date(now.getTime() - 1000),
      createdAt: now,
      updatedAt: now
    });

    const expired = await app.inject({
      method: "POST",
      url: "/api/v1/pairing/poll",
      payload: { code: "EXPI-RED1" }
    });
    expect(expired.statusCode).toBe(200);
    expect(expired.json()).toEqual({ status: "expired" });

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/pairing/poll",
      payload: { code: "NOPE-NOPE" }
    });
    expect(missing.statusCode).toBe(404);
  });

  it("rate limits pairing start by IP", async () => {
    const limitedApp = await buildApp(config, database.collections);
    const statuses: number[] = [];
    for (let index = 0; index < 6; index++) {
      const response = await limitedApp.inject({
        method: "POST",
        url: "/api/v1/pairing/start",
        remoteAddress: "203.0.113.47"
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
    await limitedApp.close();
  });
});

async function signup(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email, password: "password12345" }
  });
  expect([200, 201]).toContain(response.statusCode);
  const cookie = response.cookies.find((candidate) => candidate.name === config.SESSION_COOKIE_NAME);
  expect(cookie).toBeDefined();
  return cookie!.value;
}

async function createAgent(name: string): Promise<{ id: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agents",
    cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie },
    payload: { name }
  });
  expect(response.statusCode).toBe(201);
  return { id: response.json().agent.id };
}
