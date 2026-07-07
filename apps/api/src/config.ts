import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { z, ZodError } from "zod";

loadDotenv({ path: path.resolve(process.cwd(), ".env") });
loadDotenv({ path: path.resolve(process.cwd(), "../../.env") });

const optionalNonEmptyStringSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}, z.string().min(1).optional());

const providerModeSchema = z.enum(["live", "mock"]);

const rawEnvironmentSchema = z.object({
  NODE_ENV: z.string().default("development"),
  API_PORT: z.coerce.number().default(4000),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:5173"),
  PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
  MONGODB_URI: z.string().min(1).default("mongodb://127.0.0.1:27017/barkan"),
  SESSION_COOKIE_NAME: z.string().min(1).default("barkan_session"),
  SESSION_SECRET: z.string().min(16).default("dev-barkan-session-secret-change-me"),
  PROVIDER_MODE_EMAIL: providerModeSchema.default("mock"),
  PROVIDER_MODE_PHONE: providerModeSchema.default("mock"),
  STRIPE_SECRET_KEY: optionalNonEmptyStringSchema,
  STRIPE_WEBHOOK_SECRET: optionalNonEmptyStringSchema,
  TWILIO_ACCOUNT_SID: optionalNonEmptyStringSchema,
  TWILIO_AUTH_TOKEN: optionalNonEmptyStringSchema,
  TWILIO_NUMBER_COUNTRY: z.string().min(1).default("US"),
  TWILIO_ADDRESS_SID: optionalNonEmptyStringSchema,
  ELEVENLABS_API_KEY: optionalNonEmptyStringSchema,
  ELEVENLABS_AGENT_ID: optionalNonEmptyStringSchema,
  ELEVENLABS_AGENT_PHONE_NUMBER_ID: optionalNonEmptyStringSchema,
  ELEVENLABS_VOICE_ID: z.string().min(1).default("kPzsL2i3teMYv0FxEYQ6"),
  ELEVENLABS_WORKSPACE_WEBHOOK_SECRET: optionalNonEmptyStringSchema,
  OPENAI_API_KEY: optionalNonEmptyStringSchema,
  OPENAI_DASHBOARD_CHAT_MODEL: z.string().min(1).default("gpt-5.4-2026-03-05").transform(normalizeConfiguredOpenAIModel),
  RESEND_API_KEY: optionalNonEmptyStringSchema,
  EMAIL_AGENT_DOMAIN: optionalNonEmptyStringSchema,
  EMAIL_FROM_DOMAIN: optionalNonEmptyStringSchema,
  EMAIL_PLATFORM_FROM: z.string().min(1).default("Barkan <no-reply@barkan.dev>"),
  RESEND_WEBHOOK_SECRET: optionalNonEmptyStringSchema,
  EMAIL_WEBHOOK_SECRET: optionalNonEmptyStringSchema,
  // Sandbox redirect: before a sending domain is verified, Resend only allows
  // sending from onboarding@resend.dev to the account owner. When this is set,
  // every outbound email is really delivered to this address (from Resend's
  // test sender), so the app sends real mail you can see. The activity log
  // still records the originally-intended recipient.
  EMAIL_SANDBOX_REDIRECT_TO: optionalNonEmptyStringSchema,
  SENTRY_DSN: optionalNonEmptyStringSchema,
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300)
});

