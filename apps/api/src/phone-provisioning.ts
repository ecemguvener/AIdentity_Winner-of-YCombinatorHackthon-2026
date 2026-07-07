import type { AppConfig } from "./config.js";
import type { AgentDocument, Collections, PhoneNumberDocument } from "./db.js";
import { recordAudit, AUDIT_ACTIONS } from "./audit.js";
import { registerProvisioner, type ProvisioningStatus } from "./provisioning.js";
import {
  activateNumberRow,
  attachPurchasedNumber,
  markReleased,
  releasePersistedNumber,
  reserveNumberRow,
  type PhoneNumberLifecycleProvider
} from "./phone-numbers.js";
import { searchNumbers, purchaseNumber, releaseNumber, type PurchasedTwilioNumber, type TwilioNumberCandidate } from "./providers/twilio-numbers.js";
import { assignAgentToNumber, importTwilioNumber, removeNumber } from "./providers/elevenlabs-phone.js";
import { ApiError } from "./errors.js";
import { checkEntitlement, throwPlanLimit } from "./entitlements.js";

export interface PhoneProvisioningProviders {
  searchNumbers?(input: { country: string }): Promise<TwilioNumberCandidate[]>;
  purchaseNumber?: PhoneNumberLifecycleProvider["purchaseNumber"];
  releaseNumber?: PhoneNumberLifecycleProvider["releaseNumber"];
  importTwilioNumber?(input: { e164: string; label: string }): Promise<{ phoneNumberId: string }>;
  assignAgentToNumber?(phoneNumberId: string): Promise<void>;
  removeNumber?(phoneNumberId: string): Promise<void>;
}

export function registerPhoneProvisioner(
  collections: Collections,
  config: AppConfig,
  providers: PhoneProvisioningProviders = {}
): void {
  registerProvisioner("phone", {
    provision: async (agent) => {
      await provisionAgentPhoneNumber(collections, config, agent, providers);
    },
    deprovision: (agent) => deprovisionAgentPhoneNumber(collections, config, agent, providers),
    status: (agent) => getAgentPhoneProvisioningStatus(collections, agent)
  });
}

export async function provisionAgentPhoneNumber(
  collections: Collections,
  config: AppConfig,
  agent: AgentDocument,
  providers: PhoneProvisioningProviders = {}
): Promise<PhoneNumberDocument> {
  const existing = await collections.phoneNumbers.findOne({
    agentId: agent._id,
    status: { $in: ["provisioning", "active", "releasing"] }
  });
  if (existing?.status === "active") {
    await setAgentPhoneFlag(collections, agent, true);
    return existing;
  }
  if (existing) {
    throw new ApiError(409, "validation_failed", "phone provisioning is already in progress");
  }
  if (agent.ownerUserId) {
    throwPlanLimit(await checkEntitlement(collections, agent.ownerUserId, { type: "number.provision" }));
  }

  let row: PhoneNumberDocument | null = null;
  let purchased: PurchasedTwilioNumber | null = null;
  let elevenLabsPhoneNumberId: string | null = null;
  try {
    const candidates = providers.searchNumbers
      ? await providers.searchNumbers({ country: config.TWILIO_NUMBER_COUNTRY || "US" })
      : await searchNumbers(config, { country: config.TWILIO_NUMBER_COUNTRY || "US" });
    const candidate = candidates.find((item) => item.voiceEnabled && item.smsEnabled);
    if (!candidate) {
      throw new ApiError(502, "provider_error", "no Twilio voice+SMS numbers are available");
    }

    row = await reserveNumberRow(collections, { agent, e164: candidate.e164, country: candidate.country });
    await setPhoneProvisioningDetail(collections, row._id, "Buying number...");
    purchased = providers.purchaseNumber
      ? await providers.purchaseNumber({ e164: candidate.e164, friendlyName: `barkan:${agent._id.toHexString()}`, agentId: agent._id.toHexString() })
      : await purchaseNumber(config, { e164: candidate.e164, friendlyName: `barkan:${agent._id.toHexString()}`, agentId: agent._id.toHexString() });
    row = await attachPurchasedNumber(collections, row._id, purchased);
    await recordAudit(collections, {
      agentId: agent._id,
      ownerUserId: agent.ownerUserId,
      actor: "system",
      action: "phone.number.purchased",
      status: "allowed",
      detail: `Purchased ${row.e164}`,
      resourceType: "phoneNumber",
      resourceId: row._id.toHexString(),
      metadata: { e164: row.e164, twilioSid: row.twilioSid ?? null }
    });

    await setPhoneProvisioningDetail(collections, row._id, "Linking voice agent...");
    const imported = providers.importTwilioNumber
      ? await providers.importTwilioNumber({ e164: row.e164, label: `${agent.name} (${row.e164})` })
      : await importTwilioNumber(config, { e164: row.e164, label: `${agent.name} (${row.e164})` });
    elevenLabsPhoneNumberId = imported.phoneNumberId;
    if (providers.assignAgentToNumber) {
      await providers.assignAgentToNumber(elevenLabsPhoneNumberId);
    } else {
      await assignAgentToNumber(config, elevenLabsPhoneNumberId);
    }

    const active = await activateNumberRow(collections, row._id, { elevenLabsPhoneNumberId });
    await collections.phoneNumbers.updateOne({ _id: active._id }, { $unset: { provisioningDetail: "" } });
    await setAgentPhoneFlag(collections, agent, true);
    await recordAudit(collections, {
      agentId: agent._id,
      ownerUserId: agent.ownerUserId,
      actor: "system",
      action: AUDIT_ACTIONS.phone.provisioned,
      status: "allowed",
      detail: `Phone number ${active.e164} provisioned.`,
      resourceType: "phoneNumber",
      resourceId: active._id.toHexString(),
      metadata: { twilioSid: active.twilioSid ?? null, elevenLabsPhoneNumberId }
    });
    return { ...active, provisioningDetail: undefined };
  } catch (error) {
    if (elevenLabsPhoneNumberId) {
      await safeRemoveElevenLabsNumber(config, providers, elevenLabsPhoneNumberId);
    }
    if (row?.twilioSid || purchased?.twilioSid) {
      const sid = row?.twilioSid ?? purchased?.twilioSid;
      if (sid) {
        await safeReleaseTwilioNumber(config, providers, sid);
      }
    }
    if (row) {
      await markReleased(collections, row._id, (error as Error).message);
    }
    await setAgentPhoneFlag(collections, agent, false);
    throw error;
  }
}

