import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { buildApp } from "./app.js";
import { connectDatabase, type Database } from "./db.js";
import {
  allocateEmailLocalPartCandidates,
  getAgentEmailProvisioningStatus,
  pauseAgentEmailAccount,
  provisionAgentEmailAccount
} from "./email-provisioning.js";

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

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);
  ownerCookie = await signup("email-owner@example.com");
  otherCookie = await signup("email-other@example.com");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("email provisioning", () => {
  it("allocates safe local parts for reserved, long, and unicode names", () => {
    expect(allocateEmailLocalPartCandidates("Support").slice(0, 2)).toEqual(["agent-support", "agent-support-2"]);
    expect(allocateEmailLocalPartCandidates("😀😀").slice(0, 1)).toEqual(["agent"]);
    expect(allocateEmailLocalPartCandidates("Very Long Agent Name With Many Words")[0]).toHaveLength(30);
  });

  it("creates persistent unique email accounts and retries collisions globally", async () => {
    const first = await createAgent("Maya", ownerCookie);
    const second = await createAgent("Maya", otherCookie);

    expect(first.agent.emailAddress).toBe("maya@agents.barkan.dev");
    expect(second.agent.emailAddress).toBe("maya-2@agents.barkan.dev");

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${first.agent.id}`,
      cookies: { [config.SESSION_COOKIE_NAME]: ownerCookie }
    });
    expect(detail.json().provisioning.email).toMatchObject({
      enabled: true,
      state: "active",
      detail: "maya@agents.barkan.dev"
    });

    const restartedDatabase = await connectDatabase(config);
    const persisted = await restartedDatabase.collections.emailAccounts.findOne({ address: "maya@agents.barkan.dev" });
    await restartedDatabase.client.close();
    expect(persisted?.agentId.toHexString()).toBe(first.agent.id);
  });

  it("is idempotent and pauses instead of reusing addresses", async () => {
    const created = await createAgent("Pause Me", ownerCookie);
    const agent = await database.collections.agents.findOne({ _id: new ObjectId(created.agent.id) });
    expect(agent).not.toBeNull();

    const first = await provisionAgentEmailAccount(database.collections, config, agent!);
    const second = await provisionAgentEmailAccount(database.collections, config, agent!);
    expect(second._id.toHexString()).toBe(first._id.toHexString());

    await pauseAgentEmailAccount(database.collections, agent!);
    expect(await getAgentEmailProvisioningStatus(database.collections, agent!)).toMatchObject({
      state: "paused",
      detail: created.agent.emailAddress
    });
  });

  it("identity init provisions email through the same registry", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/identity/init",
      payload: {
        agent_name: "Init Mail",
        owner_email: "email-owner@example.com",
        tools: ["email"],
        permissions: { requires_human_approval: false }
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().email).toBe("init-mail@agents.barkan.dev");
  });

  it("fails live provisioning when the Resend domain is not verified", async () => {
    const created = await createAgent("Live Domain", ownerCookie, { email: false });
    const agent = await database.collections.agents.findOne({ _id: new ObjectId(created.agent.id) });
    expect(agent).not.toBeNull();

    const liveConfig = { ...config, PROVIDER_MODE_EMAIL: "live" } as AppConfig;
    const domainsClient = {
      domains: {
        create: async () => ({ data: null, error: null }),
        list: async () => ({ data: { data: [{ id: "domain_1", name: config.EMAIL_AGENT_DOMAIN, status: "pending" }] }, error: null }),
        get: async () => ({
          data: {
            id: "domain_1",
            name: config.EMAIL_AGENT_DOMAIN,
            status: "pending",
            records: [
              {
                record: "SPF",
                type: "TXT",
                name: "agents",
                value: "v=spf1 include:amazonses.com ~all",
                status: "pending"
              }
            ]
          },
          error: null
        }),
        verify: async () => ({ data: null, error: null })
      }
    };

    await expect(provisionAgentEmailAccount(database.collections, liveConfig, agent!, domainsClient)).rejects.toMatchObject({
      statusCode: 502,
      code: "provider_error",
      details: {
        records: [
          expect.objectContaining({ type: "TXT", status: "pending" })
        ]
      }
    });
  });
});

async function signup(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email, password: "password12345" }
  });
  expect(response.statusCode).toBe(200);
  return response.cookies.find((candidate) => candidate.name === config.SESSION_COOKIE_NAME)!.value;
}

async function createAgent(name: string, cookie: string, capabilities = { email: true }) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agents",
    cookies: { [config.SESSION_COOKIE_NAME]: cookie },
    payload: { name, capabilities }
  });
  expect(response.statusCode).toBe(201);
  return response.json<{
    agent: { id: string; emailAddress: string };
    identityToken: { secret: string };
  }>();
}
