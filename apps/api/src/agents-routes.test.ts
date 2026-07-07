import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { connectDatabase, type Database } from "./db.js";
import { getProvisioner, registerProvisioner } from "./provisioning.js";

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
let otherCookie: string;

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

async function setBillingPlan(email: string, plan: "free" | "pro" | "scale"): Promise<void> {
  const user = await database.collections.users.findOne({ email });
  expect(user).toBeTruthy();
  await database.collections.billingAccounts.updateOne(
    { ownerUserId: user!._id },
    {
      $set: {
        stripeCustomerId: `cus_${plan}_${user!._id.toHexString()}`,
        plan,
        subscriptionStatus: plan === "free" ? undefined : "active",
        updatedAt: new Date()
      },
      $setOnInsert: { _id: new ObjectId(), createdAt: new Date() }
    },
    { upsert: true }
  );
}

async function createAgent(payload: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agents",
    cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie },
    payload: { name: "Maya", ...payload }
  });
  expect(response.statusCode).toBe(201);
  return response.json<{
    agent: { id: string; slug: string; status: string; capabilities: { email: boolean; phone: boolean } };
    identityToken: { secret: string; prefix: string };
  }>();
}

async function getAgentDetail(agentId: string, cookie = ownerCookie) {
  return app.inject({
    method: "GET",
    url: `/api/v1/agents/${agentId}`,
    cookies: { [config.SESSION_COOKIE_NAME]: cookie }
  });
}

async function waitForCapability(agentId: string, capability: "email" | "phone", expected: boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const detail = await getAgentDetail(agentId);
    const enabled = detail.json().agent.capabilities[capability] as boolean;
    if (enabled === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`capability ${capability} never became ${expected}`);
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);
  ownerCookie = await signup("owner@example.com");
  otherCookie = await signup("other@example.com");
  await setBillingPlan("owner@example.com", "scale");
  await setBillingPlan("other@example.com", "scale");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("POST /api/v1/agents", () => {
  it("creates an agent with a one-time identity token and audit entry", async () => {
    const created = await createAgent({
      name: "Maya",
      description: "Customer discovery",
      capabilities: { email: true, phone: false },
      approvalMode: "policy"
    });

    expect(created.agent).toMatchObject({
      name: "Maya",
      slug: "maya",
      status: "active",
      capabilities: { email: true, phone: false },
      approvalMode: "policy",
      emailAddress: "maya@agents.barkan.dev",
      phoneE164: null
    });
    expect(created.identityToken.secret).toMatch(/^brk_test_[A-Za-z0-9_-]{43}$/);
    expect(created.identityToken.prefix).toBe(created.identityToken.secret.slice(0, 12));

    const auditRow = await database.collections.auditLogs.findOne({
      agentId: new ObjectId(created.agent.id),
      action: "agent.create"
    });
    expect(auditRow?.actor).toBe("owner");

    const policy = await database.collections.policies.findOne({ agentId: new ObjectId(created.agent.id) });
    expect(policy).not.toBeNull();
  });

  it("lists agents with a per-capability provisioning summary", async () => {
    const created = await createAgent({ name: "Lister" });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agents",
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
    });
    expect(response.statusCode).toBe(200);
    const listed = response
      .json<{ agents: Array<{ id: string; provisioning: Record<string, { enabled: boolean; state: string }> }> }>()
      .agents.find((agent) => agent.id === created.agent.id);
    expect(listed?.provisioning.email).toEqual({ enabled: false, state: "not_provisioned" });
    expect(listed?.provisioning.phone).toEqual({ enabled: false, state: "not_provisioned" });
  });

  it("returns detail with redacted tokens and provisioning", async () => {
    const created = await createAgent({ name: "Detail" });
    const response = await getAgentDetail(created.agent.id);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]).toMatchObject({ name: "default", status: "active", prefix: created.identityToken.prefix });
    expect(body.tokens[0]).not.toHaveProperty("secret");
    expect(body.tokens[0]).not.toHaveProperty("tokenHash");
    expect(body.provisioning.email.state).toBe("not_provisioned");
  });

  it("updates name, approval mode, and pause status", async () => {
    const created = await createAgent({ name: "Patchable" });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${created.agent.id}`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Patched", approvalMode: "autonomous", status: "paused" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().agent).toMatchObject({ name: "Patched", approvalMode: "autonomous", status: "paused", slug: created.agent.slug });
  });
});

describe("token management", () => {
  it("caps active tokens at 5 and rejects the 6th with 409", async () => {
    const created = await createAgent({ name: "Tokens" });
    for (let index = 0; index < 4; index++) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/agents/${created.agent.id}/tokens`,
        cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie },
        payload: { name: `token-${index}` }
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().secret).toMatch(/^brk_test_/);
    }

    const sixth = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${created.agent.id}/tokens`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie },
      payload: {}
    });
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json().error.code).toBe("validation_failed");
  });

  it("revokes a token so agent calls 401 afterwards", async () => {
    const created = await createAgent({ name: "Revocable" });
    const bearer = { authorization: `Bearer ${created.identityToken.secret}` };

    const before = await app.inject({
      method: "GET",
      url: `/api/identity/${created.agent.id}/audit-log`,
      headers: bearer
    });
    expect(before.statusCode).toBe(200);

    const detail = await getAgentDetail(created.agent.id);
    const tokenId = detail.json().tokens[0].id as string;
    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/v1/agents/${created.agent.id}/tokens/${tokenId}`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
    });
    expect(revoke.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: `/api/identity/${created.agent.id}/audit-log`,
      headers: bearer
    });
    expect(after.statusCode).toBe(401);
  });
});