export async function deprovisionAgentPhoneNumber(
  collections: Collections,
  config: AppConfig,
  agent: AgentDocument,
  providers: PhoneProvisioningProviders = {}
): Promise<void> {
  const row = await collections.phoneNumbers.findOne(
    { agentId: agent._id, status: { $in: ["provisioning", "active", "releasing"] } },
    { sort: { createdAt: -1 } }
  );
  if (!row) {
    await setAgentPhoneFlag(collections, agent, false);
    return;
  }
  if (row.elevenLabsPhoneNumberId) {
    await safeRemoveElevenLabsNumber(config, providers, row.elevenLabsPhoneNumberId);
  }
  await releasePersistedNumber(collections, config, row, providers.releaseNumber ? { releaseNumber: providers.releaseNumber } : undefined);
  await setAgentPhoneFlag(collections, agent, false);
  await recordAudit(collections, {
    agentId: agent._id,
    ownerUserId: agent.ownerUserId,
    actor: "system",
    action: AUDIT_ACTIONS.phone.released,
    status: "allowed",
    detail: `Phone number ${row.e164} released.`,
    resourceType: "phoneNumber",
    resourceId: row._id.toHexString()
  });
}

export async function getAgentPhoneProvisioningStatus(collections: Collections, agent: AgentDocument): Promise<ProvisioningStatus> {
  const row = await collections.phoneNumbers.findOne(
    { agentId: agent._id },
    { sort: { createdAt: -1 } }
  );
  if (!row) {
    return { state: "not_provisioned" };
  }
  if (row.status === "active") {
    return { state: "active", detail: row.e164 };
  }
  if (row.status === "provisioning" || row.status === "releasing") {
    return { state: "pending", detail: row.provisioningDetail ?? row.e164 };
  }
  if (row.releaseDetail) {
    return { state: "failed", detail: row.releaseDetail };
  }
  return { state: "not_provisioned" };
}

async function safeRemoveElevenLabsNumber(config: AppConfig, providers: PhoneProvisioningProviders, phoneNumberId: string): Promise<void> {
  try {
    if (providers.removeNumber) {
      await providers.removeNumber(phoneNumberId);
    } else {
      await removeNumber(config, phoneNumberId);
    }
  } catch {
    // Best-effort compensation; original failure should stay primary.
  }
}

async function safeReleaseTwilioNumber(config: AppConfig, providers: PhoneProvisioningProviders, twilioSid: string): Promise<void> {
  try {
    if (providers.releaseNumber) {
      providers.releaseNumber(twilioSid);
    } else {
      await releaseNumber(config, twilioSid);
    }
  } catch {
    // Best-effort compensation; original failure should stay primary.
  }
}

async function setPhoneProvisioningDetail(collections: Collections, rowId: PhoneNumberDocument["_id"], detail: string): Promise<void> {
  await collections.phoneNumbers.updateOne({ _id: rowId }, { $set: { provisioningDetail: detail, updatedAt: new Date() } });
}

async function setAgentPhoneFlag(collections: Collections, agent: AgentDocument, enabled: boolean): Promise<void> {
  await collections.agents.updateOne(
    { _id: agent._id },
    { $set: { "capabilities.phone": enabled, updatedAt: new Date() } }
  );
  agent.capabilities.phone = enabled;
}
