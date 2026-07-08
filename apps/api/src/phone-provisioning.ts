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

  const retainedNumber = await findReusableRetainedNumber(collections, agent);
  if (retainedNumber) {
    return provisionRetainedPhoneNumber(collections, config, agent, retainedNumber, providers);
  }

  let row: PhoneNumberDocument | null = null;
  let purchased: PurchasedTwilioNumber | null = null;
  let elevenLabsPhoneNumberId: string | null = null;
  try {
    const candidates = providers.searchNumbers
      ? await providers.searchNumbers({ country: config.TWILIO_NUMBER_COUNTRY || "US" })
      : await searchNumbers(config, { country: config.TWILIO_NUMBER_COUNTRY || "US" });
    const usedNumbers = new Set(
      (await collections.phoneNumbers.find({ e164: { $in: candidates.map((item) => item.e164) } }).toArray()).map((number) => number.e164)
    );
    const candidate = candidates.find((item) => item.voiceEnabled && item.smsEnabled && !usedNumbers.has(item.e164));
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

export async function retainAgentPhoneNumberForReuse(
  collections: Collections,
  config: AppConfig,
  agent: AgentDocument,
  providers: PhoneProvisioningProviders = {}
): Promise<void> {
  const row = await collections.phoneNumbers.findOne(
    { agentId: agent._id, status: "active", twilioSid: { $type: "string" } },
    { sort: { createdAt: -1 } }
  );
  if (!row) {
    await setAgentPhoneFlag(collections, agent, false);
    return;
  }
  if (row.elevenLabsPhoneNumberId) {
    await safeRemoveElevenLabsNumber(config, providers, row.elevenLabsPhoneNumberId);
  }
  const updated = await collections.phoneNumbers.findOneAndUpdate(
    { _id: row._id },
    {
      $set: { status: "active", updatedAt: new Date() },
      $unset: { elevenLabsPhoneNumberId: "", provisioningDetail: "", releaseDetail: "" }
    },
    { returnDocument: "after" }
  );
  await setAgentPhoneFlag(collections, agent, false);
  await recordAudit(collections, {
    agentId: agent._id,
    ownerUserId: agent.ownerUserId,
    actor: "system",
    action: "phone.number.retained",
    status: "allowed",
    detail: `Phone number ${row.e164} retained for reuse instead of released.`,
    resourceType: "phoneNumber",
    resourceId: row._id.toHexString(),
    metadata: { twilioSid: row.twilioSid ?? null }
  });
  if (updated) {
    await recordAudit(collections, {
      agentId: agent._id,
      ownerUserId: agent.ownerUserId,
      actor: "system",
      action: AUDIT_ACTIONS.phone.released,
      status: "allowed",
      detail: `Phone capability disabled; ${updated.e164} retained for reuse.`,
      resourceType: "phoneNumber",
      resourceId: updated._id.toHexString()
    });
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

async function findReusableRetainedNumber(collections: Collections, agent: AgentDocument): Promise<PhoneNumberDocument | null> {
  if (!agent.ownerUserId) return null;
  const revokedAgents = await collections.agents
    .find({ ownerUserId: agent.ownerUserId, status: "revoked" }, { projection: { _id: 1 } })
    .toArray();
  if (revokedAgents.length === 0) return null;
  return collections.phoneNumbers.findOne(
    {
      agentId: { $in: revokedAgents.map((revokedAgent) => revokedAgent._id) },
      status: "active",
      twilioSid: { $type: "string" }
    },
    { sort: { updatedAt: 1 } }
  );
}

async function provisionRetainedPhoneNumber(
  collections: Collections,
  config: AppConfig,
  agent: AgentDocument,
  retainedNumber: PhoneNumberDocument,
  providers: PhoneProvisioningProviders
): Promise<PhoneNumberDocument> {
  const previousAgentId = retainedNumber.agentId;
  let elevenLabsPhoneNumberId: string | null = null;
  try {
    if (retainedNumber.elevenLabsPhoneNumberId) {
      await safeRemoveElevenLabsNumber(config, providers, retainedNumber.elevenLabsPhoneNumberId);
    }
    const claimed = await collections.phoneNumbers.findOneAndUpdate(
      { _id: retainedNumber._id, agentId: previousAgentId, status: "active" },
      {
        $set: {
          agentId: agent._id,
          provisioningDetail: "Linking retained number...",
          updatedAt: new Date()
        },
        $unset: { elevenLabsPhoneNumberId: "", releaseDetail: "" }
      },
      { returnDocument: "after" }
    );
    if (!claimed) {
      throw new ApiError(409, "validation_failed", "retained phone number was already claimed");
    }

    const imported = providers.importTwilioNumber
      ? await providers.importTwilioNumber({ e164: claimed.e164, label: `${agent.name} (${claimed.e164})` })
      : await importTwilioNumber(config, { e164: claimed.e164, label: `${agent.name} (${claimed.e164})` });
    elevenLabsPhoneNumberId = imported.phoneNumberId;
    if (providers.assignAgentToNumber) {
      await providers.assignAgentToNumber(elevenLabsPhoneNumberId);
    } else {
      await assignAgentToNumber(config, elevenLabsPhoneNumberId);
    }

    const active = await activateNumberRow(collections, claimed._id, { elevenLabsPhoneNumberId });
    await collections.phoneNumbers.updateOne({ _id: active._id }, { $unset: { provisioningDetail: "", releaseDetail: "" } });
    await setAgentPhoneFlag(collections, agent, true);
    await recordAudit(collections, {
      agentId: agent._id,
      ownerUserId: agent.ownerUserId,
      actor: "system",
      action: "phone.number.reused",
      status: "allowed",
      detail: `Reused retained phone number ${active.e164}.`,
      resourceType: "phoneNumber",
      resourceId: active._id.toHexString(),
      metadata: { previousAgentId: previousAgentId.toHexString(), twilioSid: active.twilioSid ?? null }
    });
    await recordAudit(collections, {
      agentId: agent._id,
      ownerUserId: agent.ownerUserId,
      actor: "system",
      action: AUDIT_ACTIONS.phone.provisioned,
      status: "allowed",
      detail: `Phone number ${active.e164} provisioned from retained inventory.`,
      resourceType: "phoneNumber",
      resourceId: active._id.toHexString(),
      metadata: { twilioSid: active.twilioSid ?? null, elevenLabsPhoneNumberId }
    });
    return { ...active, provisioningDetail: undefined, releaseDetail: undefined };
  } catch (error) {
    if (elevenLabsPhoneNumberId) {
      await safeRemoveElevenLabsNumber(config, providers, elevenLabsPhoneNumberId);
    }
    await collections.phoneNumbers.updateOne(
      { _id: retainedNumber._id, agentId: agent._id },
      {
        $set: {
          agentId: previousAgentId,
          status: "active",
          releaseDetail: (error as Error).message,
          updatedAt: new Date()
        },
        $unset: { provisioningDetail: "", elevenLabsPhoneNumberId: "" }
      }
    );
    await setAgentPhoneFlag(collections, agent, false);
    throw error;
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
