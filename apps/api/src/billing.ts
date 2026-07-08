import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { BillingAccountDocument, Collections, UserDocument } from "./db.js";
import { AUDIT_ACTIONS, recordAudit } from "./audit.js";
import { requireAuth } from "./auth.js";
import { ApiError } from "./errors.js";
import { instrumentProviderCall } from "./metrics.js";
import { getStripeClient, hasStripeBillingConfig, type Stripe } from "./providers/stripe-client.js";
import { registerStripeEventHandler } from "./stripe-webhooks.js";

export type BillingPlan = BillingAccountDocument["plan"];

export const billingPlans = {
  free: {
    plan: "free",
    monthlyPriceEur: 0,
    agentLimit: 1,
    phoneNumberLimit: 0,
    emailEnabled: true,
    phoneEnabled: false,
    includedEmails: 50,
    includedCallMinutes: 0,
    includedSms: 0
  },
  pro: {
    plan: "pro",
    monthlyPriceEur: 29,
    agentLimit: 3,
    phoneNumberLimit: 1,
    emailEnabled: true,
    phoneEnabled: true,
    includedEmails: 500,
    includedCallMinutes: 120,
    includedSms: 200
  },
  scale: {
    plan: "scale",
    monthlyPriceEur: 99,
    agentLimit: 10,
    phoneNumberLimit: 3,
    emailEnabled: true,
    phoneEnabled: true,
    includedEmails: 2000,
    includedCallMinutes: 600,
    includedSms: 1000
  }
} as const;

const checkoutSchema = z.object({
  plan: z.enum(["pro", "scale"])
});

const subscriptionEventTypes = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted"
] as const;

export function registerBillingRoutes(app: FastifyInstance, collections: Collections, config: AppConfig): void {
  app.get("/api/v1/billing/plans", async (request, reply) => {
    await requireAuth(request, reply, collections, config);
    return { plans: serializeBillingPlans() };
  });

  app.get("/api/v1/billing", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const account = await ensureBillingAccount(collections, config, authContext.user);
    return serializeBillingAccount(account);
  });

  app.post("/api/v1/billing/checkout", async (request, reply) => {
    if (!hasStripeBillingConfig(config)) {
      throw new ApiError(503, "provider_error", "Stripe billing is not configured");
    }
    const authContext = await requireAuth(request, reply, collections, config);
    const payload = checkoutSchema.parse(request.body ?? {});
    const blocking = await getDowngradeBlocks(collections, authContext.user._id, payload.plan);
    if (blocking.length > 0) {
      throw new ApiError(409, "validation_failed", "current usage exceeds selected plan limits", { blocking });
    }
    const account = await ensureBillingAccount(collections, config, authContext.user);
    const price = priceIdForPlan(config, payload.plan);
    const stripe = getStripeClient(config);
    const session = await instrumentProviderCall("stripe", "checkout.sessions.create", () => stripe.checkout.sessions.create({
      mode: "subscription",
      customer: account.stripeCustomerId,
      line_items: [{ price, quantity: 1 }, ...overagePriceLineItems(config)],
      success_url: `${config.PUBLIC_APP_URL.replace(/\/$/, "")}/settings/billing?checkout=success`,
      cancel_url: `${config.PUBLIC_APP_URL.replace(/\/$/, "")}/settings/billing?checkout=cancelled`,
      metadata: { barkanUserId: authContext.user._id.toHexString(), plan: payload.plan },
      subscription_data: {
        metadata: { barkanUserId: authContext.user._id.toHexString(), plan: payload.plan }
      }
    }));
    if (!session.url) {
      throw new ApiError(502, "provider_error", "Stripe checkout session did not include a URL");
    }
    return { checkoutUrl: session.url };
  });

  app.post("/api/v1/billing/portal", async (request, reply) => {
    if (!hasStripeBillingConfig(config)) {
      throw new ApiError(503, "provider_error", "Stripe billing is not configured");
    }
    const authContext = await requireAuth(request, reply, collections, config);
    const account = await ensureBillingAccount(collections, config, authContext.user);
    const stripe = getStripeClient(config);
    const session = await instrumentProviderCall("stripe", "billingPortal.sessions.create", () => stripe.billingPortal.sessions.create({
      customer: account.stripeCustomerId,
      return_url: `${config.PUBLIC_APP_URL.replace(/\/$/, "")}/settings/billing`
    }));
    return { portalUrl: session.url };
  });
}

