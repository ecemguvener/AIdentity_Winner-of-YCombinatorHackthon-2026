import crypto from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { connectDatabase, type Database } from "../db.js";
import {
  providerVerifier,
  registerRawBodyParsers,
  registerWebhookRoute,
  type WebhookRouteOptions
} from "./framework.js";
import { registerWebhookRoutes } from "./routes.js";

const STRIPE_SECRET = "whsec_stripe_framework_test";
const TWILIO_AUTH_TOKEN = "twilio-framework-test-token";
const RESEND_SECRET = `whsec_${Buffer.from("resend-framework-test-secret").toString("base64")}`;

const baseConfig = {
  NODE_ENV: "test",
  PUBLIC_API_URL: "http://localhost:4001",
  SESSION_COOKIE_NAME: "barkan_session",
  SESSION_SECRET: "framework-test-session-secret",
  PROVIDER_MODE_EMAIL: "mock",
  PROVIDER_MODE_PHONE: "mock",
  STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
  TWILIO_AUTH_TOKEN
} as unknown as AppConfig;

let mongoServer: MongoMemoryServer;
let database: Database;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  database = await connectDatabase({ MONGODB_URI: mongoServer.getUri() } as AppConfig);
}, 60_000);

afterAll(async () => {
  await database?.client.close();
  await mongoServer?.stop();
});

function buildApp(config: AppConfig, options: WebhookRouteOptions) {
  const app = Fastify({ logger: false });
  registerRawBodyParsers(app);
  registerWebhookRoute(app, database.collections, config, options);
  return app;
}

function stripeOptions(path: string, handle: WebhookRouteOptions["handle"]): WebhookRouteOptions {
  return {
    path,
    provider: "stripe",
    verify: providerVerifier("stripe"),
    extractEventId: (payload) => (isRecord(payload) && typeof payload.id === "string" ? payload.id : null),
    extractEventType: (payload) => (isRecord(payload) && typeof payload.type === "string" ? payload.type : "unknown"),
    handle
  };
}

