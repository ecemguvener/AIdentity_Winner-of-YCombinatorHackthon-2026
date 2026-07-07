import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import type { Collections } from "./db.js";
import { agentOpenApiOperations } from "./openapi.js";

const config = {
  NODE_ENV: "test",
  API_PORT: 0,
  PUBLIC_APP_URL: "http://localhost:4888",
  PUBLIC_API_URL: "http://localhost:4001",
  MONGODB_URI: "mongodb://127.0.0.1:27017/barkan-openapi-test",
  SESSION_COOKIE_NAME: "barkan_session",
  SESSION_SECRET: "test-barkan-session-secret",
  PROVIDER_MODE_EMAIL: "mock",
  PROVIDER_MODE_PHONE: "mock",
  TWILIO_NUMBER_COUNTRY: "US",
  ELEVENLABS_VOICE_ID: "voice",
  OPENAI_DASHBOARD_CHAT_MODEL: "gpt-5.4-2026-03-05",
  EMAIL_AGENT_DOMAIN: "agents.barkan.dev",
  EMAIL_PLATFORM_FROM: "Barkan <no-reply@barkan.dev>",
  API_RATE_LIMIT_MAX: 1000
} as unknown as AppConfig;

const agentRoutes = [
  "POST /api/v1/agent/email/send",
  "GET /api/v1/agent/email/threads",
  "GET /api/v1/agent/email/address",
  "GET /api/v1/agent/email/threads/:threadId",
  "POST /api/v1/agent/email/threads/:threadId/reply",
  "GET /api/v1/agent/email/threads/:threadId/attachments/:attachmentId",
  "GET /api/v1/agent/approvals/:id",
  "POST /api/v1/agent/phone/call",
  "GET /api/v1/agent/phone/calls",
  "GET /api/v1/agent/phone/number",
  "GET /api/v1/agent/phone/calls/:callId",
  "POST /api/v1/agent/phone/sms",
  "GET /api/v1/agent/phone/sms",
  "GET /api/v1/agent/phone/sms/latest-code"
];

describe("OpenAPI reference", () => {
  it("serves OpenAPI JSON unauthenticated with bearer security on agent routes", async () => {
    const app = await buildApp(config, {} as Collections);
    const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.info.title).toBe("Barkan API");
    expect(body.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(body.paths["/api/v1/agent/email/send"].post.security).toEqual([{ bearerAuth: [] }]);

    await app.close();
  });

  it("serves docs UI unauthenticated", async () => {
    const app = await buildApp(config, {} as Collections);
    const response = await app.inject({ method: "GET", url: "/docs" });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain("Barkan API Reference");
    expect(response.headers["content-type"]).toContain("text/html");

    await app.close();
  });

  it("documents every frozen agent bearer route", () => {
    for (const route of agentRoutes) {
      expect(agentOpenApiOperations[route], route).toBe(true);
    }
  });
});
