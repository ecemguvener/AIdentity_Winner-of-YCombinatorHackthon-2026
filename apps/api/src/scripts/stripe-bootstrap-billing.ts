import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { getStripeClient } from "../providers/stripe-client.js";

const products = [
  { key: "barkan_pro", name: "Barkan Pro" },
  { key: "barkan_scale", name: "Barkan Scale" }
];

const prices = [
  { lookupKey: "barkan_pro_monthly", productKey: "barkan_pro", unitAmount: 2900, envName: "BILLING_PRICE_PRO" },
  { lookupKey: "barkan_scale_monthly", productKey: "barkan_scale", unitAmount: 9900, envName: "BILLING_PRICE_SCALE" }
];

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
