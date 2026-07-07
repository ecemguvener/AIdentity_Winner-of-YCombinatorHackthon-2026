import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { connectDatabase, type AgentDocument, type Database, type PhoneNumberDocument } from "./db.js";
import {
  activateNumberRow,
  attachPurchasedNumber,
  findActiveByAgent,
  findByE164,
  purchaseReservedNumber,
  releasePersistedNumber,
  reserveNumberRow,
  type PhoneNumberLifecycleProvider
} from "./phone-numbers.js";
import { buildTwilioAuditRows } from "./scripts/twilio-audit.js";
import { MockTwilioNumbers } from "./providers/twilio-numbers.js";
import { ApiError } from "./errors.js";

const config = {
  MONGODB_URI: "set-by-beforeAll",
  PROVIDER_MODE_PHONE: "mock",
  PUBLIC_API_URL: "https://identity.space"
} as unknown as AppConfig;

let mongoServer: MongoMemoryServer;
let database: Database;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
}, 60_000);

beforeEach(async () => {
  await Promise.all([
    database.collections.agents.deleteMany({}),
    database.collections.phoneNumbers.deleteMany({}),
    database.collections.auditLogs.deleteMany({})
  ]);
});

afterAll(async () => {
  await database?.client.close();
  await mongoServer?.stop();
});

describe("phone number persistence", () => {
  it("runs the mock lifecycle with persisted row states and audit entries", async () => {
    const agent = await insertAgent();
    const provider = new MockTwilioNumbers();

    const purchased = await purchaseReservedNumber(database.collections, config, provider, {
      agent,
      e164: "+15005550001",
      country: "US"
    });
    expect(purchased).toMatchObject({
      e164: "+15005550001",
      twilioSid: "PNmock00000001",
      capabilitiesVoice: true,
      capabilitiesSms: true,
      status: "provisioning",
      monthlyPriceCents: 115
    });

    const active = await activateNumberRow(database.collections, purchased._id, { elevenLabsPhoneNumberId: "el-phone-1" });
    expect(active).toMatchObject({ status: "active", elevenLabsPhoneNumberId: "el-phone-1" });
    expect(await findActiveByAgent(database.collections, agent._id)).toMatchObject({ e164: "+15005550001" });

    const released = await releasePersistedNumber(database.collections, config, active, provider);
    expect(released).toMatchObject({ status: "released" });
    expect(await provider.listPurchasedNumbers()).toHaveLength(0);

    const actions = (await database.collections.auditLogs.find({ agentId: agent._id }).sort({ createdAt: 1 }).toArray()).map((row) => row.action);
    expect(actions).toEqual([
      "phone.number.reserve",
      "phone.number.purchased",
      "phone.number.active",
      "phone.number.released"
    ]);
  });

  it("reserve/attach helpers expose provisioning state before activation", async () => {
    const agent = await insertAgent();
    const reserved = await reserveNumberRow(database.collections, { agent, e164: "+15005550002", country: "us" });
    expect(reserved).toMatchObject({ status: "provisioning", country: "US", capabilitiesVoice: false });

    const attached = await attachPurchasedNumber(database.collections, reserved._id, {
      twilioSid: "PNmanual",
      e164: "+15005550002",
      capabilities: { voice: true, sms: true },
      monthlyPriceCents: 115
    });
    expect(attached).toMatchObject({ twilioSid: "PNmanual", status: "provisioning", capabilitiesSms: true });
    expect(await findByE164(database.collections, "+15005550002")).toMatchObject({ twilioSid: "PNmanual" });
  });

  it("guards against double provision for one agent", async () => {
    const agent = await insertAgent();
    await reserveNumberRow(database.collections, { agent, e164: "+15005550003", country: "US" });

    await expect(
      reserveNumberRow(database.collections, { agent, e164: "+15005550004", country: "US" })
    ).rejects.toMatchObject({ statusCode: 409, code: "validation_failed" });
  });

  it("marks reservations released and audits purchase failures", async () => {
    const agent = await insertAgent();
    const provider: PhoneNumberLifecycleProvider = {
      purchaseNumber: async () => {
        throw new ApiError(502, "provider_error", "Twilio purchase failed");
      },
      releaseNumber: () => {}
    };

    await expect(
      purchaseReservedNumber(database.collections, config, provider, { agent, e164: "+15005550005", country: "US" })
    ).rejects.toThrow(/Twilio purchase failed/);

    const row = await findByE164(database.collections, "+15005550005");
    expect(row).toMatchObject({ status: "released", releaseDetail: "Twilio purchase failed" });
    const audit = await database.collections.auditLogs.findOne({ action: "phone.number.purchase_failed" });
    expect(audit).toMatchObject({ status: "error", detail: "Twilio purchase failed" });
  });

  it("orphan audit reports Twilio and database mismatches", () => {
    const databaseRows = [
      phoneRow({ e164: "+15005550006", twilioSid: "PNok", status: "active" }),
      phoneRow({ e164: "+15005550007", twilioSid: "PNmissing", status: "active" })
    ];
    const rows = buildTwilioAuditRows(
      [
        { e164: "+15005550006", twilioSid: "PNok", friendlyName: "ok" },
        { e164: "+15005550008", twilioSid: "PNorphan", friendlyName: "orphan" }
      ],
      databaseRows
    );

    expect(rows.map((row) => row.type)).toEqual(["database_orphan", "ok", "twilio_orphan"]);
    expect(rows.find((row) => row.type === "database_orphan")).toMatchObject({ e164: "+15005550007", twilioSid: "PNmissing" });
    expect(rows.find((row) => row.type === "twilio_orphan")).toMatchObject({ e164: "+15005550008", twilioSid: "PNorphan" });
  });
});

async function insertAgent(): Promise<AgentDocument> {
  const now = new Date();
  const agent: AgentDocument = {
    _id: new ObjectId(),
    ownerUserId: new ObjectId(),
    name: "Phone Agent",
    slug: `phone-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    status: "active",
    capabilities: { email: false, phone: true },
    approvalMode: "policy",
    createdAt: now,
    updatedAt: now
  };
  await database.collections.agents.insertOne(agent);
  return agent;
}

function phoneRow(input: { e164: string; twilioSid: string; status: PhoneNumberDocument["status"] }): PhoneNumberDocument {
  const now = new Date();
  return {
    _id: new ObjectId(),
    agentId: new ObjectId(),
    e164: input.e164,
    country: "US",
    twilioSid: input.twilioSid,
    capabilitiesVoice: true,
    capabilitiesSms: true,
    status: input.status,
    createdAt: now,
    updatedAt: now
  };
}
