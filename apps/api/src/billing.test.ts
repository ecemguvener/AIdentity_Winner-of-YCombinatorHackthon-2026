import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { connectDatabase, type AgentDocument, type Database, type UserDocument } from "./db.js";
import { hashPassword } from "./security.js";
import { setStripeClientForTest, type Stripe } from "./providers/stripe-client.js";
import {
  customerSubscriptionCreated,
  customerSubscriptionUpdated,
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
  STRIPE_SECRET_KEY: "sk_test_billing",
  STRIPE_WEBHOOK_SECRET: stripeFixtureSecret,
  BILLING_PRICE_PRO: "price_pro",
  BILLING_PRICE_SCALE: "price_scale",
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
let stripeState: ReturnType<typeof createStripeMock>["state"];

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
}, 60_000);

beforeEach(async () => {
  await Promise.all([
    database.collections.users.deleteMany({}),
    database.collections.sessions.deleteMany({}),
    database.collections.agents.deleteMany({}),
    database.collections.phoneNumbers.deleteMany({}),
    database.collections.billingAccounts.deleteMany({}),
    database.collections.auditLogs.deleteMany({}),
    database.collections.webhookEvents.deleteMany({})
  ]);
  const mock = createStripeMock();
  stripeState = mock.state;
  setStripeClientForTest(mock.client);
  app = await buildApp(config, database.collections);
});

afterEach(async () => {
  setStripeClientForTest(null);
  await app?.close();
});

afterAll(async () => {
  await database?.client.close();
  await mongoServer?.stop();
});

