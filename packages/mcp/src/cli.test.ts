import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/api/src/app.js";
import type { AppConfig } from "../../../apps/api/src/config.js";
import { connectDatabase, type Database } from "../../../apps/api/src/db.js";

const config = {
  NODE_ENV: "test",
  API_PORT: 0,
  PUBLIC_APP_URL: "http://localhost:4888",
  PUBLIC_API_URL: "http://localhost:4001",
  MONGODB_URI: "set-by-beforeAll",
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

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let mongoServer: MongoMemoryServer;
let database: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
let apiUrl: string;
let token: string;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);
  apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  token = await createAgentToken();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("@barkan/mcp stdio bridge", () => {
  it("exposes the same tools as the hosted MCP endpoint", async () => {
    const directClient = new Client({ name: "direct-test", version: "1.0.0" });
    await directClient.connect(new StreamableHTTPClientTransport(new URL(`${apiUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    }));

    const stdioClient = new Client({ name: "stdio-test", version: "1.0.0" });
    const stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(packageRoot, "dist", "cli.js")],
      env: {
        BARKAN_API_URL: apiUrl,
        BARKAN_IDENTITY_TOKEN: token
      },
      stderr: "pipe"
    });
    await stdioClient.connect(stdioTransport);

    const directTools = (await directClient.listTools()).tools.map((tool) => tool.name).sort();
    const stdioTools = (await stdioClient.listTools()).tools.map((tool) => tool.name).sort();
    expect(stdioTools).toEqual(directTools);

    const whoami = await stdioClient.callTool({ name: "barkan_whoami", arguments: {} });
    expect(whoami.structuredContent).toMatchObject({ name: "Bridge Bot" });

    await stdioClient.close();
    await directClient.close();
  }, 20_000);
});

async function createAgentToken(): Promise<string> {
  const signup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email: "mcp-bridge@example.com", password: "password12345" }
  });
  expect(signup.statusCode).toBe(200);
  const cookie = signup.cookies.find((candidate) => candidate.name === config.SESSION_COOKIE_NAME);
  expect(cookie).toBeDefined();

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/agents",
    cookies: { [config.SESSION_COOKIE_NAME]: cookie!.value },
    payload: {
      name: "Bridge Bot",
      capabilities: { email: true, phone: false },
      approvalMode: "autonomous"
    }
  });
  expect(created.statusCode).toBe(201);
  return created.json().identityToken.secret;
}
