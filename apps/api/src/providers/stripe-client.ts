import Stripe from "stripe";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";

export { Stripe };

export const stripeApiVersion = "2026-06-24.dahlia";
export const stripeRequestTimeoutMs = 10_000;
export const stripeMaxNetworkRetries = 2;

let cachedSecretKey: string | null = null;
let cachedClient: Stripe | null = null;
let testClientOverride: Stripe | null = null;

export function getStripeClient(config: AppConfig): Stripe {
  if (testClientOverride) {
    return testClientOverride;
  }

  const secretKey = config.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new ApiError(503, "provider_error", "STRIPE_SECRET_KEY is not configured");
  }

  if (cachedClient && cachedSecretKey === secretKey) {
    return cachedClient;
  }

  cachedSecretKey = secretKey;
  cachedClient = new Stripe(secretKey, {
    apiVersion: stripeApiVersion,
    timeout: stripeRequestTimeoutMs,
    maxNetworkRetries: stripeMaxNetworkRetries
  });
  return cachedClient;
}

export function setStripeClientForTest(client: Stripe | null): void {
  testClientOverride = client;
}

export function hasStripeBillingConfig(config: AppConfig): config is AppConfig & {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
} {
  return Boolean(config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET);
}