describe("billing routes and Stripe sync", () => {
  it("returns plan catalog from the server-side billing catalog", async () => {
    const { cookie } = await insertOwnerSession();

    const response = await app.inject({ method: "GET", url: "/api/v1/billing/plans", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json().plans).toMatchObject([
      { plan: "free", monthlyPriceEur: 0, limits: { agents: 1, phoneNumbers: 0 }, includedUsage: { emails: 50 } },
      { plan: "pro", monthlyPriceEur: 29, limits: { agents: 3, phoneNumbers: 1 }, includedUsage: { callMinutes: 120 } },
      { plan: "scale", monthlyPriceEur: 99, limits: { agents: 10, phoneNumbers: 3 }, includedUsage: { sms: 1000 } }
    ]);
  });

  it("creates a free billing account on signup", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "owner@example.com", password: "strong-password" }
    });

    expect(response.statusCode).toBe(200);
    const user = await database.collections.users.findOne({ email: "owner@example.com" });
    expect(await database.collections.billingAccounts.findOne({ ownerUserId: user!._id })).toMatchObject({
      stripeCustomerId: "cus_mock_1",
      plan: "free"
    });
  });

  it("creates checkout and portal sessions for a subscribed owner", async () => {
    const { cookie } = await insertOwnerSession();

    const checkout = await app.inject({
      method: "POST",
      url: "/api/v1/billing/checkout",
      headers: { cookie },
      payload: { plan: "pro" }
    });
    expect(checkout.statusCode).toBe(200);
    expect(checkout.json()).toEqual({ checkoutUrl: "https://stripe.test/checkout/1" });
    expect(stripeState.checkoutSessions[0]).toMatchObject({
      mode: "subscription",
      customer: "cus_mock_1",
      line_items: [{ price: "price_pro", quantity: 1 }]
    });

    const portal = await app.inject({ method: "POST", url: "/api/v1/billing/portal", headers: { cookie } });
    expect(portal.statusCode).toBe(200);
    expect(portal.json()).toEqual({ portalUrl: "https://stripe.test/portal/1" });
  });

  it("blocks checkout when current usage exceeds target plan limits", async () => {
    const { user, cookie } = await insertOwnerSession();
    for (let index = 0; index < 5; index += 1) {
      await insertAgent(user, `Agent ${index + 1}`);
    }

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/billing/checkout",
      headers: { cookie },
      payload: { plan: "pro" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.details.blocking).toContain("Remove 2 agent identity before selecting pro.");
  });

  it("syncs subscription webhooks and ignores older replays", async () => {
    const { user } = await insertOwnerSession();
    await database.collections.billingAccounts.insertOne({
      _id: new ObjectId(),
      ownerUserId: user._id,
      stripeCustomerId: "cus_test_123",
      plan: "free",
      createdAt: new Date(),
      updatedAt: new Date()
    });
    const current = signStripeFixture(customerSubscriptionUpdated({ id: "evt_sub_new", created: 2000 }));
    const old = signStripeFixture(customerSubscriptionCreated({ id: "evt_sub_old", created: 1000 }));

    expect((await deliverStripe(current.body, current.signature)).statusCode).toBe(200);
    expect((await deliverStripe(old.body, old.signature)).statusCode).toBe(200);

    expect(await database.collections.billingAccounts.findOne({ ownerUserId: user._id })).toMatchObject({
      plan: "pro",
      subscriptionId: "sub_test_123",
      subscriptionStatus: "active",
      lastStripeEventCreated: 2000
    });
  });

  it("marks invoice payment failures past_due and records owner audit", async () => {
    const { user } = await insertOwnerSession();
    const agent = await insertAgent(user, "Billing Agent");
    await database.collections.billingAccounts.insertOne({
      _id: new ObjectId(),
      ownerUserId: user._id,
      stripeCustomerId: "cus_test_123",
      plan: "pro",
      subscriptionStatus: "active",
      createdAt: new Date(),
      updatedAt: new Date()
    });
    const fixture = signStripeFixture(invoicePaymentFailed());

    const response = await deliverStripe(fixture.body, fixture.signature);

    expect(response.statusCode).toBe(200);
    expect(await database.collections.billingAccounts.findOne({ ownerUserId: user._id })).toMatchObject({ subscriptionStatus: "past_due" });
    expect(await database.collections.auditLogs.findOne({ agentId: agent._id, action: "billing.payment_failed" }))
      .toMatchObject({ status: "blocked", detail: "Stripe invoice payment failed for owner@example.com." });
  });

  it("returns platform ops status", async () => {
    const { cookie } = await insertOwnerSession();
    await database.collections.webhookEvents.insertOne({
      _id: new ObjectId(),
      provider: "stripe",
      providerEventId: "evt_status",
      eventType: "customer.subscription.updated",
      payloadHash: "hash",
      status: "processed",
      createdAt: new Date("2026-07-07T12:00:00.000Z"),
      updatedAt: new Date("2026-07-07T12:00:00.000Z")
    });
    await database.collections.phoneNumbers.insertOne({
      _id: new ObjectId(),
      agentId: new ObjectId(),
      e164: "+15005550001",
      country: "US",
      twilioSid: "PN123",
      capabilitiesVoice: true,
      capabilitiesSms: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/ops/status", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      providerModes: { email: "mock", phone: "mock", billing: "live" },
      emailDomainVerified: false,
      stripeWebhookLastSeenAt: "2026-07-07T12:00:00.000Z",
      twilioNumbers: 1
    });
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

async function insertOwnerSession(): Promise<{ user: UserDocument; cookie: string }> {
  const now = new Date();
  const user: UserDocument = {
    _id: new ObjectId(),
    email: "owner@example.com",
    passwordHash: await hashPassword("strong-password"),
    createdAt: now,
    updatedAt: now
  };
  await database.collections.users.insertOne(user);

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: user.email, password: "strong-password" }
  });
  return { user, cookie: login.headers["set-cookie"] as string };
}

async function insertAgent(user: UserDocument, name: string): Promise<AgentDocument> {
  const now = new Date();
  const agent: AgentDocument = {
    _id: new ObjectId(),
    ownerUserId: user._id,
    name,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    status: "active",
    capabilities: { email: true, phone: true },
    approvalMode: "policy",
    createdAt: now,
    updatedAt: now
  };
  await database.collections.agents.insertOne(agent);
  return agent;
}

function createStripeMock() {
  const state = {
    customers: [] as Array<Record<string, unknown>>,
    checkoutSessions: [] as Array<Record<string, unknown>>,
    portalSessions: [] as Array<Record<string, unknown>>
  };
  const client = {
    customers: {
      create: async (input: Record<string, unknown>) => {
        state.customers.push(input);
        return { id: `cus_mock_${state.customers.length}` };
      }
    },
    checkout: {
      sessions: {
        create: async (input: Record<string, unknown>) => {
          state.checkoutSessions.push(input);
          return { id: `cs_mock_${state.checkoutSessions.length}`, url: `https://stripe.test/checkout/${state.checkoutSessions.length}` };
        }
      }
    },
    billingPortal: {
      sessions: {
        create: async (input: Record<string, unknown>) => {
          state.portalSessions.push(input);
          return { id: `bps_mock_${state.portalSessions.length}`, url: `https://stripe.test/portal/${state.portalSessions.length}` };
        }
      }
    }
  } as unknown as Stripe;
  return { state, client };
}