const environmentSchema = rawEnvironmentSchema.transform((environment) => {
  const emailAgentDomain = environment.EMAIL_AGENT_DOMAIN ?? environment.EMAIL_FROM_DOMAIN ?? "agents.barkan.dev";
  const resendWebhookSecret = environment.RESEND_WEBHOOK_SECRET ?? environment.EMAIL_WEBHOOK_SECRET;
  if (!environment.EMAIL_AGENT_DOMAIN && environment.EMAIL_FROM_DOMAIN) {
    console.warn("EMAIL_FROM_DOMAIN is deprecated. Use EMAIL_AGENT_DOMAIN instead.");
  }
  if (!environment.RESEND_WEBHOOK_SECRET && environment.EMAIL_WEBHOOK_SECRET) {
    console.warn("EMAIL_WEBHOOK_SECRET is deprecated. Use RESEND_WEBHOOK_SECRET instead.");
  }

  return {
    ...environment,
    EMAIL_AGENT_DOMAIN: emailAgentDomain,
    RESEND_WEBHOOK_SECRET: resendWebhookSecret,
    MONGODB_URI: normalizeMongoUriForEnvironment(
      normalizeLegacyMongoDatabaseName(environment.MONGODB_URI),
      environment.NODE_ENV
    ),
    PUBLIC_API_URL: normalizePublicApiUrlForEnvironment(environment.PUBLIC_API_URL, environment.NODE_ENV)
  };
}).superRefine((environment, context) => {
  if (environment.PROVIDER_MODE_PHONE === "live") {
    addMissingVarsIssue(context, "PROVIDER_MODE_PHONE=live", environment, [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "ELEVENLABS_API_KEY",
      "ELEVENLABS_AGENT_ID"
    ]);
  }

  if (environment.PROVIDER_MODE_EMAIL === "live") {
    addMissingVarsIssue(context, "PROVIDER_MODE_EMAIL=live", environment, [
      "RESEND_API_KEY",
      "EMAIL_AGENT_DOMAIN"
    ]);
  }
});

export type AppConfig = z.infer<typeof environmentSchema>;
export type ProviderMode = AppConfig["PROVIDER_MODE_EMAIL"];

export function loadConfig(): AppConfig {
  try {
    return environmentSchema.parse(process.env);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(formatConfigError(error));
    }
    throw error;
  }
}

function addMissingVarsIssue(
  context: z.RefinementCtx,
  modeLabel: string,
  environment: AppConfig,
  varNames: Array<keyof AppConfig>
): void {
  const missingVars = varNames.filter((varName) => !environment[varName]);
  if (missingVars.length === 0) {
    return;
  }

  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: `${modeLabel} requires missing env vars: ${missingVars.join(", ")}`
  });
}

function formatConfigError(error: ZodError): string {
  const messages = error.issues.map((issue) => issue.message);
  return `Invalid API configuration: ${messages.join("; ")}`;
}

function normalizeConfiguredOpenAIModel(model: string): string {
  const normalized = model.trim();
  if (/^gpt-5\.4-mini$/i.test(normalized)) {
    return "gpt-5.4-mini-2026-03-17";
  }

  if (/^gpt-5\.4-mini-\d{4}-\d{2}-\d{2}$/i.test(normalized) && normalized !== "gpt-5.4-mini-2026-03-17") {
    return "gpt-5.4-2026-03-05";
  }

  return normalized;
}