function serializeBillingPlans() {
  return Object.values(billingPlans).map((plan) => ({
    plan: plan.plan,
    name: plan.plan === "free" ? "Free" : plan.plan === "pro" ? "Pro" : "Scale",
    monthlyPriceEur: plan.monthlyPriceEur,
    limits: {
      agents: plan.agentLimit,
      phoneNumbers: plan.phoneNumberLimit
    },
    features: {
      email: plan.emailEnabled,
      phone: plan.phoneEnabled
    },
    includedUsage: {
      emails: plan.includedEmails,
      callMinutes: plan.includedCallMinutes,
      sms: plan.includedSms
    }
  }));
}

function overagePriceLineItems(config: AppConfig): Array<{ price: string }> {
  return [
    config.BILLING_PRICE_OVERAGE_EMAILS,
    config.BILLING_PRICE_OVERAGE_CALL_MINUTES,
    config.BILLING_PRICE_OVERAGE_SMS,
    config.BILLING_PRICE_OVERAGE_ACTIVE_NUMBERS
  ].filter((price): price is string => Boolean(price)).map((price) => ({ price }));
}

export function registerBillingStripeHandlers(collections: Collections): void {
  for (const eventType of subscriptionEventTypes) {
    registerStripeEventHandler(eventType, (event) => syncSubscriptionEvent(collections, event));
  }
  registerStripeEventHandler("invoice.payment_failed", (event) => handleInvoicePaymentFailed(collections, event));
}

