import { ObjectId } from "mongodb";
import type { AppConfig } from "./config.js";
import type { AgentDocument, Collections, PhoneNumberDocument } from "./db.js";
import { ApiError } from "./errors.js";
import { recordAudit } from "./audit.js";
import type { PurchasedTwilioNumber } from "./providers/twilio-numbers.js";
import { purchaseNumber, releaseNumber } from "./providers/twilio-numbers.js";

export interface ReserveNumberInput {
  agent: AgentDocument;
  e164: string;
  country: string;
}

export interface PurchaseReservedNumberInput extends ReserveNumberInput {
  friendlyName?: string;
}

export interface PhoneNumberLifecycleProvider {
  purchaseNumber(input: { e164: string; friendlyName: string; agentId: string }): Promise<PurchasedTwilioNumber>;
  releaseNumber(twilioSid: string): void;
}

export async function findActiveByAgent(collections: Collections, agentId: ObjectId | string): Promise<PhoneNumberDocument | null> {
  return collections.phoneNumbers.findOne({
    agentId: toObjectId(agentId),
    status: "active"
  });
}

export async function findByE164(collections: Collections, e164: string): Promise<PhoneNumberDocument | null> {
  return collections.phoneNumbers.findOne({ e164: normalizeE164(e164) });
}

export async function reserveNumberRow(
  collections: Collections,
  input: ReserveNumberInput
): Promise<PhoneNumberDocument> {
  const existing = await collections.phoneNumbers.findOne({
    agentId: input.agent._id,
    status: { $in: ["provisioning", "active", "releasing"] }
  });
  if (existing) {
    throw new ApiError(409, "validation_failed", "agent already has a phone number");
  }

  const now = new Date();
  const row: PhoneNumberDocument = {
    _id: new ObjectId(),
    agentId: input.agent._id,
    e164: normalizeE164(input.e164),
    country: input.country.toUpperCase(),
    capabilitiesVoice: false,
    capabilitiesSms: false,
    status: "provisioning",
    provisioningDetail: "Buying number...",
    createdAt: now,
    updatedAt: now
  };
  await collections.phoneNumbers.insertOne(row);
  await recordPhoneNumberAudit(collections, input.agent, "phone.number.reserve", "pending", `Reserved ${row.e164}`, row);
  return row;
}

export async function attachPurchasedNumber(
  collections: Collections,
  rowId: ObjectId | string,
  purchased: PurchasedTwilioNumber
): Promise<PhoneNumberDocument> {
  const updated = await collections.phoneNumbers.findOneAndUpdate(
    { _id: toObjectId(rowId), status: "provisioning" },
    {
      $set: {
        twilioSid: purchased.twilioSid,
        e164: normalizeE164(purchased.e164),
        capabilitiesVoice: purchased.capabilities.voice,
        capabilitiesSms: purchased.capabilities.sms,
        monthlyPriceCents: purchased.monthlyPriceCents,
        updatedAt: new Date()
      }
    },
    { returnDocument: "after" }
  );
  if (!updated) {
    throw new ApiError(404, "not_found", "phone number reservation not found");
  }
  return updated;
}

export async function activateNumberRow(
  collections: Collections,
  rowId: ObjectId | string,
  input: { elevenLabsPhoneNumberId?: string } = {}
): Promise<PhoneNumberDocument> {
  const updated = await collections.phoneNumbers.findOneAndUpdate(
    { _id: toObjectId(rowId), status: { $ne: "released" } },
    {
      $set: {
        status: "active",
        ...(input.elevenLabsPhoneNumberId ? { elevenLabsPhoneNumberId: input.elevenLabsPhoneNumberId } : {}),
        updatedAt: new Date()
      }
    },
    { returnDocument: "after" }
  );
  if (!updated) {
    throw new ApiError(404, "not_found", "phone number not found");
  }
  const agent = await collections.agents.findOne({ _id: updated.agentId });
  if (agent) {
    await recordPhoneNumberAudit(collections, agent, "phone.number.active", "allowed", `Activated ${updated.e164}`, updated);
  }
  return updated;
}

