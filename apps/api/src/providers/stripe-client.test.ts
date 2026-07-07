import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import {
  Stripe,
  getStripeClient,
  stripeApiVersion,
  stripeMaxNetworkRetries,
  stripeRequestTimeoutMs
} from "./stripe-client.js";

describe("getStripeClient", () => {
  it("pins Stripe SDK settings without network access", () => {
    const config = { STRIPE_SECRET_KEY: "sk_test_client" } as AppConfig;
    const client = getStripeClient(config);

    expect(client).toBe(getStripeClient(config));
    expect(Stripe.API_VERSION).toBe(stripeApiVersion);
    expect(client.getApiField("timeout")).toBe(stripeRequestTimeoutMs);
    expect(client.getApiField("maxNetworkRetries")).toBe(stripeMaxNetworkRetries);
    expect((client as unknown as { _api: { version: string } })._api.version).toBe(stripeApiVersion);
  });

  it("requires STRIPE_SECRET_KEY before creating a client", () => {
    expect(() => getStripeClient({} as AppConfig)).toThrow("STRIPE_SECRET_KEY is not configured");
  });
});