function stripeSignatureFor(body: string): string {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac("sha256", STRIPE_SECRET).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

function svixHeadersFor(id: string, body: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(RESEND_SECRET.slice("whsec_".length), "base64");
  const signature = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

describe("registerWebhookRoute", () => {
  it("verifies, processes, and records a JSON webhook exactly once", async () => {
    let handled = 0;
    const app = buildApp(baseConfig, stripeOptions("/webhooks/test/stripe", () => void (handled += 1)));
    const body = JSON.stringify({ id: "evt_process_1", type: "invoice.paid" });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/test/stripe",
      headers: { "content-type": "application/json", "stripe-signature": stripeSignatureFor(body) },
      payload: body
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, event_id: "evt_process_1" });
    expect(handled).toBe(1);

    const event = await database.collections.webhookEvents.findOne({ provider: "stripe", providerEventId: "evt_process_1" });
    expect(event?.status).toBe("processed");
    expect(event?.eventType).toBe("invoice.paid");
    expect(event?.payloadHash).toBe(crypto.createHash("sha256").update(body).digest("hex"));
    expect(event?.processedAt).toBeInstanceOf(Date);

    await app.close();
  });

  it("rejects a tampered payload with 401 and does not record an event", async () => {
    let handled = 0;
    const app = buildApp(baseConfig, stripeOptions("/webhooks/test/stripe", () => void (handled += 1)));
    const body = JSON.stringify({ id: "evt_tampered_1", type: "invoice.paid" });
    const tampered = body.replace("invoice.paid", "invoice.PAID");

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/test/stripe",
      headers: { "content-type": "application/json", "stripe-signature": stripeSignatureFor(body) },
      payload: tampered
    });
    expect(response.statusCode).toBe(401);
    expect(handled).toBe(0);
    expect(await database.collections.webhookEvents.findOne({ providerEventId: "evt_tampered_1" })).toBeNull();

    await app.close();
  });

  it("skips a replayed event id without re-running the handler", async () => {
    let handled = 0;
    const app = buildApp(baseConfig, stripeOptions("/webhooks/test/stripe", () => void (handled += 1)));
    const body = JSON.stringify({ id: "evt_replay_1", type: "invoice.paid" });

    const first = await app.inject({
      method: "POST",
      url: "/webhooks/test/stripe",
      headers: { "content-type": "application/json", "stripe-signature": stripeSignatureFor(body) },
      payload: body
    });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: "/webhooks/test/stripe",
      headers: { "content-type": "application/json", "stripe-signature": stripeSignatureFor(body) },
      payload: body
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ skipped: true });
    expect(handled).toBe(1);

    await app.close();
  });

  it("dead-letters a failing handler with the error, then processes the retry", async () => {
    let attempts = 0;
    const app = buildApp(
      baseConfig,
      stripeOptions("/webhooks/test/stripe", () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("downstream unavailable");
        }
      })
    );
    const body = JSON.stringify({ id: "evt_failed_1", type: "invoice.paid" });
    const deliver = () =>
      app.inject({
        method: "POST",
        url: "/webhooks/test/stripe",
        headers: { "content-type": "application/json", "stripe-signature": stripeSignatureFor(body) },
        payload: body
      });

    const firstAttempt = await deliver();
    expect(firstAttempt.statusCode).toBe(500);
    const failedEvent = await database.collections.webhookEvents.findOne({ providerEventId: "evt_failed_1" });
    expect(failedEvent?.status).toBe("failed");
    expect(failedEvent?.error).toBe("downstream unavailable");

    const retry = await deliver();
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ ok: true });
    const processedEvent = await database.collections.webhookEvents.findOne({ providerEventId: "evt_failed_1" });
    expect(processedEvent?.status).toBe("processed");
    expect(processedEvent?.error).toBeUndefined();
    expect(attempts).toBe(2);

    await app.close();
  });

  it("runs the handler exactly once for two simultaneous deliveries of the same event", async () => {
    let handled = 0;
    const app = buildApp(
      baseConfig,
      stripeOptions("/webhooks/test/stripe", async () => {
        handled += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
      })
    );
    const body = JSON.stringify({ id: "evt_concurrent_1", type: "invoice.paid" });
    const deliver = () =>
      app.inject({
        method: "POST",
        url: "/webhooks/test/stripe",
        headers: { "content-type": "application/json", "stripe-signature": stripeSignatureFor(body) },
        payload: body
      });

    const [first, second] = await Promise.all([deliver(), deliver()]);
    expect(handled).toBe(1);
    const statuses = [first.json(), second.json()];
    expect(statuses.filter((payload) => payload.skipped === true)).toHaveLength(1);
    expect(statuses.filter((payload) => payload.ok === true)).toHaveLength(1);

    await app.close();
  });

  it("verifies Twilio form-encoded posts over the raw urlencoded body", async () => {
    let received: unknown = null;
    const app = buildApp(baseConfig, {
      path: "/webhooks/test/twilio",
      provider: "twilio",
      verify: providerVerifier("twilio"),
      extractEventId: (payload) =>
        isRecord(payload) && typeof payload.MessageSid === "string" ? payload.MessageSid : null,
      extractEventType: () => "sms.status",
      handle: (payload) => void (received = payload)
    });

    const params: Record<string, string> = { MessageSid: "SM_form_1", MessageStatus: "delivered", To: "+15550100" };
    const url = `${baseConfig.PUBLIC_API_URL}/webhooks/test/twilio`;
    const signedContent =
      url +
      Object.keys(params)
        .sort()
        .map((key) => key + params[key])
        .join("");
    const signature = crypto.createHmac("sha1", TWILIO_AUTH_TOKEN).update(signedContent).digest("base64");

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/test/twilio",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
      payload: new URLSearchParams(params).toString()
    });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual(params);

    const tampered = await app.inject({
      method: "POST",
      url: "/webhooks/test/twilio",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
      payload: new URLSearchParams({ ...params, MessageStatus: "failed" }).toString()
    });
    expect(tampered.statusCode).toBe(401);

    await app.close();
  });

  it("honors the mock-signature bypass only in mock mode without a secret", async () => {
    const mockConfig = { ...baseConfig, RESEND_WEBHOOK_SECRET: undefined } as AppConfig;
    const resendOptions: WebhookRouteOptions = {
      path: "/webhooks/test/resend",
      provider: "resend",
      verify: providerVerifier("resend"),
      extractEventId: (payload) => (isRecord(payload) && typeof payload.id === "string" ? payload.id : null),
      extractEventType: () => "ping",
      handle: () => {}
    };

    const mockApp = buildApp(mockConfig, resendOptions);
    const allowed = await mockApp.inject({
      method: "POST",
      url: "/webhooks/test/resend",
      headers: { "content-type": "application/json", "x-mock-signature": "allow" },
      payload: JSON.stringify({ id: "evt_mock_1" })
    });
    expect(allowed.statusCode).toBe(200);

    const withoutHeader = await mockApp.inject({
      method: "POST",
      url: "/webhooks/test/resend",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ id: "evt_mock_2" })
    });
    expect(withoutHeader.statusCode).toBe(401);
    await mockApp.close();

    // Never in live mode: a configured secret disables the bypass entirely.
    const liveConfig = {
      ...baseConfig,
      PROVIDER_MODE_EMAIL: "live",
      RESEND_WEBHOOK_SECRET: "whsec_live_secret"
    } as AppConfig;
    const liveApp = buildApp(liveConfig, resendOptions);
    const rejected = await liveApp.inject({
      method: "POST",
      url: "/webhooks/test/resend",
      headers: { "content-type": "application/json", "x-mock-signature": "allow" },
      payload: JSON.stringify({ id: "evt_mock_3" })
    });
    expect(rejected.statusCode).toBe(401);
    await liveApp.close();
  });
});

