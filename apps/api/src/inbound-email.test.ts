import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { buildApp } from "./app.js";
import { connectDatabase, type Database } from "./db.js";
import { ingestResendReceivedEmail } from "./email-service.js";
import type { EmailInboundClient, ReceivedEmailContent } from "./providers/email-provider.js";

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

let mongoServer: MongoMemoryServer;
let database: Database;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  (config as { MONGODB_URI: string }).MONGODB_URI = mongoServer.getUri();
  database = await connectDatabase(config);
  app = await buildApp(config, database.collections);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await database?.client.close();
  await mongoServer?.stop();
});

describe("inbound email", () => {
  it("routes replies by Message-ID, stores the inbound message, and supports agent reply", async () => {
    const init = await initAgent("Inbox Bot");
    const sent = await app.inject({
      method: "POST",
      url: "/api/v1/agent/email/send",
      headers: { authorization: `Bearer ${init.token}` },
      payload: { to: "person@example.com", subject: "Ping", text: "Reply to me" }
    });
    expect(sent.statusCode).toBe(201);
    const sentBody = sent.json<{ thread_id: string }>();
    const outbound = await database.collections.emailMessages.findOne({ threadId: new ObjectId(sentBody.thread_id), direction: "outbound" });
    expect(outbound?.headers?.["message-id"]).toBeTruthy();

    const result = await ingestResendReceivedEmail(database.collections, config, inboundClient({
      id: "inbound_1",
      from: "Person <person@example.com>",
      to: [init.email],
      subject: "Re: Ping",
      text: "Yes, this works.",
      headers: {
        "message-id": "<reply-1@example.com>",
        "in-reply-to": outbound!.headers!["message-id"]!
      }
    }), { type: "email.received", data: { email_id: "inbound_1" } });
    expect(result.status).toBe("received");

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/agent/email/threads",
      headers: { authorization: `Bearer ${init.token}` }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().threads[0]).toMatchObject({ id: sentBody.thread_id, unreadCount: 1 });

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/agent/email/threads/${sentBody.thread_id}`,
      headers: { authorization: `Bearer ${init.token}` }
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json();
    expect(detailBody.messages.map((message: { direction: string }) => message.direction)).toEqual(["outbound", "inbound"]);
    expect(detailBody.messages[1].summary).toBe("Yes, this works.");

    const reply = await app.inject({
      method: "POST",
      url: `/api/v1/agent/email/threads/${sentBody.thread_id}/reply`,
      headers: { authorization: `Bearer ${init.token}` },
      payload: { text: "Great, thanks." }
    });
    expect(reply.statusCode).toBe(201);
    const replyMessage = await database.collections.emailMessages.findOne({ _id: new ObjectId(reply.json().message_id) });
    expect(replyMessage?.headers?.["in-reply-to"]).toBe("<reply-1@example.com>");
  });

  it("skips unknown recipients without throwing", async () => {
    const result = await ingestResendReceivedEmail(database.collections, config, inboundClient({
      id: "inbound_unknown",
      from: "Person <person@example.com>",
      to: ["nobody@agents.barkan.dev"],
      subject: "Hello",
      text: "Anyone there?",
      headers: { "message-id": "<unknown@example.com>" }
    }), { type: "email.received", data: { email_id: "inbound_unknown" } });

    expect(result).toMatchObject({ status: "skipped", reason: "no active recipient" });
  });

  it("prevents one agent token from reading another agent's thread", async () => {
    const first = await initAgent("Reader One");
    const second = await initAgent("Reader Two");
    const sent = await app.inject({
      method: "POST",
      url: "/api/v1/agent/email/send",
      headers: { authorization: `Bearer ${first.token}` },
      payload: { to: "person@example.com", subject: "Private", text: "Secret" }
    });
    expect(sent.statusCode).toBe(201);

    const stolen = await app.inject({
      method: "GET",
      url: `/api/v1/agent/email/threads/${sent.json().thread_id}`,
      headers: { authorization: `Bearer ${second.token}` }
    });
    expect(stolen.statusCode).toBe(404);
  });
});

async function initAgent(name: string): Promise<{ token: string; id: string; email: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/identity/init",
    payload: {
      agent_name: name,
      tools: ["email"],
      permissions: { requires_human_approval: false }
    }
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ identity_token: string; agent_id: string; email: string }>();
  await database.collections.policies.updateOne(
    { agentId: new ObjectId(body.agent_id) },
    { $set: { "email.requireApproval": "never" } }
  );
  return { token: body.identity_token, id: body.agent_id, email: body.email };
}

function inboundClient(content: Omit<ReceivedEmailContent, "cc" | "receivedFor" | "attachments"> & Partial<ReceivedEmailContent>): EmailInboundClient {
  const fullContent: ReceivedEmailContent = {
    cc: [],
    receivedFor: [],
    attachments: [],
    ...content
  };
  return {
    getReceivedEmail: async () => fullContent,
    getAttachment: async () => ({ data: new ArrayBuffer(0), contentType: "text/plain", filename: "empty.txt" })
  };
}
