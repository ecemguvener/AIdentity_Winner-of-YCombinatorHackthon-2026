import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { connectDatabase, type AgentDocument, type Database } from "./db.js";
import { sendAgentEmail } from "./email-service.js";
import { MockEmailProvider } from "./providers/email-provider.js";

const config = {
  PROVIDER_MODE_EMAIL: "mock",
  EMAIL_AGENT_DOMAIN: "agents.barkan.dev"
} as AppConfig;

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

describe("sendAgentEmail", () => {
  it("creates then reuses a persistent counterparty thread", async () => {
    const agent = await createAgent("Thread Bot", "thread-bot@agents.barkan.dev");
    const provider = new MockEmailProvider();

    const first = await sendAgentEmail(database.collections, config, provider, {
      agent,
      to: "Person@Example.com",
      subject: "First",
      text: "Hello"
    });
    const second = await sendAgentEmail(database.collections, config, provider, {
      agent,
      to: "person@example.com",
      subject: "Second",
      text: "Again"
    });

    expect(second.thread._id.toHexString()).toBe(first.thread._id.toHexString());
    expect(provider.sent).toHaveLength(2);
    expect(await database.collections.emailThreads.countDocuments({ agentId: agent._id })).toBe(1);
  });

  it("rejects explicit thread ids owned by another agent", async () => {
    const agent = await createAgent("Owner Bot", "owner-bot@agents.barkan.dev");
    const other = await createAgent("Other Bot", "other-bot@agents.barkan.dev");
    const otherThread = await sendAgentEmail(database.collections, config, new MockEmailProvider(), {
      agent: other,
      to: "person@example.com",
      subject: "Other",
      text: "Other"
    });
    const provider = new MockEmailProvider();

    await expect(sendAgentEmail(database.collections, config, provider, {
      agent,
      to: "person@example.com",
      subject: "Nope",
      text: "Nope",
      threadId: otherThread.thread._id.toHexString()
    })).rejects.toMatchObject({ statusCode: 404, code: "not_found" });
    expect(provider.sent).toHaveLength(0);
  });

  it("dedupes idempotent replays before calling the provider", async () => {
    const agent = await createAgent("Idempotent Bot", "idempotent-bot@agents.barkan.dev");
    const provider = new MockEmailProvider();
    const input = {
      agent,
      to: "person@example.com",
      subject: "Once",
      text: "Only once",
      idempotencyKey: "idem-1"
    };

    const first = await sendAgentEmail(database.collections, config, provider, input);
    const second = await sendAgentEmail(database.collections, config, provider, input);

    expect(second.replayed).toBe(true);
    expect(second.message._id.toHexString()).toBe(first.message._id.toHexString());
    expect(provider.sent).toHaveLength(1);
    expect(await database.collections.emailMessages.countDocuments({ agentId: agent._id, idempotencyKey: "idem-1" })).toBe(1);
  });

  it("stores failed provider attempts and surfaces provider_error", async () => {
    const agent = await createAgent("Failure Bot", "failure-bot@agents.barkan.dev");
    const provider = new MockEmailProvider(new Error("provider down"));

    await expect(sendAgentEmail(database.collections, config, provider, {
      agent,
      to: "person@example.com",
      subject: "Fail",
      text: "Fail"
    })).rejects.toMatchObject({ statusCode: 502, code: "provider_error" });

    const failed = await database.collections.emailMessages.findOne({ agentId: agent._id, subject: "Fail" });
    expect(failed).toMatchObject({ status: "failed", providerError: "provider down" });
  });

  it("blocks paused accounts with policy_blocked", async () => {
    const agent = await createAgent("Paused Bot", "paused-bot@agents.barkan.dev", "paused");
    const provider = new MockEmailProvider();

    await expect(sendAgentEmail(database.collections, config, provider, {
      agent,
      to: "person@example.com",
      subject: "Blocked",
      text: "Blocked"
    })).rejects.toMatchObject({ statusCode: 403, code: "policy_blocked" });
    expect(provider.sent).toHaveLength(0);
  });
});

async function createAgent(
  name: string,
  address: string,
  emailStatus: "active" | "paused" = "active"
): Promise<AgentDocument> {
  const now = new Date();
  const agent: AgentDocument = {
    _id: new ObjectId(),
    ownerUserId: null,
    name,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    status: "active",
    runtime: "openclaw",
    capabilities: { email: true, phone: false },
    approvalMode: "autonomous",
    createdAt: now,
    updatedAt: now
  };
  await database.collections.agents.insertOne(agent);
  await database.collections.emailAccounts.insertOne({
    _id: new ObjectId(),
    agentId: agent._id,
    address,
    displayName: name,
    status: emailStatus,
    createdAt: now,
    updatedAt: now
  });
  return agent;
}
