import { ObjectId } from "mongodb";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { BillingAccountDocument, Collections, UsageEventDocument } from "./db.js";
import { requireAuth } from "./auth.js";
import { billingPlans } from "./billing.js";
import { getStripeClient, hasStripeBillingConfig, type Stripe } from "./providers/stripe-client.js";

export type UsageMeter = UsageEventDocument["meter"];

export const usageMeters: readonly UsageMeter[] = ["emails_sent", "call_minutes", "sms_messages", "active_numbers"];

export const stripeMeterEventNames: Record<UsageMeter, string> = {
  emails_sent: "barkan_emails_sent",
  call_minutes: "barkan_call_minutes",
  sms_messages: "barkan_sms_messages",
  active_numbers: "barkan_active_numbers"
};

export interface RecordUsageInput {
  ownerUserId: ObjectId;
  agentId: ObjectId;
  meter: UsageMeter;
  quantity: number;
  dedupeKey?: string;
}

export interface UsageSummary {
  periodKey: string;
  plan: BillingAccountDocument["plan"];
  perMeter: Record<UsageMeter, { used: number; included: number; overage: number }>;
}

export async function recordUsage(
  collections: Collections,
  input: RecordUsageInput,
  now = new Date()
): Promise<void> {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) return;
  const periodKey = await resolvePeriodKey(collections, input.ownerUserId, now);
  const document = {
    _id: new ObjectId(),
    ownerUserId: input.ownerUserId,
    agentId: input.agentId,
    meter: input.meter,
    quantity: input.quantity,
    stripeReported: false,
    periodKey,
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    createdAt: now,
    updatedAt: now
  };
  if (!input.dedupeKey) {
    await collections.usageEvents.insertOne(document);
    return;
  }
  await collections.usageEvents.updateOne(
    { dedupeKey: input.dedupeKey },
    { $setOnInsert: document },
    { upsert: true }
  );
}

export async function recordActiveNumberUsageSnapshot(collections: Collections, now = new Date()): Promise<number> {
  const activeNumbers = await collections.phoneNumbers.find({ status: "active" }).toArray();
  let inserted = 0;
  for (const phoneNumber of activeNumbers) {
    const agent = await collections.agents.findOne({ _id: phoneNumber.agentId, ownerUserId: { $ne: null } });
    if (!agent?.ownerUserId) continue;
    const before = await collections.usageEvents.countDocuments();
    await recordUsage(collections, {
      ownerUserId: agent.ownerUserId,
      agentId: agent._id,
      meter: "active_numbers",
      quantity: 1,
      dedupeKey: `active_numbers:${phoneNumber._id.toHexString()}:${dayKey(now)}`
    }, now);
    const after = await collections.usageEvents.countDocuments();
    if (after > before) inserted += 1;
  }
  return inserted;
}

export async function getUsageSummary(
  collections: Collections,
  ownerUserId: ObjectId,
  periodKey?: string
): Promise<UsageSummary> {
  const account = await collections.billingAccounts.findOne({ ownerUserId });
  const planName = account?.plan ?? "free";
  const key = periodKey ?? await resolvePeriodKey(collections, ownerUserId, new Date());
  const used = await usageTotals(collections, ownerUserId, key);
  const perMeter = Object.fromEntries(usageMeters.map((meter) => {
    const included = includedForMeter(planName, meter);
    const meterUsed = used[meter] ?? 0;
    return [meter, { used: meterUsed, included, overage: Math.max(0, meterUsed - included) }];
  })) as UsageSummary["perMeter"];
  return { periodKey: key, plan: planName, perMeter };
}

export async function reportUsageToStripe(
  collections: Collections,
  config: AppConfig,
  options: { dryRun?: boolean; stripe?: Stripe } = {}
): Promise<Array<{ ownerUserId: string; meter: UsageMeter; periodKey: string; delta: number; identifier: string }>> {
  if (!hasStripeBillingConfig(config)) return [];
  const stripe = options.stripe ?? getStripeClient(config);
  const accounts = await collections.billingAccounts
    .find({ plan: { $in: ["pro", "scale"] }, subscriptionStatus: { $in: ["active", "trialing", "past_due"] } })
    .toArray();
  const reported: Array<{ ownerUserId: string; meter: UsageMeter; periodKey: string; delta: number; identifier: string }> = [];

  for (const account of accounts) {
    const periodKey = account.currentPeriodEnd ? periodKeyFromDate(account.currentPeriodEnd) : periodKeyFromDate(new Date());
    const used = await usageTotals(collections, account.ownerUserId, periodKey);
    for (const meter of usageMeters) {
      const overage = Math.max(0, (used[meter] ?? 0) - includedForMeter(account.plan, meter));
      const report = await collections.usageReports.findOne({ ownerUserId: account.ownerUserId, periodKey, meter });
      const alreadyReported = report?.reportedQuantity ?? 0;
      const delta = overage - alreadyReported;
      if (delta <= 0) continue;
      const sequence = (report?.sequence ?? 0) + 1;
      const identifier = `${account._id.toHexString()}_${meter}_${periodKey}_${sequence}`;
      reported.push({ ownerUserId: account.ownerUserId.toHexString(), meter, periodKey, delta, identifier });
      if (options.dryRun) continue;
      await stripe.billing.meterEvents.create({
        event_name: stripeMeterEventNames[meter],
        identifier,
        payload: {
          stripe_customer_id: account.stripeCustomerId,
          value: String(delta)
        }
      });
      const now = new Date();
      await collections.usageReports.updateOne(
        { ownerUserId: account.ownerUserId, periodKey, meter },
        {
          $set: {
            billingAccountId: account._id,
            stripeCustomerId: account.stripeCustomerId,
            reportedQuantity: overage,
            sequence,
            lastIdentifier: identifier,
            updatedAt: now
          },
          $setOnInsert: { _id: new ObjectId(), createdAt: now }
        },
        { upsert: true }
      );
      await collections.usageEvents.updateMany(
        { ownerUserId: account.ownerUserId, periodKey, meter, stripeReported: false },
        { $set: { stripeReported: true, updatedAt: now } }
      );
    }
  }
  return reported;
}

export function registerUsageRoutes(app: FastifyInstance, collections: Collections, config: AppConfig): void {
  app.get("/api/v1/billing/usage", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    return await getUsageSummary(collections, authContext.user._id);
  });
}

async function resolvePeriodKey(collections: Collections, ownerUserId: ObjectId, now: Date): Promise<string> {
  const account = await collections.billingAccounts.findOne({ ownerUserId });
  return account?.currentPeriodEnd ? periodKeyFromDate(account.currentPeriodEnd) : periodKeyFromDate(now);
}

async function usageTotals(collections: Collections, ownerUserId: ObjectId, periodKey: string): Promise<Partial<Record<UsageMeter, number>>> {
  const rows = await collections.usageEvents.aggregate<{ _id: UsageMeter; used: number }>([
    { $match: { ownerUserId, periodKey } },
    { $group: { _id: "$meter", used: { $sum: "$quantity" } } }
  ]).toArray();
  return Object.fromEntries(rows.map((row) => [row._id, row.used]));
}

function includedForMeter(plan: BillingAccountDocument["plan"], meter: UsageMeter): number {
  const catalog = billingPlans[plan];
  if (meter === "emails_sent") return catalog.includedEmails;
  if (meter === "call_minutes") return catalog.includedCallMinutes;
  if (meter === "sms_messages") return catalog.includedSms;
  return catalog.phoneNumberLimit;
}

function periodKeyFromDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function dayKey(date: Date): string {
  return `${periodKeyFromDate(date)}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
