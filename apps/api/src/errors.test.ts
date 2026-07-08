import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import type { Collections } from "./db.js";

const baseConfig: AppConfig = {
  NODE_ENV: "test",
  API_PORT: 4000,
  PUBLIC_APP_URL: "http://localhost:5173",
  PUBLIC_API_URL: "http://localhost:4000",
  MONGODB_URI: "mongodb://127.0.0.1:27017/barkan-test",
  SESSION_COOKIE_NAME: "barkan_session",
  SESSION_SECRET: "test-barkan-session-secret",
  PROVIDER_MODE_EMAIL: "mock",
  PROVIDER_MODE_PHONE: "mock",
  TWILIO_NUMBER_COUNTRY: "US",
  ELEVENLABS_VOICE_ID: "voice_test",
  OPENAI_DASHBOARD_CHAT_MODEL: "gpt-test",
  EMAIL_AGENT_DOMAIN: "agents.barkan.dev",
  EMAIL_PLATFORM_FROM: "Barkan <no-reply@barkan.dev>",
  API_RATE_LIMIT_MAX: 1_000
};

describe("API error contract", () => {
  it("echoes x-request-id on success", async () => {
    const app = await buildApp(baseConfig, createCollections());

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toMatch(/^[a-f0-9]{16}$/);
    await app.close();
  });

  it("maps zod failures to machine-readable validation errors", async () => {
    const app = await buildApp(baseConfig, createCollections());

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/check-email",
      payload: {}
    });
    const body = response.json();

    expect(response.statusCode).toBe(400);
    expect(response.headers["x-request-id"]).toBe(body.error.requestId);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.message).toBe("invalid request");
    expect(body.error.details).toBeDefined();
    expect(body.message).toBe("invalid request");
    await app.close();
  });

  it("hides unknown server errors", async () => {
    const app = await buildApp(baseConfig, createCollections());
    app.get("/__test/boom", async () => {
      throw new Error("database password leaked");
    });

    const response = await app.inject({ method: "GET", url: "/__test/boom" });
    const body = response.json();

    expect(response.statusCode).toBe(500);
    expect(body.error).toMatchObject({
      code: "internal",
      message: "internal server error",
      requestId: response.headers["x-request-id"]
    });
    expect(JSON.stringify(body)).not.toContain("database password leaked");
    await app.close();
  });

  it("wraps legacy route errors into the unified shape", async () => {
    const app = await buildApp(baseConfig, createCollections());

    const response = await app.inject({ method: "GET", url: "/api/auth/me" });
    const body = response.json();

    expect(response.statusCode).toBe(401);
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.requestId).toBe(response.headers["x-request-id"]);
    expect(body.message).toBe("authentication required");
    expect(body.legacyError).toBe("authentication required");
    await app.close();
  });
});

describe("rate limits", () => {
  it("limits auth routes to 10 requests per minute per IP", async () => {
    const app = await buildApp({ ...baseConfig, API_RATE_LIMIT_MAX: 10 }, createCollections());

    for (let index = 0; index < 10; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "x@x.co", password: "wrong-password" }
      });
      expect(response.statusCode).toBe(401);
    }

    const limited = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "x@x.co", password: "wrong-password" }
    });
    const body = limited.json();

    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.requestId).toBe(limited.headers["x-request-id"]);
    await app.close();
  });

  it("limits agent routes by bearer token, with independent buckets", async () => {
    const app = await buildApp(baseConfig, createCollections());

    for (let index = 0; index < 60; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/identity/revoke",
        headers: { authorization: "Bearer token-one" }
      });
      expect(response.statusCode).toBe(401);
    }

    const limited = await app.inject({
      method: "POST",
      url: "/api/identity/revoke",
      headers: { authorization: "Bearer token-one" }
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("rate_limited");

    const otherToken = await app.inject({
      method: "POST",
      url: "/api/identity/revoke",
      headers: { authorization: "Bearer token-two" }
    });
    expect(otherToken.statusCode).toBe(401);
    await app.close();
  });
});

function createCollections(): Collections {
  return {
    users: {
      findOne: async () => null
    },
    sessions: {
      findOne: async () => null
    },
    identityTokens: {
      findOne: async () => null,
      updateOne: async () => ({ matchedCount: 0, modifiedCount: 0 })
    },
    agents: {
      findOne: async () => null,
      insertOne: async () => ({ insertedId: new ObjectId() })
    },
    policies: {
      insertOne: async () => ({ insertedId: new ObjectId() })
    },
    auditLogs: {
      insertOne: async () => ({ insertedId: new ObjectId() })
    }
  } as unknown as Collections;
}
