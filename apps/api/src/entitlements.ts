import { ObjectId } from "mongodb";
import type { Collections, UsageEventDocument } from "./db.js";
import { billingPlans, type BillingPlan } from "./billing.js";
import { ApiError } from "./errors.js";

export type EntitlementCheck =
  | { type: "agent.create" }
  | { type: "capability.enable"; capability: "email" | "phone" }
  | { type: "usage"; meter: "email" | "call_minutes" | "sms" }
  | { type: "number.provision" };

type UsageCheckMeter = Extract<EntitlementCheck, { type: "usage" }>["meter"];
type EntitlementPlan = (typeof entitlementCatalog)[BillingPlan];

export interface EntitlementResult {
  allowed: boolean;
  reason?: string;
  upgradeHint?: string;
  plan: BillingPlan;
}

export const entitlementCatalog = {
  free: {
    maxAgents: billingPlans.free.agentLimit,
    capabilities: { email: true, phone: false },
    includedNumbers: billingPlans.free.phoneNumberLimit,
    monthlyEmails: billingPlans.free.includedEmails,
    monthlyCallMinutes: billingPlans.free.includedCallMinutes,
    monthlySms: billingPlans.free.includedSms
  },
  pro: {
    maxAgents: billingPlans.pro.agentLimit,
    capabilities: { email: true, phone: true },
    includedNumbers: billingPlans.pro.phoneNumberLimit,
    monthlyEmails: billingPlans.pro.includedEmails,
    monthlyCallMinutes: billingPlans.pro.includedCallMinutes,
    monthlySms: billingPlans.pro.includedSms
  },
  scale: {
    maxAgents: billingPlans.scale.agentLimit,
    capabilities: { email: true, phone: true },
    includedNumbers: billingPlans.scale.phoneNumberLimit,
    monthlyEmails: billingPlans.scale.includedEmails,
    monthlyCallMinutes: billingPlans.scale.includedCallMinutes,
    monthlySms: billingPlans.scale.includedSms
  }
} as const;

export async function checkEntitlement(
  collections: Collections,
  ownerUserId: ObjectId,
  check: EntitlementCheck
): Promise<EntitlementResult> {
  const account = await collections.billingAccounts.findOne({ ownerUserId });
  const plan = account?.plan ?? "free";
  const entitlement = entitlementCatalog[plan];

  if (check.type === "agent.create") {
    const count = await collections.agents.countDocuments({ ownerUserId, status: { $ne: "revoked" } });
    return count < entitlement.maxAgents
      ? allowed(plan)
      : blocked(plan, `Your ${plan} plan includes ${entitlement.maxAgents} agent ${entitlement.maxAgents === 1 ? "identity" : "identities"}.`, agentUpgradeHint(plan));
  }

  if (check.type === "capability.enable") {
    if (!entitlement.capabilities[check.capability]) {
      return blocked(plan, `${capitalize(check.capability)} capability is not included on ${plan}.`, capabilityUpgradeHint(check.capability));
    }
    if (check.capability === "phone") {
      const activeNumbers = await countActiveNumbers(collections, ownerUserId);
      if (activeNumbers >= entitlement.includedNumbers) {
        return blocked(plan, `Your ${plan} plan includes ${entitlement.includedNumbers} phone number${entitlement.includedNumbers === 1 ? "" : "s"}.`, "Upgrade to Scale for 3 included phone numbers.");
      }
    }
    return allowed(plan);
  }

  if (check.type === "number.provision") {
    const activeNumbers = await countActiveNumbers(collections, ownerUserId);
    return activeNumbers < entitlement.includedNumbers
      ? allowed(plan)
      : blocked(plan, `Your ${plan} plan includes ${entitlement.includedNumbers} phone number${entitlement.includedNumbers === 1 ? "" : "s"}.`, numberUpgradeHint(plan));
  }

  const included = includedUsage(entitlement, check.meter);
  if (plan !== "free") return allowed(plan);
  const used = await currentUsage(collections, ownerUserId, usageMeter(check.meter));
  const hardLimit = included * 2;
  return used < hardLimit
    ? allowed(plan)
    : blocked(plan, `Your free plan usage limit for ${check.meter} is ${hardLimit}.`, usageUpgradeHint(check.meter));
}

export function throwPlanLimit(result: EntitlementResult): void {
  if (result.allowed) return;
  throw new ApiError(402, "plan_limit", result.reason ?? "plan limit reached", {
    plan: result.plan,
    upgradeHint: result.upgradeHint
  });
}

function allowed(plan: BillingPlan): EntitlementResult {
  return { allowed: true, plan };
}

function blocked(plan: BillingPlan, reason: string, upgradeHint: string): EntitlementResult {
  return { allowed: false, plan, reason, upgradeHint };
}

async function countActiveNumbers(collections: Collections, ownerUserId: ObjectId): Promise<number> {
  const agents = await collections.agents.find({ ownerUserId, status: { $ne: "revoked" } }, { projection: { _id: 1 } }).toArray();
  return collections.phoneNumbers.countDocuments({ agentId: { $in: agents.map((agent) => agent._id) }, status: "active" });
}

async function currentUsage(collections: Collections, ownerUserId: ObjectId, meter: UsageEventDocument["meter"]): Promise<number> {
  const account = await collections.billingAccounts.findOne({ ownerUserId });
  const periodKey = account?.currentPeriodEnd ? periodKeyFromDate(account.currentPeriodEnd) : periodKeyFromDate(new Date());
  const row = await collections.usageEvents.aggregate<{ used: number }>([
    { $match: { ownerUserId, meter, periodKey } },
    { $group: { _id: null, used: { $sum: "$quantity" } } }
  ]).next();
  return row?.used ?? 0;
}

function includedUsage(entitlement: EntitlementPlan, meter: UsageCheckMeter): number {
  if (meter === "email") return entitlement.monthlyEmails;
  if (meter === "call_minutes") return entitlement.monthlyCallMinutes;
  return entitlement.monthlySms;
}

function usageMeter(meter: UsageCheckMeter): UsageEventDocument["meter"] {
  if (meter === "email") return "emails_sent";
  if (meter === "sms") return "sms_messages";
  return "call_minutes";
}

function agentUpgradeHint(plan: BillingPlan): string {
  if (plan === "free") return "Upgrade to Pro for 3 agents.";
  return "Upgrade to Scale for 10 agents.";
}

function capabilityUpgradeHint(capability: "email" | "phone"): string {
  return capability === "phone" ? "Upgrade to Pro for phone access." : "Upgrade to Pro for more email capacity.";
}

function numberUpgradeHint(plan: BillingPlan): string {
  if (plan === "free") return "Upgrade to Pro for phone numbers.";
  if (plan === "pro") return "Upgrade to Scale for 3 included phone numbers.";
  return "Contact support for more phone numbers.";
}

function usageUpgradeHint(meter: "email" | "call_minutes" | "sms"): string {
  if (meter === "email") return "Upgrade to Pro for 500 included emails and metered overage.";
  if (meter === "sms") return "Upgrade to Pro for SMS access.";
  return "Upgrade to Pro for call minutes.";
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function periodKeyFromDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
