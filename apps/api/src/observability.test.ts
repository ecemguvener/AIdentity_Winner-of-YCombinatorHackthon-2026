import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { evaluateAlertRules } from "./alerting.js";
import type { AppConfig } from "./config.js";
import { connectDatabase, type Database } from "./db.js";
import { getDeepHealth } from "./health.js";
import { instrumentProviderCall, recordWebhookEventMetric, resetMetricsForTest } from "./metrics.js";
import { scrubSentryEvent } from "./sentry.js";

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
  resetMetricsForTest();
  await Promise.all([
    database.collections.approvals.deleteMany({}),
    database.collections.webhookEvents.deleteMany({})
  ]);
});

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("Sentry scrubbing", () => {
  it("redacts request headers, emails, passwords, and transcripts", () => {
    const event = scrubSentryEvent({
      request: {
        headers: { authorization: "Bearer secret", cookie: "sid=secret" },
        data: { email: "owner@example.com", password: "password12345", safe: "ok" }
      },
      contexts: { call: { transcript: [{ message: "private" }] } },
      message: "failed owner@example.com"
    });

    expect(event.request?.headers).toEqual({ authorization: "[redacted]", cookie: "[redacted]" });
    expect(event.request?.data).toMatchObject({ email: "[redacted]", password: "[redacted]", safe: "ok" });
    expect(event.contexts?.call).toEqual({ transcript: "[redacted]" });
    expect(event.message).toBe("[redacted]");
  });
});

describe("metrics", () => {
  it("exports Prometheus families for HTTP, provider calls, webhooks, and gauges", async () => {
    await instrumentProviderCall("stripe", "checkout.sessions.create", async () => ({ ok: true }));
    recordWebhookEventMetric("stripe", "processed");
    await database.collections.approvals.insertOne({
      _id: new ObjectId(),
      agentId: new ObjectId(),
      ownerUserId: new ObjectId(),
      kind: "email.send",
      status: "pending",
      payloadSummary: "Send email",
      payload: {},
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await app.inject({ method: "GET", url: "/api/health" });
    const response = await app.inject({ method: "GET", url: "/internal/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("http_request_duration_ms_bucket");
    expect(response.body).toContain("provider_call_duration_ms_bucket");
    expect(response.body).toContain('webhook_events_total{provider="stripe",status="processed"} 1');
    expect(response.body).toContain("approvals_pending 1");
    expect(response.body).toContain("sse_connections 0");
  });
});

describe("alerts", () => {
  it("fires for failed webhooks, provider error rate, and old pending approvals", async () => {
    const now = new Date();
    await database.collections.webhookEvents.insertOne({
      _id: new ObjectId(),
      provider: "stripe",
      providerEventId: "evt_failed",
      eventType: "invoice.failed",
      payloadHash: "hash",
      status: "failed",
      error: "boom",
      createdAt: now,
      updatedAt: now
    });
    await database.collections.approvals.insertOne({
      _id: new ObjectId(),
      agentId: new ObjectId(),
      ownerUserId: new ObjectId(),
      kind: "sms.send",
      status: "pending",
      payloadSummary: "Send SMS",
      payload: {},
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: new Date(now.getTime() - 56 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 56 * 60 * 1000)
    });

    await Promise.all([
      instrumentProviderCall("twilio", "messages.create", async () => ({ ok: true })),
      instrumentProviderCall("twilio", "messages.create", async () => ({ ok: true })),
      instrumentProviderCall("twilio", "messages.create", async () => ({ ok: true })),
      instrumentProviderCall("twilio", "messages.create", async () => { throw new Error("down"); }).catch(() => undefined),
      instrumentProviderCall("twilio", "messages.create", async () => { throw new Error("down"); }).catch(() => undefined)
    ]);

    const alerts = await evaluateAlertRules(database.collections, config, now);
    expect(alerts.map((alert) => alert.key).sort()).toEqual([
      "approvals.pending_old",
      "provider.twilio.error_rate",
      "webhook.failed"
    ]);
  });
});

describe("health", () => {
  it("returns shallow and cached deep health", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, mongo: "ok" });
    expect(typeof health.json().uptime).toBe("number");

    const first = await getDeepHealth(config, Date.parse("2026-07-07T12:00:00Z"));
    const second = await getDeepHealth(config, Date.parse("2026-07-07T12:00:30Z"));
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(first.providers.resend).toMatchObject({ ok: true, mode: "mock" });
  });
});
