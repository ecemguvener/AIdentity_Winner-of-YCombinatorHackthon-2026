import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { Collections } from "./db.js";
import { ApiError } from "./errors.js";

type DeepHealth = {
  ok: boolean;
  cached: boolean;
  checkedAt: string;
  providers: Record<string, { ok: boolean; mode: string; detail?: string }>;
};

let cachedDeepHealth: { expiresAt: number; value: DeepHealth } | null = null;

export function registerHealthRoutes(app: FastifyInstance, collections: Collections, config: AppConfig): void {
  app.get("/api/health", async () => {
    const mongo = await mongoPing(collections);
    return { ok: mongo === "ok", mongo, uptime: process.uptime() };
  });

  app.get("/internal/health/deep", async (request) => {
    if (!isInternalIp(request.ip)) {
      throw new ApiError(403, "forbidden", "internal route");
    }
    return getDeepHealth(config);
  });
}

export async function getDeepHealth(config: AppConfig, now = Date.now()): Promise<DeepHealth> {
  if (cachedDeepHealth && cachedDeepHealth.expiresAt > now) {
    return { ...cachedDeepHealth.value, cached: true };
  }
  const stripeMode = config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET ? "live" : "mock";
  const providers = Object.fromEntries(await Promise.all([
    providerCheck("stripe", stripeMode, stripeMode === "mock" || Boolean(config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET)),
    providerCheck("twilio", config.PROVIDER_MODE_PHONE, config.PROVIDER_MODE_PHONE === "mock" || Boolean(config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN)),
    providerCheck("resend", config.PROVIDER_MODE_EMAIL, config.PROVIDER_MODE_EMAIL === "mock" || Boolean(config.RESEND_API_KEY)),
    providerCheck("elevenlabs", config.PROVIDER_MODE_PHONE, config.PROVIDER_MODE_PHONE === "mock" || Boolean(config.ELEVENLABS_API_KEY && config.ELEVENLABS_AGENT_ID)),
    providerCheck("openai", config.OPENAI_API_KEY ? "live" : "mock", true)
  ]));
  const value = {
    ok: Object.values(providers).every((provider) => provider.ok),
    cached: false,
    checkedAt: new Date(now).toISOString(),
    providers
  };
  cachedDeepHealth = { expiresAt: now + 60_000, value };
  return value;
}

async function mongoPing(collections: Collections): Promise<"ok" | "error"> {
  try {
    await collections.users.findOne({}, { projection: { _id: 1 } });
    return "ok";
  } catch {
    return "error";
  }
}

async function providerCheck(name: string, mode: string, configured: boolean): Promise<[string, { ok: boolean; mode: string; detail?: string }]> {
  await Promise.resolve();
  return [name, configured ? { ok: true, mode } : { ok: false, mode, detail: "missing configuration" }];
}

function isInternalIp(value: string): boolean {
  const ip = value.replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("10.") || ip.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}
