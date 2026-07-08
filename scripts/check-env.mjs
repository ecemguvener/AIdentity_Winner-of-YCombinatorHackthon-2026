#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const baseRequiredKeys = [
  "NODE_ENV",
  "API_PORT",
  "PUBLIC_APP_URL",
  "PUBLIC_API_URL",
  "MONGODB_URI",
  "SESSION_COOKIE_NAME",
  "SESSION_SECRET",
  "API_RATE_LIMIT_MAX",
  "ACCOUNT_EXPORT_DIR"
];

const productionRequiredKeys = [
  "SENTRY_DSN",
  "ALERT_WEBHOOK_URL",
  "OPENAI_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "BILLING_PRICE_PRO",
  "BILLING_PRICE_SCALE",
  "BILLING_PRICE_OVERAGE_EMAILS",
  "BILLING_PRICE_OVERAGE_CALL_MINUTES",
  "BILLING_PRICE_OVERAGE_SMS",
  "BILLING_PRICE_OVERAGE_ACTIVE_NUMBERS",
  "EMAIL_PLATFORM_FROM",
  "ELEVENLABS_VOICE_ID",
  "CALL_COST_CENTS_PER_MINUTE",
  "BACKUP_DIR"
];

const liveEmailRequiredKeys = ["RESEND_API_KEY", "EMAIL_AGENT_DOMAIN", "RESEND_WEBHOOK_SECRET"];
const livePhoneRequiredKeys = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_NUMBER_COUNTRY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_AGENT_ID",
  "ELEVENLABS_WORKSPACE_WEBHOOK_SECRET"
];

const exampleExtraKeys = new Set([
  "BACKUP_DIR",
  "BACKUP_REMOTE",
  "BARKAN_DEPLOY_ROOT",
  "BARKAN_STAGING_DEPLOY_ROOT",
  "VITE_SENTRY_DSN",
  "VITE_SENTRY_RELEASE"
]);

export function parseEnv(content) {
  const env = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function validateEnvFile({ target, filePath }) {
  const env = parseEnv(fs.readFileSync(filePath, "utf8"));
  const missing = new Set();
  for (const key of baseRequiredKeys) {
    if (!env[key]) missing.add(key);
  }
  if (target === "production") {
    for (const key of productionRequiredKeys) {
      if (!env[key]) missing.add(key);
    }
    if (env.NODE_ENV !== "production") {
      missing.add("NODE_ENV=production");
    }
  }
  if (env.PROVIDER_MODE_EMAIL === "live") {
    for (const key of liveEmailRequiredKeys) {
      if (!env[key]) missing.add(key);
    }
  }
  if (env.PROVIDER_MODE_PHONE === "live") {
    for (const key of livePhoneRequiredKeys) {
      if (!env[key]) missing.add(key);
    }
  }

  const errors = [];
  if (missing.size > 0) {
    errors.push(`missing: ${[...missing].sort().join(", ")}`);
  }
  errors.push(...validateUrls(env, target));
  errors.push(...validateMongo(env, target));
  return { ok: errors.length === 0, errors, env };
}

export function validateExampleSync({
  examplePath = path.resolve(process.cwd(), ".env.example"),
  configPath = path.resolve(process.cwd(), "apps/api/src/config.ts")
} = {}) {
  const exampleKeys = new Set(Object.keys(parseEnv(fs.readFileSync(examplePath, "utf8"))));
  const configKeys = readRawEnvironmentSchemaKeys(fs.readFileSync(configPath, "utf8"));
  const allowedKeys = new Set([...configKeys, ...exampleExtraKeys]);
  const missing = [...configKeys].filter((key) => !exampleKeys.has(key)).sort();
  const extra = [...exampleKeys].filter((key) => !allowedKeys.has(key)).sort();
  const errors = [];
  if (missing.length > 0) errors.push(`missing from .env.example: ${missing.join(", ")}`);
  if (extra.length > 0) errors.push(`extra in .env.example: ${extra.join(", ")}`);
  return { ok: errors.length === 0, errors, configKeys: [...configKeys].sort(), exampleKeys: [...exampleKeys].sort() };
}

function readRawEnvironmentSchemaKeys(configSource) {
  const match = configSource.match(/const rawEnvironmentSchema = z\.object\(\{([\s\S]*?)^\}\);/m);
  if (!match) {
    throw new Error("Could not read rawEnvironmentSchema keys from apps/api/src/config.ts");
  }

  const keys = new Set();
  for (const line of match[1].split(/\r?\n/)) {
    const keyMatch = line.match(/^\s{2}([A-Z0-9_]+):/);
    if (keyMatch) {
      keys.add(keyMatch[1]);
    }
  }
  return keys;
}

function validateUrls(env, target) {
  const errors = [];
  for (const key of ["PUBLIC_APP_URL", "PUBLIC_API_URL"]) {
    if (!env[key]) continue;
    try {
      const url = new URL(env[key]);
      if (target === "production" && url.protocol !== "https:") {
        errors.push(`${key} must use https in production`);
      }
    } catch {
      errors.push(`${key} must be a valid URL`);
    }
  }
  return errors;
}

function validateMongo(env, target) {
  if (!env.MONGODB_URI) return [];
  const databaseName = readMongoDatabaseName(env.MONGODB_URI);
  if (!databaseName) return ["MONGODB_URI must include a database name"];
  if (target === "production" && !databaseName.endsWith("-prod")) {
    return ["production MONGODB_URI database must end in -prod"];
  }
  if (target === "staging" && databaseName.endsWith("-prod")) {
    return ["staging MONGODB_URI database must not end in -prod"];
  }
  return [];
}

function readMongoDatabaseName(mongodbUri) {
  try {
    return new URL(mongodbUri).pathname.replace(/^\/+/, "");
  } catch {
    const queryIndex = mongodbUri.indexOf("?");
    const withoutQuery = queryIndex === -1 ? mongodbUri : mongodbUri.slice(0, queryIndex);
    const schemeEnd = withoutQuery.indexOf("://");
    if (schemeEnd === -1) return "";
    const pathStart = withoutQuery.indexOf("/", schemeEnd + 3);
    return pathStart === -1 ? "" : withoutQuery.slice(pathStart + 1);
  }
}

function parseArgs(argv) {
  const parsed = { target: "production", filePath: "", exampleSync: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--example-sync") {
      parsed.exampleSync = true;
    } else if (value === "--env") {
      parsed.target = argv[++index] ?? parsed.target;
    } else if (value === "--file") {
      parsed.filePath = argv[++index] ?? "";
    }
  }
  if (!["production", "staging"].includes(parsed.target)) {
    throw new Error("--env must be production or staging");
  }
  parsed.filePath ||= path.resolve(process.cwd(), `.env.${parsed.target}`);
  return parsed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { target, filePath, exampleSync } = parseArgs(process.argv.slice(2));
    if (exampleSync) {
      const result = validateExampleSync();
      if (!result.ok) {
        console.error("env example sync failed");
        for (const error of result.errors) console.error(`- ${error}`);
        process.exit(1);
      }
      console.log("env example sync passed");
      process.exit(0);
    }

    const result = validateEnvFile({ target, filePath });
    if (!result.ok) {
      console.error(`env check failed for ${target} (${filePath})`);
      for (const error of result.errors) console.error(`- ${error}`);
      process.exit(1);
    }
    console.log(`env check passed for ${target} (${filePath})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
