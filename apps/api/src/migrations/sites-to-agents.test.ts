import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { connectDatabase, type Database } from "../db.js";
import { hashApiKey } from "../security.js";
import { run } from "./2026-07-sites-to-agents.js";

let mongoServer: MongoMemoryServer;
let database: Database;

const ownerUserId = new ObjectId();
const siteId1 = new ObjectId();
const siteId2 = new ObjectId();
const orphanProjectId = "proj_orphan_test_1234";
const plaintextKey1 = "ck_known-plaintext-key-1";
const plaintextKey2 = "ck_known-plaintext-key-2";
const plaintextKey3 = "ck_known-plaintext-key-3";

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  database = await connectDatabase({ MONGODB_URI: mongoServer.getUri() } as AppConfig);

  const now = new Date();
  await database.collections.sites.insertMany([
    {
      _id: siteId1,
      ownerUserId,
      name: "Support Bot",
      domain: "support.example.com",
      publicSiteKey: "site_key_1",
      createdAt: now,
      updatedAt: now
    },
    {
      _id: siteId2,
      ownerUserId,
      name: "Support Bot",
      domain: "support2.example.com",
      publicSiteKey: "site_key_2",
      createdAt: now,
      updatedAt: now
    }
  ]);
  await database.collections.atlasProjects.insertMany([
    {
      _id: new ObjectId(),
      ownerUserId,
      projectId: orphanProjectId,
      name: "Orphan Setup",
      createdAt: now,
      updatedAt: now
    },
    {
      _id: new ObjectId(),
      ownerUserId,
      siteId: siteId1,
      projectId: "proj_completed_5678",
      name: "Support Bot",
      createdAt: now,
      updatedAt: now
    }
  ]);
  await database.collections.apiKeys.insertMany([
    {
      _id: new ObjectId(),
      userId: ownerUserId,
      siteId: siteId1,
      keyHash: hashApiKey(plaintextKey1),
      prefix: plaintextKey1.slice(0, 8),
      name: "key one",
      createdAt: now
    },
    {
      _id: new ObjectId(),
      userId: ownerUserId,
      siteId: siteId2,
      keyHash: hashApiKey(plaintextKey2),
      prefix: plaintextKey2.slice(0, 8),
      name: "key two",
      createdAt: now,
      lastUsedAt: now
    },
    {
      _id: new ObjectId(),
      userId: ownerUserId,
      projectId: orphanProjectId,
      keyHash: hashApiKey(plaintextKey3),
      prefix: plaintextKey3.slice(0, 8),
      name: "key three",
      createdAt: now
    }
  ]);
}, 60_000);

afterAll(async () => {
  await database?.client.close();
  await mongoServer?.stop();
});

it("dry-run reports accurate counts without writing", async () => {
  const { stats, summary } = await run({ collections: database.collections, dryRun: true });
  expect(stats).toEqual({ migratedSites: 2, migratedSetups: 1, migratedKeys: 3, skipped: 0 });
  expect(summary).toBe("migrated 2 sites, 1 setups, 3 keys, skipped 0");
  expect(await database.collections.agents.countDocuments()).toBe(0);
  expect(await database.collections.identityTokens.countDocuments()).toBe(0);
});

it("migrates sites, orphan setups, and api keys", async () => {
  const { stats } = await run({ collections: database.collections, dryRun: false });
  expect(stats).toEqual({ migratedSites: 2, migratedSetups: 1, migratedKeys: 3, skipped: 0 });

  const agents = await database.collections.agents.find({}).toArray();
  expect(agents).toHaveLength(3);

  const siteAgent1 = agents.find((agent) => agent.legacySiteId?.equals(siteId1));
  const siteAgent2 = agents.find((agent) => agent.legacySiteId?.equals(siteId2));
  const orphanAgent = agents.find((agent) => agent.legacyProjectId === orphanProjectId);
  expect(siteAgent1).toBeDefined();
  expect(siteAgent2).toBeDefined();
  expect(orphanAgent).toBeDefined();

  expect(siteAgent1?.status).toBe("active");
  expect(siteAgent1?.slug).toBe("support-bot");
  expect(siteAgent2?.slug).toBe("support-bot-2");
  expect(orphanAgent?.status).toBe("provisioning");
  expect(orphanAgent?.slug).toBe("orphan-setup");
  for (const agent of agents) {
    expect(agent.ownerUserId.equals(ownerUserId)).toBe(true);
    expect(agent.runtime).toBe("openclaw");
    expect(agent.capabilities).toEqual({ email: false, phone: false });
    expect(agent.approvalMode).toBe("always");
  }

  const tokens = await database.collections.identityTokens.find({}).toArray();
  expect(tokens).toHaveLength(3);
  const tokenForOrphan = tokens.find((token) => token.agentId.equals(orphanAgent!._id));
  expect(tokenForOrphan?.name).toBe("key three");
});

it("legacy plaintext keys authenticate through identityTokens lookup", async () => {
  for (const plaintextKey of [plaintextKey1, plaintextKey2, plaintextKey3]) {
    const token = await database.collections.identityTokens.findOne({
      tokenHash: hashApiKey(plaintextKey),
      status: "active"
    });
    expect(token).not.toBeNull();
  }
});

it("second run migrates 0 and skips everything", async () => {
  const { stats, summary } = await run({ collections: database.collections, dryRun: false });
  expect(stats.migratedSites).toBe(0);
  expect(stats.migratedSetups).toBe(0);
  expect(stats.migratedKeys).toBe(0);
  expect(stats.skipped).toBe(6);
  expect(summary).toBe("migrated 0 sites, 0 setups, 0 keys, skipped 6");
  expect(await database.collections.agents.countDocuments()).toBe(3);
  expect(await database.collections.identityTokens.countDocuments()).toBe(3);
});