describe("capability toggles", () => {
  it("enables and disables capabilities asynchronously with 202", async () => {
    const created = await createAgent({ name: "Capable" });

    const enable = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${created.agent.id}/capabilities/email/enable`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
    });
    expect(enable.statusCode).toBe(202);
    expect(enable.json()).toMatchObject({ provisioning: { state: "pending" } });
    await waitForCapability(created.agent.id, "email", true);

    const disable = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${created.agent.id}/capabilities/email/disable`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
    });
    expect(disable.statusCode).toBe(202);
    await waitForCapability(created.agent.id, "email", false);
  });

  it("rejects the card capability as coming soon and unknown capabilities", async () => {
    const created = await createAgent({ name: "Cardless" });
    const card = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${created.agent.id}/capabilities/card/enable`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
    });
    expect(card.statusCode).toBe(400);
    expect(card.json().error.message).toMatch(/coming soon/i);

    const unknown = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${created.agent.id}/capabilities/fax/enable`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
    });
    expect(unknown.statusCode).toBe(400);
  });
});

describe("plan entitlements", () => {
  it("returns 402 plan_limit when a free account creates a second agent", async () => {
    const cookie = await signup("free-second-agent@example.com");
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      cookies: { [config.SESSION_COOKIE_NAME]: cookie },
      payload: { name: "Free One" }
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      cookies: { [config.SESSION_COOKIE_NAME]: cookie },
      payload: { name: "Free Two" }
    });
    expect(second.statusCode).toBe(402);
    expect(second.json()).toMatchObject({
      error: {
        code: "plan_limit",
        details: { upgradeHint: "Upgrade to Pro for 3 agents." }
      }
    });
  });

  it("returns 402 plan_limit when a free account enables phone", async () => {
    const cookie = await signup("free-phone@example.com");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      cookies: { [config.SESSION_COOKIE_NAME]: cookie },
      payload: { name: "Free Phone" }
    });
    expect(created.statusCode).toBe(201);

    const enable = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${created.json().agent.id}/capabilities/phone/enable`,
      cookies: { [config.SESSION_COOKIE_NAME]: cookie }
    });
    expect(enable.statusCode).toBe(402);
    expect(enable.json()).toMatchObject({
      error: {
        code: "plan_limit",
        details: { upgradeHint: "Upgrade to Pro for phone access." }
      }
    });
  });

  it("returns 402 plan_limit when a pro account creates a fourth agent", async () => {
    const email = "pro-fourth-agent@example.com";
    const cookie = await signup(email);
    await setBillingPlan(email, "pro");
    for (const name of ["Pro One", "Pro Two", "Pro Three"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents",
        cookies: { [config.SESSION_COOKIE_NAME]: cookie },
        payload: { name }
      });
      expect(response.statusCode).toBe(201);
    }

    const fourth = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      cookies: { [config.SESSION_COOKIE_NAME]: cookie },
      payload: { name: "Pro Four" }
    });
    expect(fourth.statusCode).toBe(402);
    expect(fourth.json()).toMatchObject({
      error: {
        code: "plan_limit",
        details: { upgradeHint: "Upgrade to Scale for 10 agents." }
      }
    });
  });
});

describe("ownership", () => {
  it("returns 404 for another user's agent on every route", async () => {
    const created = await createAgent({ name: "Private" });
    const routes = [
      { method: "GET" as const, url: `/api/v1/agents/${created.agent.id}` },
      { method: "PATCH" as const, url: `/api/v1/agents/${created.agent.id}`, payload: { name: "Nope" } },
      { method: "DELETE" as const, url: `/api/v1/agents/${created.agent.id}` },
      { method: "POST" as const, url: `/api/v1/agents/${created.agent.id}/tokens`, payload: {} },
      { method: "POST" as const, url: `/api/v1/agents/${created.agent.id}/capabilities/email/enable` }
    ];
    for (const route of routes) {
      const response = await app.inject({
        ...route,
        cookies: { [config.SESSION_COOKIE_NAME]: otherCookie }
      });
      expect(response.statusCode).toBe(404);
    }
  });
});

describe("DELETE /api/v1/agents/:agentId", () => {
  it("soft deletes: revokes tokens, 401s agent calls, and runs deprovision hooks", async () => {
    const originalProvisioner = getProvisioner("email");
    const deprovisionedAgentIds: string[] = [];
    registerProvisioner("email", {
      ...originalProvisioner,
      deprovision: async (agent) => {
        deprovisionedAgentIds.push(agent._id.toHexString());
        await originalProvisioner.deprovision(agent);
      }
    });

    try {
      const created = await createAgent({ name: "Doomed", capabilities: { email: true } });
      const bearer = { authorization: `Bearer ${created.identityToken.secret}` };

      const remove = await app.inject({
        method: "DELETE",
        url: `/api/v1/agents/${created.agent.id}`,
        cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
      });
      expect(remove.statusCode).toBe(200);
      expect(remove.json()).toEqual({ ok: true });

      expect(deprovisionedAgentIds).toContain(created.agent.id);

      const agentCall = await app.inject({
        method: "GET",
        url: `/api/identity/${created.agent.id}/audit-log`,
        headers: bearer
      });
      expect(agentCall.statusCode).toBe(401);

      const detail = await getAgentDetail(created.agent.id);
      expect(detail.json().agent.status).toBe("revoked");
      expect(detail.json().tokens.every((token: { status: string }) => token.status === "revoked")).toBe(true);

      const list = await app.inject({
        method: "GET",
        url: "/api/v1/agents",
        cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
      });
      expect(list.json().agents.some((agent: { id: string }) => agent.id === created.agent.id)).toBe(false);
    } finally {
      registerProvisioner("email", originalProvisioner);
    }
  });
});

describe("legacy /api/sites adapter", () => {
  it("keeps the legacy client contract working end to end", async () => {
    const cookies = { [config.SESSION_COOKIE_NAME]: ownerCookie };

    const setup = await app.inject({
      method: "POST",
      url: "/api/site-setups",
      cookies,
      payload: { name: "Ava", domain: "https://openclaw.example.com/runtime" }
    });
    expect(setup.statusCode).toBe(201);
    expect(setup.headers.deprecation).toBe("true");
    const setupBody = setup.json();
    expect(setupBody.setup).toMatchObject({ name: "Ava", domain: "openclaw.example.com" });
    expect(setupBody.setup.projectId).toMatch(/^proj_/);
    expect(setupBody.apiKey).toMatchObject({ name: "Ava link token", lastUsedAt: null });
    expect(typeof setupBody.apiKey.prefix).toBe("string");
    expect(setupBody.secret).toMatch(/^brk_test_/);

    const setupState = await app.inject({
      method: "GET",
      url: `/api/site-setups/${setupBody.setup.projectId}`,
      cookies
    });
    expect(setupState.statusCode).toBe(200);
    expect(setupState.json().apiKeys).toHaveLength(1);

    const complete = await app.inject({
      method: "POST",
      url: `/api/site-setups/${setupBody.setup.projectId}/complete`,
      cookies
    });
    expect(complete.statusCode).toBe(200);
    const completed = complete.json();
    expect(completed.site).toMatchObject({ name: "Ava", domain: "openclaw.example.com" });
    expect(typeof completed.site.publicSiteKey).toBe("string");
    const siteId = completed.site.id as string;

    // The legacy "site" is the agent itself, visible on the v1 API.
    const v1Detail = await getAgentDetail(siteId);
    expect(v1Detail.statusCode).toBe(200);
    expect(v1Detail.json().agent.status).toBe("active");

    const list = await app.inject({ method: "GET", url: "/api/sites", cookies });
    expect(list.headers.deprecation).toBe("true");
    expect(list.json().sites.some((site: { id: string }) => site.id === siteId)).toBe(true);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/sites/${siteId}`,
      cookies,
      payload: { name: "Ava Prime", domain: "https://new.example.com/x" }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().site).toMatchObject({ name: "Ava Prime", domain: "new.example.com" });

    const newKey = await app.inject({
      method: "POST",
      url: `/api/sites/${siteId}/api-keys`,
      cookies,
      payload: { name: "CLI key" }
    });
    expect(newKey.statusCode).toBe(201);
    expect(newKey.json().secret).toMatch(/^brk_test_/);
    expect(newKey.json().apiKey).toMatchObject({ name: "CLI key", lastUsedAt: null });

    const removedKey = await app.inject({
      method: "DELETE",
      url: `/api/sites/${siteId}/api-keys/${newKey.json().apiKey.id}`,
      cookies
    });
    expect(removedKey.statusCode).toBe(200);
    expect(removedKey.json()).toEqual({ ok: true });

    const detail = await app.inject({ method: "GET", url: `/api/sites/${siteId}`, cookies });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().apiKeys).toHaveLength(1);

    const removed = await app.inject({ method: "DELETE", url: `/api/sites/${siteId}`, cookies });
    expect(removed.statusCode).toBe(200);
    const listAfterDelete = await app.inject({ method: "GET", url: "/api/sites", cookies });
    expect(listAfterDelete.json().sites.some((site: { id: string }) => site.id === siteId)).toBe(false);
  });

  it("still guards direct site creation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/sites",
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie },
      payload: { name: "Nope", domain: "nope.example" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.headers.deprecation).toBe("true");
  });
});
