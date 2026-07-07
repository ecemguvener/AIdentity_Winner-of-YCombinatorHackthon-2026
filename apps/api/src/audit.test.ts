import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.js";
import { buildAuditFilter, listAuditEntries, recordAudit, recordAuditForAgentHexId } from "./audit.js";
import { connectDatabase, type AgentDocument, type Database } from "./db.js";

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

describe("recordAudit", () => {
  it("inserts the canonical audit shape", async () => {
    const agentId = new ObjectId();
    const ownerUserId = new ObjectId();

    const insertedId = await recordAudit(database.collections, {
      agentId,
      ownerUserId,
      actor: "agent",
      action: "email.send",
      status: "allowed",
      detail: "Email sent.",
      resourceType: "email_message",
      resourceId: "msg_123",
      metadata: { recipient: "sam@example.test" }
    });

    expect(insertedId).toBeTruthy();
    const document = await database.collections.auditLogs.findOne({ _id: new ObjectId(insertedId ?? "") });
    expect(document).toMatchObject({
      agentId,
      ownerUserId,
      actor: "agent",
      action: "email.send",
      status: "allowed",
      detail: "Email sent.",
      resourceType: "email_message",
      resourceId: "msg_123",
      metadata: { recipient: "sam@example.test" }
    });
    expect(document?.createdAt).toBeInstanceOf(Date);
  });

  it("logs and swallows storage errors", async () => {
    const errorMock = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const insertedId = await recordAudit({
      auditLogs: {
        insertOne: vi.fn().mockRejectedValue(new Error("disk sad"))
      }
    } as never, {
      agentId: new ObjectId(),
      actor: "system",
      action: "identity.init",
      status: "allowed",
      detail: "Init."
    });

    expect(insertedId).toBeNull();
    expect(errorMock).toHaveBeenCalledWith("audit insert failed", expect.any(Error));
    errorMock.mockRestore();
  });
});

describe("audit queries", () => {
  it("builds owner-scoped filters with action prefixes and cursor pagination", () => {
    const ownerUserId = new ObjectId();
    const agentId = new ObjectId();
    const cursor = new ObjectId();
    const from = new Date("2026-07-01T00:00:00.000Z");
    const to = new Date("2026-07-02T00:00:00.000Z");

    expect(buildAuditFilter({ ownerUserId, agentId, action: "email.", status: "allowed", from, to, cursor })).toEqual({
      ownerUserId,
      agentId,
      action: { $regex: "^email\\." },
      status: "allowed",
      createdAt: { $gte: from, $lte: to },
      _id: { $lt: cursor }
    });
  });

  it("paginates by descending _id and returns a stable next cursor", async () => {
    const agentId = new ObjectId();
    const ownerUserId = new ObjectId();
    for (let index = 0; index < 3; index += 1) {
      await recordAudit(database.collections, {
        agentId,
        ownerUserId,
        actor: "agent",
        action: "email.send",
        status: "allowed",
        detail: `row ${index}`
      });
    }

    const firstPage = await listAuditEntries(database.collections, { ownerUserId, limit: 2 });
    expect(firstPage.entries).toHaveLength(2);
    expect(firstPage.nextCursor).toBe(firstPage.entries[1]._id.toHexString());

    await recordAudit(database.collections, {
      agentId,
      ownerUserId,
      actor: "agent",
      action: "email.send",
      status: "allowed",
      detail: "concurrent newer row"
    });

    const secondPage = await listAuditEntries(database.collections, {
      ownerUserId,
      cursor: firstPage.nextCursor ?? undefined,
      limit: 2
    });

    expect(secondPage.entries.map((entry) => entry._id.toHexString())).not.toContain(firstPage.entries[0]._id.toHexString());
    expect(secondPage.entries.map((entry) => entry.detail)).toContain("row 0");
  });

  it("records for a hex agent id by resolving owner scope", async () => {
    const ownerUserId = new ObjectId();
    const agent: AgentDocument = {
      _id: new ObjectId(),
      ownerUserId,
      name: "Audit Agent",
      slug: `audit-agent-${new ObjectId().toHexString()}`,
      status: "active",
      capabilities: { email: true, phone: true },
      approvalMode: "always",
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await database.collections.agents.insertOne(agent);

    const insertedId = await recordAuditForAgentHexId(database.collections, agent._id.toHexString(), {
      actor: "agent",
      action: "email.send",
      status: "allowed",
      detail: "sent"
    });

    const row = await database.collections.auditLogs.findOne({ _id: new ObjectId(insertedId ?? "") });
    expect(row?.ownerUserId?.equals(ownerUserId)).toBe(true);
  });
});
