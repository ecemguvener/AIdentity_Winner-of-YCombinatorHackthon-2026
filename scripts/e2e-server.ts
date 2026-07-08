import { spawn, type ChildProcess } from "node:child_process";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { buildApp } from "../apps/api/src/app.js";
import type { AppConfig } from "../apps/api/src/config.js";
import { connectDatabase, type Database } from "../apps/api/src/db.js";
import { setStripeClientForTest, type Stripe } from "../apps/api/src/providers/stripe-client.js";

const apiPort = Number(process.env.E2E_API_PORT ?? 4101);
const webPort = Number(process.env.E2E_WEB_PORT ?? 4899);
const publicApiUrl = `http://127.0.0.1:${apiPort}`;
const publicAppUrl = `http://127.0.0.1:${webPort}`;

const config = {
  NODE_ENV: "test",
  API_PORT: apiPort,
  PUBLIC_APP_URL: publicAppUrl,
  PUBLIC_API_URL: publicApiUrl,
  MONGODB_URI: "set-by-replset",
  SESSION_COOKIE_NAME: "barkan_session",
  SESSION_SECRET: "e2e-session-secret",
  PROVIDER_MODE_EMAIL: "mock",
  PROVIDER_MODE_PHONE: "mock",
  STRIPE_SECRET_KEY: "sk_test_e2e",
  STRIPE_WEBHOOK_SECRET: "whsec_e2e",
  BILLING_PRICE_PRO: "price_pro",
  BILLING_PRICE_SCALE: "price_scale",
  TWILIO_NUMBER_COUNTRY: "US",
  ELEVENLABS_VOICE_ID: "voice",
  CALL_COST_CENTS_PER_MINUTE: 15,
  OPENAI_DASHBOARD_CHAT_MODEL: "gpt-5.4-2026-03-05",
  EMAIL_AGENT_DOMAIN: "agents.barkan.dev",
  EMAIL_PLATFORM_FROM: "Barkan <no-reply@barkan.dev>",
  API_RATE_LIMIT_MAX: 1000
} as unknown as AppConfig;

let replSet: MongoMemoryReplSet | null = null;
let database: Database | null = null;
let app: Awaited<ReturnType<typeof buildApp>> | null = null;
let web: ChildProcess | null = null;

async function main() {
  setStripeClientForTest({
    customers: { create: async () => ({ id: "cus_e2e" }) },
    checkout: { sessions: { create: async () => ({ url: "https://billing.example.test/checkout" }) } },
    billingPortal: { sessions: { create: async () => ({ url: "https://billing.example.test/portal" }) } },
    billing: { meterEvents: { create: async () => ({}) } }
  } as unknown as Stripe);
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  (config as { MONGODB_URI: string }).MONGODB_URI = replSet.getUri("barkan-ui-e2e");
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);
  await app.listen({ host: "127.0.0.1", port: apiPort });

  web = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", String(webPort)], {
    cwd: "apps/web",
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_API_URL: publicApiUrl,
      VITE_API_PORT: String(apiPort)
    }
  });
  web.on("exit", (code) => {
    if (code !== null && code !== 0) process.exit(code);
  });
}

async function shutdown() {
  web?.kill();
  await app?.close();
  await database?.client.close();
  await replSet?.stop();
  setStripeClientForTest(null);
}

process.on("SIGINT", () => void shutdown().finally(() => process.exit(130)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(143)));

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
