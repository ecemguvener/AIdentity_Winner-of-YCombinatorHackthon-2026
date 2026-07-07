import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import JSZip from "jszip";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createAccountExport, runAccountDeletionJob } from "./account.js";
import type { AppConfig } from "./config.js";
import { connectDatabase, type AgentDocument, type Database, type UserDocument } from "./db.js";
import { hashPassword } from "./security.js";

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
  ACCOUNT_EXPORT_DIR: "set-by-beforeAll",
  RETENTION_TOMBSTONE_DAYS: 30,
  API_RATE_LIMIT_MAX: 1000
} as unknown as AppConfig;

let mongoServer: MongoMemoryServer;
let database: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
let exportDir: string;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  exportDir = await fs.mkdtemp(path.join(os.tmpdir(), "barkan-export-test-"));
  (config as { MONGODB_URI: string; ACCOUNT_EXPORT_DIR: string }).MONGODB_URI = mongoServer.getUri();
  (config as { ACCOUNT_EXPORT_DIR: string }).ACCOUNT_EXPORT_DIR = exportDir;
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);
}, 60_000);

beforeEach(async () => {
  await Promise.all(Object.values(database.collections).map((collection) => collection.deleteMany({})));
});

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
  await fs.rm(exportDir, { recursive: true, force: true });
});

describe("account export", () => {
  it("builds scoped zip files with a manifest and no foreign rows", async () => {
    const owner = await insertUser("owner@example.com");
    const foreign = await insertUser("foreign@example.com");
    const agent = await insertAgent(owner._id, "Owner Agent");
    await insertAgent(foreign._id, "Foreign Agent");
    await database.collections.emailMessages.insertOne({
      _id: new ObjectId(),
      agentId: agent._id,
      threadId: new ObjectId(),
      direction: "inbound",
      fromEmail: "casey@example.com",
      toEmail: "owner-agent@agents.barkan.dev",
      subject: "Hi",
      textBody: "hello",
      status: "received",
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const result = await createAccountExport(database.collections, config, owner);
    const row = await database.collections.accountExports.findOne({ _id: new ObjectId(result.exportId) });
    const zip = await JSZip.loadAsync(await fs.readFile(row!.downloadPath!));
    const manifest = JSON.parse(await zip.file("export-manifest.json")!.async("string"));
    const agents = JSON.parse(await zip.file("agents.json")!.async("string"));

    expect(manifest.counts["agents.json"]).toBe(1);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("Owner Agent");
  });

  it("returns a signed one-time download URL from the owner route", async () => {
    const cookie = await signup("export-route@example.com");
    const user = await database.collections.users.findOne({ email: "export-route@example.com" });
    await insertAgent(user!._id, "Route Export Agent");

    const requested = await app.inject({
      method: "POST",
      url: "/api/v1/account/export",
      cookies: { [config.SESSION_COOKIE_NAME]: cookie }
    });
    expect(requested.statusCode).toBe(202);
    const downloadUrl = requested.json().download_url as string;

    const downloaded = await app.inject({ method: "GET", url: downloadUrl });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers["content-type"]).toContain("application/zip");

    const second = await app.inject({ method: "GET", url: downloadUrl });
    expect(second.statusCode).toBe(404);
  });
});

describe("account deletion", () => {
  it("hard-deletes owner scoped rows, tombstones the user, blocks login, and holds email for 30 days", async () => {
    const cookie = await signup("delete-me@example.com");
    const user = await database.collections.users.findOne({ email: "delete-me@example.com" });
    const agent = await insertAgent(user!._id, "Delete Agent");
    await database.collections.identityTokens.insertOne({
      _id: new ObjectId(),
      agentId: agent._id,
      ownerUserId: user!._id,
      tokenHash: "hash",
      prefix: "brk_test",
      name: "default",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date()
    });
    await database.collections.billingAccounts.updateOne(
      { ownerUserId: user!._id },
      { $set: { stripeCustomerId: "cus_delete", plan: "free", updatedAt: new Date() }, $setOnInsert: { _id: new ObjectId(), createdAt: new Date() } },
      { upsert: true }
    );

    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/account",
      cookies: { [config.SESSION_COOKIE_NAME]: cookie },
      payload: { password: "password12345", confirm: "DELETE" }
    });

    expect(response.statusCode).toBe(202);
    expect(await database.collections.agents.countDocuments({ ownerUserId: user!._id })).toBe(0);
    expect(await database.collections.identityTokens.countDocuments({ agentId: agent._id })).toBe(0);
    expect(await database.collections.billingAccounts.countDocuments({ ownerUserId: user!._id })).toBe(0);
    const tombstone = await database.collections.users.findOne({ _id: user!._id });
    expect(tombstone).toMatchObject({ email: `deleted:${user!._id.toHexString()}` });
    expect(tombstone?.emailHash).toBeTruthy();

    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "delete-me@example.com", password: "password12345" } });
    expect(login.statusCode).toBe(401);
    const blockedSignup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { email: "delete-me@example.com", password: "password12345" } });
    expect(blockedSignup.statusCode).toBe(409);

    await database.collections.users.updateOne({ _id: user!._id }, { $set: { deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) } });
    const allowedSignup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { email: "delete-me@example.com", password: "password12345" } });
    expect(allowedSignup.statusCode).toBe(200);
  });

  it("resumes from checkpoint after a crash", async () => {
    const user = await insertUser("resume@example.com");
    await insertAgent(user._id, "Resume Agent");

    await expect(runAccountDeletionJob(database.collections, config, user, { failAfterStep: 2 })).rejects.toThrow("simulated deletion crash");
    expect(await database.collections.opsStatus.findOne({ key: `accountDeletion:${user._id.toHexString()}` })).toMatchObject({ status: "pending" });

    await runAccountDeletionJob(database.collections, config, user);
    expect(await database.collections.agents.countDocuments({ ownerUserId: user._id })).toBe(0);
    expect(await database.collections.opsStatus.findOne({ key: `accountDeletion:${user._id.toHexString()}` })).toMatchObject({ status: "ok" });
  });
});

async function signup(email: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { email, password: "password12345" } });
  expect(response.statusCode).toBe(200);
  return response.cookies.find((cookie) => cookie.name === config.SESSION_COOKIE_NAME)!.value;
}

async function insertUser(email: string): Promise<UserDocument> {
  const now = new Date();
  const user: UserDocument = {
    _id: new ObjectId(),
    email,
    passwordHash: await hashPassword("password12345"),
    createdAt: now,
    updatedAt: now
  };
  await database.collections.users.insertOne(user);
  return user;
}

async function insertAgent(ownerUserId: ObjectId, name: string): Promise<AgentDocument> {
  const now = new Date();
  const agent: AgentDocument = {
    _id: new ObjectId(),
    ownerUserId,
    name,
    slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${ownerUserId.toHexString()}`,
    status: "active",
    capabilities: { email: false, phone: false },
    approvalMode: "always",
    createdAt: now,
    updatedAt: now
  };
  await database.collections.agents.insertOne(agent);
  return agent;
}