function normalizePublicApiUrlForEnvironment(publicApiUrl: string, nodeEnv: string): string {
  const normalizedUrl = publicApiUrl.trim().replace(/\/$/, "");
  if (nodeEnv !== "production") {
    return normalizedUrl;
  }

  const parsedUrl = new URL(normalizedUrl);
  if (parsedUrl.protocol === "https:" || isLoopbackHostname(parsedUrl.hostname)) {
    return normalizedUrl;
  }

  throw new Error("PUBLIC_API_URL must use HTTPS in production unless it points to localhost.");
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function normalizeMongoUriForEnvironment(mongodbUri: string, nodeEnv: string): string {
  const mongodbUriWithDefaultDatabase = ensureMongoDatabaseName(mongodbUri, "barkan");
  if (nodeEnv !== "production") {
    return mongodbUriWithDefaultDatabase;
  }

  return ensureProductionMongoDatabaseName(mongodbUriWithDefaultDatabase);
}

function normalizeLegacyMongoDatabaseName(mongodbUri: string): string {
  return replaceMongoDatabaseName(mongodbUri, (databaseName) => {
    if (databaseName === "aidentity-web") {
      return "aidentity";
    }

    if (databaseName === "aidentity-web-prod") {
      return "aidentity-prod";
    }

    return databaseName;
  });
}

function ensureProductionMongoDatabaseName(mongodbUri: string): string {
  const defaultDatabaseName = "barkan-prod";

  try {
    const parsedUri = new URL(mongodbUri);
    const databaseName = parsedUri.pathname.replace(/^\/+/, "");
    if (!databaseName) {
      parsedUri.pathname = `/${defaultDatabaseName}`;
      return parsedUri.toString();
    }

    if (databaseName.endsWith("-prod")) {
      return mongodbUri;
    }

    parsedUri.pathname = `/${databaseName}-prod`;
    return parsedUri.toString();
  } catch {
    const queryIndex = mongodbUri.indexOf("?");
    const uriWithoutQuery = queryIndex === -1 ? mongodbUri : mongodbUri.slice(0, queryIndex);
    const query = queryIndex === -1 ? "" : mongodbUri.slice(queryIndex);
    const schemeEndIndex = uriWithoutQuery.indexOf("://");
    if (schemeEndIndex === -1) {
      return mongodbUri;
    }

    const pathStartIndex = uriWithoutQuery.indexOf("/", schemeEndIndex + 3);
    if (pathStartIndex === -1) {
      return `${uriWithoutQuery}/${defaultDatabaseName}${query}`;
    }

    const databaseName = uriWithoutQuery.slice(pathStartIndex + 1);
    if (!databaseName) {
      return `${uriWithoutQuery}${defaultDatabaseName}${query}`;
    }

    if (databaseName.endsWith("-prod")) {
      return mongodbUri;
    }

    return `${uriWithoutQuery.slice(0, pathStartIndex + 1)}${databaseName}-prod${query}`;
  }
}

function ensureMongoDatabaseName(mongodbUri: string, defaultDatabaseName: string): string {
  try {
    const parsedUri = new URL(mongodbUri);
    const databaseName = parsedUri.pathname.replace(/^\/+/, "");
    if (databaseName) {
      return mongodbUri;
    }

    parsedUri.pathname = `/${defaultDatabaseName}`;
    return parsedUri.toString();
  } catch {
    const queryIndex = mongodbUri.indexOf("?");
    const uriWithoutQuery = queryIndex === -1 ? mongodbUri : mongodbUri.slice(0, queryIndex);
    const query = queryIndex === -1 ? "" : mongodbUri.slice(queryIndex);
    const schemeEndIndex = uriWithoutQuery.indexOf("://");
    if (schemeEndIndex === -1) {
      return mongodbUri;
    }

    const pathStartIndex = uriWithoutQuery.indexOf("/", schemeEndIndex + 3);
    if (pathStartIndex === -1) {
      return `${uriWithoutQuery}/${defaultDatabaseName}${query}`;
    }

    const databaseName = uriWithoutQuery.slice(pathStartIndex + 1);
    if (databaseName) {
      return mongodbUri;
    }

    return `${uriWithoutQuery}${defaultDatabaseName}${query}`;
  }
}

function replaceMongoDatabaseName(
  mongodbUri: string,
  replaceDatabaseName: (databaseName: string) => string
): string {
  try {
    const parsedUri = new URL(mongodbUri);
    const databaseName = parsedUri.pathname.replace(/^\/+/, "");
    if (!databaseName) {
      return mongodbUri;
    }

    const replacementDatabaseName = replaceDatabaseName(databaseName);
    if (replacementDatabaseName === databaseName) {
      return mongodbUri;
    }

    parsedUri.pathname = `/${replacementDatabaseName}`;
    return parsedUri.toString();
  } catch {
    const queryIndex = mongodbUri.indexOf("?");
    const uriWithoutQuery = queryIndex === -1 ? mongodbUri : mongodbUri.slice(0, queryIndex);
    const query = queryIndex === -1 ? "" : mongodbUri.slice(queryIndex);
    const schemeEndIndex = uriWithoutQuery.indexOf("://");
    if (schemeEndIndex === -1) {
      return mongodbUri;
    }

    const pathStartIndex = uriWithoutQuery.indexOf("/", schemeEndIndex + 3);
    if (pathStartIndex === -1) {
      return mongodbUri;
    }

    const databaseName = uriWithoutQuery.slice(pathStartIndex + 1);
    if (!databaseName) {
      return mongodbUri;
    }

    const replacementDatabaseName = replaceDatabaseName(databaseName);
    if (replacementDatabaseName === databaseName) {
      return mongodbUri;
    }

    return `${uriWithoutQuery.slice(0, pathStartIndex + 1)}${replacementDatabaseName}${query}`;
  }
}