describe("registerWebhookRoutes", () => {
  it("accepts signed Resend events whose id is only in Svix headers", async () => {
    const liveConfig = {
      ...baseConfig,
      PROVIDER_MODE_EMAIL: "live",
      RESEND_WEBHOOK_SECRET: RESEND_SECRET
    } as AppConfig;
    const app = Fastify({ logger: false });
    await app.register(cookie);
    registerRawBodyParsers(app);
    registerWebhookRoutes(app, database.collections, liveConfig);
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_header_only_1" } });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers: { "content-type": "application/json", ...svixHeadersFor("msg_header_only_1", body) },
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, event_id: "msg_header_only_1" });
    const event = await database.collections.webhookEvents.findOne({ provider: "resend", providerEventId: "msg_header_only_1" });
    expect(event).toMatchObject({ eventType: "email.delivered", status: "processed" });

    await app.close();
  });

  it("exercises the dev ping route end-to-end with replay dedupe", async () => {
    const mockConfig = { ...baseConfig, STRIPE_WEBHOOK_SECRET: undefined, RESEND_WEBHOOK_SECRET: undefined } as AppConfig;
    const app = Fastify({ logger: false });
    await app.register(cookie);
    registerRawBodyParsers(app);
    registerWebhookRoutes(app, database.collections, mockConfig);

    const deliver = () =>
      app.inject({
        method: "POST",
        url: "/webhooks/ping/resend",
        headers: { "content-type": "application/json", "x-mock-signature": "allow" },
        payload: JSON.stringify({ id: "evt_ping_1", type: "ping" })
      });

    const first = await deliver();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true });

    const replay = await deliver();
    expect(replay.json()).toEqual({ skipped: true });

    await app.close();
  });

  it("requires a session for the webhook events ops listing", async () => {
    const app = Fastify({ logger: false });
    await app.register(cookie);
    registerRawBodyParsers(app);
    registerWebhookRoutes(app, database.collections, baseConfig);

    const response = await app.inject({ method: "GET", url: "/api/v1/webhook-events?status=failed" });
    expect(response.statusCode).toBe(401);

    await app.close();
  });
});
