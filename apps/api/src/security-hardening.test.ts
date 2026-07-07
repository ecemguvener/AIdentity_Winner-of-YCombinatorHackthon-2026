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

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("auth hardening", () => {
  it("requires 10 character passwords at signup and password change", async () => {
    const shortSignup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "short-password@example.com", password: "123456789" }
    });
    expect(shortSignup.statusCode).toBe(400);

    const cookie = await signup("password-change@example.com");
    const shortChange = await app.inject({
      method: "POST",
      url: "/api/auth/me/password",
      cookies: { [config.SESSION_COOKIE_NAME]: cookie },
      payload: { currentPassword: "password12345", newPassword: "short" }
    });
    expect(shortChange.statusCode).toBe(400);
  });

  it("rotates sessions on login and enforces server-side logout", async () => {
    const signupCookie = await signup("rotate@example.com");
    expect(await database.collections.sessions.countDocuments()).toBeGreaterThanOrEqual(1);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "rotate@example.com", password: "password12345" }
    });
    expect(login.statusCode).toBe(200);
    const loginCookie = login.cookies.find((cookie) => cookie.name === config.SESSION_COOKIE_NAME)?.value;
    expect(loginCookie).toBeTruthy();

    const oldSession = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { [config.SESSION_COOKIE_NAME]: signupCookie }
    });
    expect(oldSession.statusCode).toBe(401);

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      cookies: { [config.SESSION_COOKIE_NAME]: loginCookie! }
    });
    expect(logout.statusCode).toBe(200);
    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { [config.SESSION_COOKIE_NAME]: loginCookie! }
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("tracks failed logins and returns 423 while an account lock is active", async () => {
    await signup("locked@example.com");
    const failed = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "locked@example.com", password: "wrong-password" }
    });
    expect(failed.statusCode).toBe(401);
    const user = await database.collections.users.findOne({ email: "locked@example.com" });
    expect(user?.loginFailedCount).toBe(1);
    await database.collections.users.updateOne(
      { _id: user!._id },
      { $set: { loginFailedCount: 10, loginFirstFailedAt: new Date(), loginLockedUntil: new Date(Date.now() + 15 * 60 * 1000) } }
    );

    const locked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "locked@example.com", password: "password12345" }
    });
    expect(locked.statusCode).toBe(423);
    expect(locked.json().error.details.lockedUntil).toBeTruthy();
  });
});

describe("transport hardening", () => {
  it("sets helmet security headers and docs CSP", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.headers["x-frame-options"]).toBe("DENY");
    expect(health.headers["x-content-type-options"]).toBe("nosniff");

    const docs = await app.inject({ method: "GET", url: "/docs" });
    expect(docs.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  it("rejects request bodies over 1MB", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/check-email",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: `${"a".repeat(1024 * 1024)}@example.com` })
    });
    expect(response.statusCode).toBe(413);
  });
});

async function signup(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email, password: "password12345" }
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((candidate) => candidate.name === config.SESSION_COOKIE_NAME)?.value;
  expect(cookie).toBeTruthy();
  return cookie!;
}
