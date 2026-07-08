#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const defaultApiUrl = "https://aidentity.space";
const defaultPollIntervalMs = 5000;
const pairingTimeoutMs = 10 * 60_000;
const version = "0.1.0";

interface CredentialsFile {
  apiUrl?: string;
  identityToken?: string;
  agentId?: string;
}

interface RuntimeConfig {
  apiUrl: string;
  identityToken: string;
}

interface CliArgs {
  pair: boolean;
  apiUrl?: string;
  pollIntervalMs: number;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.pair) {
    await runPairing(args);
    return;
  }

  const config = await readRuntimeConfig(args.apiUrl);
  await runProxy(config);
}

async function runProxy(config: RuntimeConfig): Promise<void> {
  const upstream = new Client({ name: "barkan-mcp-stdio-bridge", version });
  const upstreamTransport = new StreamableHTTPClientTransport(new URL("/mcp", normalizeApiUrl(config.apiUrl)), {
    requestInit: { headers: { authorization: `Bearer ${config.identityToken}` } }
  });
  await upstream.connect(upstreamTransport);

  const server = new Server(
    { name: "barkan-mcp", version },
    { capabilities: { tools: {}, resources: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async (request) => upstream.listTools(request.params));
  server.setRequestHandler(CallToolRequestSchema, async (request) => upstream.callTool(request.params));
  server.setRequestHandler(ListResourcesRequestSchema, async (request) => upstream.listResources(request.params));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => upstream.readResource(request.params));

  const transport = new StdioServerTransport();
  process.on("SIGINT", () => {
    void upstream.close().finally(() => process.exit(0));
  });
  await server.connect(transport);
}

async function runPairing(args: CliArgs): Promise<void> {
  const apiUrl = normalizeApiUrl(args.apiUrl ?? process.env.BARKAN_API_URL ?? defaultApiUrl);
  const start = await requestJson<{ code: string; confirmUrl: string; expiresInSeconds: number }>(
    new URL("/api/v1/pairing/start", apiUrl),
    { method: "POST" }
  );

  console.log(`Pairing code: ${start.code}`);
  console.log(`Open: ${start.confirmUrl}`);
  console.log("Waiting for confirmation...");

  const deadline = Date.now() + Math.min(pairingTimeoutMs, start.expiresInSeconds * 1000);
  while (Date.now() < deadline) {
    await sleep(args.pollIntervalMs);
    const poll = await requestJson<
      | { status: "pending" | "expired" }
      | { status: "confirmed"; identityToken: string; agentId: string; apiUrl: string }
    >(
      new URL("/api/v1/pairing/poll", apiUrl),
      {
        method: "POST",
        body: JSON.stringify({ code: start.code }),
        headers: { "content-type": "application/json" }
      }
    );

    if (poll.status === "pending") {
      continue;
    }
    if (poll.status === "expired") {
      throw new Error("pairing code expired");
    }
    if (poll.status !== "confirmed") {
      continue;
    }

    await writeCredentials({
      apiUrl: poll.apiUrl,
      identityToken: poll.identityToken,
      agentId: poll.agentId
    });
    console.log(`Paired agent: ${poll.agentId}`);
    console.log(`BARKAN_API_URL=${poll.apiUrl}`);
    console.log(`BARKAN_IDENTITY_TOKEN=${poll.identityToken}`);
    return;
  }

  throw new Error("pairing timed out");
}

async function readRuntimeConfig(apiUrlOverride?: string): Promise<RuntimeConfig> {
  const credentials = await readCredentials();
  const apiUrl = apiUrlOverride ?? process.env.BARKAN_API_URL ?? credentials.apiUrl ?? defaultApiUrl;
  const identityToken = process.env.BARKAN_IDENTITY_TOKEN ?? credentials.identityToken;
  if (!identityToken) {
    throw new Error("missing BARKAN_IDENTITY_TOKEN; run with --pair or set the environment variable");
  }
  return { apiUrl: normalizeApiUrl(apiUrl).toString().replace(/\/$/, ""), identityToken };
}

async function readCredentials(): Promise<CredentialsFile> {
  try {
    return JSON.parse(await fs.readFile(credentialsPath(), "utf8")) as CredentialsFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeCredentials(credentials: Required<CredentialsFile>): Promise<void> {
  const filePath = credentialsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

function credentialsPath(): string {
  return path.join(os.homedir(), ".barkan", "credentials.json");
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { pair: false, pollIntervalMs: defaultPollIntervalMs };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--pair") {
      args.pair = true;
    } else if (arg === "--api-url") {
      args.apiUrl = argv[++index];
    } else if (arg === "--poll-interval-ms") {
      args.pollIntervalMs = Number(argv[++index]);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.pollIntervalMs) || args.pollIntervalMs < 100) {
    args.pollIntervalMs = defaultPollIntervalMs;
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage:
  barkan-mcp
  barkan-mcp --pair [--api-url https://aidentity.space]

Environment:
  BARKAN_API_URL             Barkan API base URL
  BARKAN_IDENTITY_TOKEN      Agent identity token`);
}

function normalizeApiUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

async function requestJson<T>(url: URL, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim();
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: { message?: string } };
      message = parsed.error?.message ?? parsed.message ?? message;
    } catch {
      if (text.trim()) message = text.trim();
    }
    throw new Error(message);
  }
  return JSON.parse(text) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
