import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { getStripeClient } from "../providers/stripe-client.js";
import { stripeMeterEventNames, usageMeters } from "../usage.js";

const products = [
  { key: "barkan_pro", name: "Barkan Pro" },
  { key: "barkan_scale", name: "Barkan Scale" },
  { key: "barkan_usage_overage", name: "Barkan Usage Overage" }
];

const prices = [
  { lookupKey: "barkan_pro_monthly", productKey: "barkan_pro", unitAmount: 2900, envName: "BILLING_PRICE_PRO" },
  { lookupKey: "barkan_scale_monthly", productKey: "barkan_scale", unitAmount: 9900, envName: "BILLING_PRICE_SCALE" }
];

const overageUnitAmounts: Record<string, number> = {
  emails_sent: 2,
  call_minutes: 15,
  sms_messages: 5,
  active_numbers: 200
};

const overageEnvNames: Record<string, string> = {
  emails_sent: "BILLING_PRICE_OVERAGE_EMAILS",
  call_minutes: "BILLING_PRICE_OVERAGE_CALL_MINUTES",
  sms_messages: "BILLING_PRICE_OVERAGE_SMS",
  active_numbers: "BILLING_PRICE_OVERAGE_ACTIVE_NUMBERS"
};

const writeEnv = process.argv.includes("--write-env");
const config = loadConfig();
const stripe = getStripeClient(config);

const productIds = new Map<string, string>();
for (const product of products) {
  const existing = await stripe.products.search({ query: `metadata['lookup_key']:'${product.key}'`, limit: 1 });
  const stripeProduct = existing.data[0] ?? await stripe.products.create({
    name: product.name,
    metadata: { lookup_key: product.key }
  });
  productIds.set(product.key, stripeProduct.id);
}

const envUpdates: Record<string, string> = {};
for (const price of prices) {
  const existing = await stripe.prices.list({ lookup_keys: [price.lookupKey], limit: 1 });
  const stripePrice = existing.data[0] ?? await stripe.prices.create({
    product: productIds.get(price.productKey)!,
    currency: "eur",
    unit_amount: price.unitAmount,
    recurring: { interval: "month" },
    lookup_key: price.lookupKey
  });
  envUpdates[price.envName] = stripePrice.id;
  console.log(`${price.envName}=${stripePrice.id}`);
}

const meterIds = new Map<string, string>();
for (const meter of usageMeters) {
  const eventName = stripeMeterEventNames[meter];
  const existing = await stripe.billing.meters.list({ status: "active", limit: 100 });
  const meterObject = existing.data.find((entry) => entry.event_name === eventName) ?? await stripe.billing.meters.create({
    display_name: `Barkan ${meter.replace(/_/g, " ")}`,
    event_name: eventName,
    default_aggregation: { formula: "sum" },
    customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
    value_settings: { event_payload_key: "value" }
  });
  meterIds.set(meter, meterObject.id);
  console.log(`METER_${meter.toUpperCase()}=${meterObject.id}`);
}

for (const meter of usageMeters) {
  const lookupKey = `barkan_overage_${meter}`;
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
  const stripePrice = existing.data[0] ?? await stripe.prices.create({
    product: productIds.get("barkan_usage_overage")!,
    currency: "eur",
    unit_amount: overageUnitAmounts[meter],
    lookup_key: lookupKey,
    recurring: { interval: "month", usage_type: "metered", meter: meterIds.get(meter)! }
  });
  envUpdates[overageEnvNames[meter]] = stripePrice.id;
  console.log(`OVERAGE_PRICE_${meter.toUpperCase()}=${stripePrice.id}`);
}

if (writeEnv) {
  const envPath = path.resolve(process.cwd(), "../../.env");
  await upsertEnvFile(envPath, envUpdates);
  console.log(`Updated ${envPath}`);
}

async function upsertEnvFile(envPath: string, updates: Record<string, string>): Promise<void> {
  let content = "";
  try {
    content = await readFile(envPath, "utf8");
  } catch {
    content = "";
  }

  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    content = pattern.test(content)
      ? content.replace(pattern, line)
      : `${content.replace(/\s*$/, "\n")}${line}\n`;
  }
  await writeFile(envPath, content);
}
