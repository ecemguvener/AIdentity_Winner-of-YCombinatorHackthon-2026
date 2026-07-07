import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { connectDatabase, type Database } from "./db.js";
import { clearStripeEventHandlersForTest, registerStripeEventHandler } from "./stripe-webhooks.js";
import {
  checkoutSessionCompleted,
  customerSubscriptionCreated,
  invoicePaymentFailed,
  signStripeFixture,
  stripeFixtureSecret
} from "./webhooks/__fixtures__/stripe.js";

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
  STRIPE_SECRET_KEY: "sk_test_webhooks",
  STRIPE_WEBHOOK_SECRET: stripeFixtureSecret,
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
  clearStripeEventHandlersForTest();
  await database.collections.webhookEvents.deleteMany({});
});

afterEach(() => {
  clearStripeEventHandlersForTest();
});

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("Stripe billing webhook", () => {
  it("verifies, dispatches, and records a handled event", async () => {
    const handled: string[] = [];
    registerStripeEventHandler("checkout.session.completed", (event) => {
      handled.push(event.id);
      return { ok: true, routed: event.type };
    });
    const fixture = signStripeFixture(checkoutSessionCompleted());

    const response = await deliverStripe(fixture.body, fixture.signature);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, routed: "checkout.session.completed" });
    expect(handled).toEqual(["evt_checkout_completed"]);
    expect(await database.collections.webhookEvents.findOne({ providerEventId: "evt_checkout_completed" }))
      .toMatchObject({ provider: "stripe", eventType: "checkout.session.completed", status: "processed" });
  });

  it("rejects tampered payloads with 401 and records no event", async () => {
    const fixture = signStripeFixture(checkoutSessionCompleted({ id: "evt_tampered" }));
    const tamperedBody = fixture.body.replace("checkout.session.completed", "checkout.session.async_payment_failed");

    const response = await deliverStripe(tamperedBody, fixture.signature);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect(await database.collections.webhookEvents.findOne({ providerEventId: "evt_tampered" })).toBeNull();
  });

  it("skips replayed event ids without re-running the handler", async () => {
    let handled = 0;
    registerStripeEventHandler("customer.subscription.created", () => {
      handled += 1;
    });
    const fixture = signStripeFixture(customerSubscriptionCreated());

    const first = await deliverStripe(fixture.body, fixture.signature);
    const replay = await deliverStripe(fixture.body, fixture.signature);

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ skipped: true });
    expect(handled).toBe(1);
  });

  it("marks unhandled event types as skipped", async () => {
    const fixture = signStripeFixture(invoicePaymentFailed());

    const response = await deliverStripe(fixture.body, fixture.signature);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ skipped: true, event_id: "evt_invoice_payment_failed", event_type: "invoice.payment_failed" });
    expect(await database.collections.webhookEvents.findOne({ providerEventId: "evt_invoice_payment_failed" }))
      .toMatchObject({ provider: "stripe", status: "skipped" });
  });

  it("does not register the billing webhook until Stripe billing config exists", async () => {
    const noStripeApp = await buildApp({
      ...config,
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined
    } as AppConfig, database.collections);
    const fixture = signStripeFixture(checkoutSessionCompleted({ id: "evt_not_registered" }));

    const response = await noStripeApp.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": fixture.signature },
      payload: fixture.body
    });

    expect(response.statusCode).toBe(404);
    await noStripeApp.close();
  });
});

async function deliverStripe(body: string, signature: string) {
  return app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    payload: body
  });
}