export async function markReleased(
  collections: Collections,
  rowIdOrSid: ObjectId | string,
  detail?: string
): Promise<PhoneNumberDocument | null> {
  const objectId = typeof rowIdOrSid === "string" && ObjectId.isValid(rowIdOrSid) ? new ObjectId(rowIdOrSid) : rowIdOrSid;
  const filter = objectId instanceof ObjectId ? { _id: objectId } : { twilioSid: String(rowIdOrSid) };
  return collections.phoneNumbers.findOneAndUpdate(
    filter,
    {
      $set: {
        status: "released",
        ...(detail ? { releaseDetail: detail } : {}),
        updatedAt: new Date()
      }
    },
    { returnDocument: "after" }
  );
}

export async function purchaseReservedNumber(
  collections: Collections,
  config: AppConfig,
  provider: PhoneNumberLifecycleProvider | undefined,
  input: PurchaseReservedNumberInput
): Promise<PhoneNumberDocument> {
  const row = await reserveNumberRow(collections, input);
  try {
    const purchased = provider
      ? await provider.purchaseNumber({
          e164: row.e164,
          friendlyName: input.friendlyName ?? `barkan:${input.agent._id.toHexString()}`,
          agentId: input.agent._id.toHexString()
        })
      : await purchaseNumber(config, {
          e164: row.e164,
          friendlyName: input.friendlyName ?? `barkan:${input.agent._id.toHexString()}`,
          agentId: input.agent._id.toHexString()
        });
    const attached = await attachPurchasedNumber(collections, row._id, purchased);
    await recordPhoneNumberAudit(collections, input.agent, "phone.number.purchased", "allowed", `Purchased ${attached.e164}`, attached);
    return attached;
  } catch (error) {
    const detail = (error as Error).message;
    await markReleased(collections, row._id, detail);
    await recordPhoneNumberAudit(collections, input.agent, "phone.number.purchase_failed", "error", detail, row);
    throw error;
  }
}

export async function releasePersistedNumber(
  collections: Collections,
  config: AppConfig,
  row: PhoneNumberDocument,
  provider?: Pick<PhoneNumberLifecycleProvider, "releaseNumber">
): Promise<PhoneNumberDocument | null> {
  const now = new Date();
  await collections.phoneNumbers.updateOne({ _id: row._id }, { $set: { status: "releasing", updatedAt: now } });
  if (row.twilioSid) {
    if (provider) {
      provider.releaseNumber(row.twilioSid);
    } else {
      await releaseNumber(config, row.twilioSid);
    }
  }
  const released = await markReleased(collections, row._id);
  if (released) {
    const agent = await collections.agents.findOne({ _id: released.agentId });
    if (agent) {
      await recordPhoneNumberAudit(collections, agent, "phone.number.released", "allowed", `Released ${released.e164}`, released);
    }
  }
  return released;
}

async function recordPhoneNumberAudit(
  collections: Collections,
  agent: AgentDocument,
  action: string,
  status: "allowed" | "blocked" | "pending" | "error",
  detail: string,
  row: Pick<PhoneNumberDocument, "_id" | "e164" | "twilioSid">
): Promise<void> {
  await recordAudit(collections, {
    agentId: agent._id,
    ownerUserId: agent.ownerUserId,
    actor: "system",
    action,
    status,
    detail,
    resourceType: "phoneNumber",
    resourceId: row._id.toHexString(),
    metadata: { e164: row.e164, twilioSid: row.twilioSid ?? null }
  });
}

function normalizeE164(value: string): string {
  return value.trim();
}

function toObjectId(value: ObjectId | string): ObjectId {
  return value instanceof ObjectId ? value : new ObjectId(value);
}
