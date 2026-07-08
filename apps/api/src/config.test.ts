import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const originalEnvironment = { ...process.env };

describe("loadConfig", () => {
  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    replaceEnvironment(originalEnvironment);
  });

  it("uses the configured dated model for dashboard chat by default", () => {
    delete process.env.OPENAI_DASHBOARD_CHAT_MODEL;

    const config = loadConfig();

    expect(config.OPENAI_DASHBOARD_CHAT_MODEL).toBe("gpt-5.4-2026-03-05");
  });

  it("normalizes undated and stale mini model overrides", () => {
    const undatedMiniModel = ["gpt", "5.4", "mini"].join("-");
    process.env.OPENAI_DASHBOARD_CHAT_MODEL = undatedMiniModel;

    const config = loadConfig();

    expect(config.OPENAI_DASHBOARD_CHAT_MODEL).toBe("gpt-5.4-mini-2026-03-17");
  });

  it("keeps the configured MongoDB database name outside production", () => {
    process.env.NODE_ENV = "development";
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/barkan";

    expect(loadConfig().MONGODB_URI).toBe("mongodb://127.0.0.1:27017/barkan");
  });

  it("uses barkan when a MongoDB URI has no database name", () => {
    process.env.NODE_ENV = "development";
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017";

    expect(loadConfig().MONGODB_URI).toBe("mongodb://127.0.0.1:27017/barkan");
  });

  it("appends the production suffix to the MongoDB database name", () => {
    process.env.NODE_ENV = "production";
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/barkan";
    process.env.PUBLIC_API_URL = "http://localhost:4000";

    expect(loadConfig().MONGODB_URI).toBe("mongodb://127.0.0.1:27017/barkan-prod");
  });

  it("does not duplicate the production suffix", () => {
    process.env.NODE_ENV = "production";
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/barkan-prod";
    process.env.PUBLIC_API_URL = "http://localhost:4000";

    expect(loadConfig().MONGODB_URI).toBe("mongodb://127.0.0.1:27017/barkan-prod");
  });

  it("requires HTTPS for non-local production API URLs", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_API_URL = "http://100.81.152.74:4001";

    expect(() => loadConfig()).toThrow("PUBLIC_API_URL must use HTTPS");
  });

  it("keeps localhost HTTP API URLs available for local production-style runs", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_API_URL = "http://localhost:4001/";

    expect(loadConfig().PUBLIC_API_URL).toBe("http://localhost:4001");
  });

  it("treats empty vendor API keys as unset", () => {
    process.env.OPENAI_API_KEY = "   ";
    process.env.ELEVENLABS_API_KEY = "";

    const config = loadConfig();

    expect(config.OPENAI_API_KEY).toBeUndefined();
    expect(config.ELEVENLABS_API_KEY).toBeUndefined();
  });

  it("defaults capability provider modes to mock", () => {
    const config = loadConfig();

    expect(config.PROVIDER_MODE_EMAIL).toBe("mock");
    expect(config.PROVIDER_MODE_PHONE).toBe("mock");
    expect(config.EMAIL_AGENT_DOMAIN).toBe("agents.barkan.dev");
    expect(config.EMAIL_PLATFORM_FROM).toBe("Barkan <no-reply@barkan.dev>");
    expect(config.TWILIO_NUMBER_COUNTRY).toBe("US");
    expect(config.OPENAI_EMAIL_MODEL).toBe("gpt-4o-mini");
    expect(config.API_RATE_LIMIT_MAX).toBe(300);
  });

  it("fails fast when live phone mode is missing required provider vars", () => {
    process.env.PROVIDER_MODE_PHONE = "live";

    expect(() => loadConfig()).toThrow(/TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID/);
  });

  it("accepts live phone mode when required provider vars are set", () => {
    process.env.PROVIDER_MODE_PHONE = "live";
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    process.env.TWILIO_AUTH_TOKEN = "twilio-token";
    process.env.ELEVENLABS_API_KEY = "elevenlabs-key";
    process.env.ELEVENLABS_AGENT_ID = "agent_test";

    expect(loadConfig().PROVIDER_MODE_PHONE).toBe("live");
  });

  it("fails fast when live email mode is missing Resend credentials", () => {
    process.env.PROVIDER_MODE_EMAIL = "live";

    expect(() => loadConfig()).toThrow(/RESEND_API_KEY/);
  });

  it("accepts live email mode when required provider vars are set", () => {
    process.env.PROVIDER_MODE_EMAIL = "live";
    process.env.RESEND_API_KEY = "resend-key";
    process.env.EMAIL_AGENT_DOMAIN = "agents.example.test";

    const config = loadConfig();

    expect(config.PROVIDER_MODE_EMAIL).toBe("live");
    expect(config.EMAIL_AGENT_DOMAIN).toBe("agents.example.test");
  });

  it("rejects removed email env aliases", () => {
    process.env[["EMAIL", "FROM", "DOMAIN"].join("_")] = "removed.example.test";
    process.env[["EMAIL", "WEBHOOK", "SECRET"].join("_")] = "removed-webhook-secret";

    expect(() => loadConfig()).toThrow(
      new RegExp(`removed env vars present: ${["EMAIL", "FROM", "DOMAIN"].join("_")}, ${["EMAIL", "WEBHOOK", "SECRET"].join("_")}`)
    );
  });

  it("rejects removed brand-prefixed env aliases", () => {
    process.env[["A", "IDENTITY_PUBLIC_HOST"].join("")] = "127.0.0.1";

    expect(() => loadConfig()).toThrow(new RegExp(`removed env vars present: ${["A", "IDENTITY_PUBLIC_HOST"].join("")}`));
  });

  it("uses current email env names", () => {
    process.env.EMAIL_AGENT_DOMAIN = "agents.new.test";
    process.env.RESEND_WEBHOOK_SECRET = "new-webhook-secret";

    const config = loadConfig();

    expect(config.EMAIL_AGENT_DOMAIN).toBe("agents.new.test");
    expect(config.RESEND_WEBHOOK_SECRET).toBe("new-webhook-secret");
  });
});

function replaceEnvironment(nextEnvironment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, nextEnvironment);
}
