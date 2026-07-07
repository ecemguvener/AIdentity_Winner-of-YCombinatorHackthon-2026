import type { AgentDocument, Collections } from "./db.js";

// ---------------------------------------------------------------------------
// Capability provisioner registry. Capability enable/disable on the agents
// API dispatches here; this module ships stub provisioners that only flip
// `agents.capabilities.<capability>` — the real email/phone provisioners
// (tasks 016/023) replace them via registerProvisioner.
// ---------------------------------------------------------------------------

export type CapabilityName = "email" | "phone";

export const CAPABILITY_NAMES: readonly CapabilityName[] = ["email", "phone"];

export interface ProvisioningStatus {
  state: "not_provisioned" | "pending" | "provisioned" | "active" | "paused" | "failed";
  detail?: string;
}

export interface CapabilityProvisioner {
  provision(agent: AgentDocument): Promise<void> | void;
  deprovision(agent: AgentDocument): Promise<void> | void;
  status(agent: AgentDocument): Promise<ProvisioningStatus> | ProvisioningStatus;
}

const registry = new Map<CapabilityName, CapabilityProvisioner>();

export function registerProvisioner(capability: CapabilityName, provisioner: CapabilityProvisioner): void {
  registry.set(capability, provisioner);
}

export function getProvisioner(capability: CapabilityName): CapabilityProvisioner {
  const provisioner = registry.get(capability);
  if (!provisioner) {
    throw new Error(`no provisioner registered for capability: ${capability}`);
  }
  return provisioner;
}

export function isCapabilityName(value: string): value is CapabilityName {
  return (CAPABILITY_NAMES as readonly string[]).includes(value);
}

/** Registers the stub provisioners unless a real one is already in place. */
export function registerStubProvisioners(collections: Collections): void {
  for (const capability of CAPABILITY_NAMES) {
    if (registry.has(capability)) {
      continue;
    }
    registerProvisioner(capability, {
      provision: (agent) => setCapabilityFlag(collections, agent, capability, true),
      deprovision: (agent) => setCapabilityFlag(collections, agent, capability, false),
      status: () => ({ state: "not_provisioned" })
    });
  }
}

export async function capabilityProvisioningSummary(agent: AgentDocument) {
  const [email, phone] = await Promise.all(
    CAPABILITY_NAMES.map(async (capability) => ({
      enabled: agent.capabilities[capability],
      ...(await getProvisioner(capability).status(agent))
    }))
  );
  return { email, phone };
}

async function setCapabilityFlag(
  collections: Collections,
  agent: AgentDocument,
  capability: CapabilityName,
  enabled: boolean
): Promise<void> {
  await collections.agents.updateOne(
    { _id: agent._id },
    { $set: { [`capabilities.${capability}`]: enabled, updatedAt: new Date() } }
  );
}