export async function ensureBillingAccount(
  collections: Collections,
  config: AppConfig,
  user: UserDocument
): Promise<BillingAccountDocument> {
  const existing = await collections.billingAccounts.findOne({ ownerUserId: user._id });
  if (existing && !existing.stripeCustomerId.startsWith("cus_pending_")) {
    return existing;
  }

  const now = new Date();
  let stripeCustomerId = existing?.stripeCustomerId ?? `cus_pending_${user._id.toHexString()}`;
  if (config.STRIPE_SECRET_KEY) {
    const customer = await instrumentProviderCall("stripe", "customers.create", () => getStripeClient(config).customers.create({
      email: user.email,
      name: user.displayName ?? undefined,
      metadata: { barkanUserId: user._id.toHexString() }
    }));
    stripeCustomerId = customer.id;
  }

  const replacement: BillingAccountDocument = {
    _id: existing?._id ?? new ObjectId(),
    ownerUserId: user._id,
    stripeCustomerId,
    plan: existing?.plan ?? "free",
    subscriptionId: existing?.subscriptionId,
    subscriptionStatus: existing?.subscriptionStatus,
    currentPeriodEnd: existing?.currentPeriodEnd,
    lastStripeEventCreated: existing?.lastStripeEventCreated,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  await collections.billingAccounts.updateOne(
    { ownerUserId: user._id },
    { $set: replacement },
    { upsert: true }
  );
  return replacement;
}

async function getDowngradeBlocks(collections: Collections, ownerUserId: ObjectId, targetPlan: "pro" | "scale"): Promise<string[]> {
  const plan = billingPlans[targetPlan];
  const [agentCount, activePhoneNumberCount] = await Promise.all([
    collections.agents.countDocuments({ ownerUserId, status: { $ne: "revoked" } }),
    collections.phoneNumbers.countDocuments({ status: "active", agentId: { $in: await ownedAgentIds(collections, ownerUserId) } })
  ]);
  const blocking: string[] = [];
  if (agentCount > plan.agentLimit) {
    blocking.push(`Remove ${agentCount - plan.agentLimit} agent identity before selecting ${targetPlan}.`);
  }
  if (activePhoneNumberCount > plan.phoneNumberLimit) {
    blocking.push(`Release ${activePhoneNumberCount - plan.phoneNumberLimit} phone number before selecting ${targetPlan}.`);
  }
  return blocking;
}

async function ownedAgentIds(collections: Collections, ownerUserId: ObjectId): Promise<ObjectId[]> {
  const agents = await collections.agents.find({ ownerUserId, status: { $ne: "revoked" } }, { projection: { _id: 1 } }).toArray();
  return agents.map((agent) => agent._id);
}

function priceIdForPlan(config: AppConfig, plan: "pro" | "scale"): string {
  const price = plan === "pro" ? config.BILLING_PRICE_PRO : config.BILLING_PRICE_SCALE;
  if (!price) {
    throw new ApiError(503, "provider_error", `BILLING_PRICE_${plan.toUpperCase()} is not configured`);
  }
  return price;
}

async function syncSubscriptionEvent(collections: Collections, event: Stripe.Event): Promise<void> {
  const subscription = event.data.object as Stripe.Subscription;
  const customerId = readStripeId(subscription.customer);
  if (!customerId) return;
  const plan = planFromSubscription(subscription);
  const subscriptionId = subscription.id;
  const currentPeriodEnd = readCurrentPeriodEnd(subscription);
  await collections.billingAccounts.updateOne(
    {
      stripeCustomerId: customerId,
      $or: [
        { lastStripeEventCreated: { $exists: false } },
        { lastStripeEventCreated: { $lte: event.created } }
      ]
    },
    {
      $set: {
        plan: event.type === "customer.subscription.deleted" ? "free" : plan,
        subscriptionId,
        subscriptionStatus: subscription.status,
        ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
        lastStripeEventCreated: event.created,
        updatedAt: new Date()
      }
    }
  );
}

async function handleInvoicePaymentFailed(collections: Collections, event: Stripe.Event): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = readStripeId(invoice.customer);
  if (!customerId) return;
  const account = await collections.billingAccounts.findOneAndUpdate(
    { stripeCustomerId: customerId },
    { $set: { subscriptionStatus: "past_due", updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!account) return;
  const owner = await collections.users.findOne({ _id: account.ownerUserId });
  const agent = await collections.agents.findOne({ ownerUserId: account.ownerUserId, status: { $ne: "revoked" } });
  if (!agent) return;
  await recordAudit(collections, {
    agentId: agent._id,
    ownerUserId: account.ownerUserId,
    actor: "system",
    action: AUDIT_ACTIONS.billing.paymentFailed,
    status: "blocked",
    detail: `Stripe invoice payment failed for ${owner?.email ?? account.ownerUserId.toHexString()}.`,
    resourceType: "billingAccount",
    resourceId: account._id.toHexString(),
    metadata: { stripeInvoiceId: invoice.id, stripeCustomerId: customerId }
  });
}

function planFromSubscription(subscription: Stripe.Subscription): BillingPlan {
  const lookupKey = readSubscriptionLookupKey(subscription);
  if (lookupKey === "barkan_scale_monthly") return "scale";
  if (lookupKey === "barkan_pro_monthly") return "pro";
  return "free";
}

function readSubscriptionLookupKey(subscription: Stripe.Subscription): string | null {
  const firstItem = subscription.items?.data[0];
  const lookupKey = firstItem?.price?.lookup_key;
  return typeof lookupKey === "string" ? lookupKey : null;
}

function readCurrentPeriodEnd(subscription: Stripe.Subscription): Date | undefined {
  const periodEnd = (subscription as unknown as { current_period_end?: unknown }).current_period_end;
  return typeof periodEnd === "number" ? new Date(periodEnd * 1000) : undefined;
}

function readStripeId(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return null;
}

function serializeBillingAccount(account: BillingAccountDocument) {
  const plan = billingPlans[account.plan];
  return {
    plan: account.plan,
    monthlyPriceEur: plan.monthlyPriceEur,
    subscriptionStatus: account.subscriptionStatus ?? null,
    currentPeriodEnd: account.currentPeriodEnd?.toISOString() ?? null,
    includedUsage: {
      agents: plan.agentLimit,
      phoneNumbers: plan.phoneNumberLimit,
      emails: plan.includedEmails,
      callMinutes: plan.includedCallMinutes,
      sms: plan.includedSms
    }
  };
}
