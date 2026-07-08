import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import type { AgentDocument, Collections, UserDocument } from "./db.js";
import { hashSessionToken } from "./security.js";

const baseConfig: AppConfig = {
  NODE_ENV: "test",
  API_PORT: 4000,
  PUBLIC_APP_URL: "http://localhost:5173",
  PUBLIC_API_URL: "http://localhost:4000",
  MONGODB_URI: "mongodb://127.0.0.1:27017/barkan-web-test",
  SESSION_COOKIE_NAME: "barkan_session",
  SESSION_SECRET: "test-barkan-session-secret",
  PROVIDER_MODE_EMAIL: "mock",
  PROVIDER_MODE_PHONE: "mock",
  ELEVENLABS_VOICE_ID: "voice_test",
  OPENAI_API_KEY: "openai",
  EMAIL_AGENT_DOMAIN: "agents.barkan.dev",
  TWILIO_NUMBER_COUNTRY: "US",
  OPENAI_DASHBOARD_CHAT_MODEL: "gpt-5.4-2026-03-05",
  EMAIL_PLATFORM_FROM: "Barkan <no-reply@barkan.dev>",
  RESEND_WEBHOOK_SECRET: undefined,
  API_RATE_LIMIT_MAX: 1000
} as AppConfig;

describe("dashboard chat", () => {
  it("streams chat events with CORS headers for credentialed dashboard requests", async () => {
    const sessionToken = "session_test";
    const user = createUser();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ output_text: "Hello from Barkan." }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildApp(
      baseConfig,
      createCollections({
        sessionToken,
        user,
        agents: [createAgent(user._id)]
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/dashboard/chat",
      headers: {
        origin: "http://localhost:5173"
      },
      cookies: {
        [baseConfig.SESSION_COOKIE_NAME]: sessionToken
      },
      payload: {
        messages: [{ role: "user", content: "Hi" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.payload).toContain("data: {\"type\":\"ready\"");
    expect(response.payload).toContain("data: {\"type\":\"delta\",\"text\":\"Hello from Barkan.\"}");
    expect(response.payload).toContain("data: {\"type\":\"done\"}");

    vi.unstubAllGlobals();
    await app.close();
  });

  it("blocks credentialed dashboard chat from untrusted origins", async () => {
    const sessionToken = "session_test";
    const user = createUser();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildApp(
      baseConfig,
      createCollections({
        sessionToken,
        user,
        agents: [createAgent(user._id)]
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/dashboard/chat",
      headers: {
        origin: "https://evil.example"
      },
      cookies: {
        [baseConfig.SESSION_COOKIE_NAME]: sessionToken
      },
      payload: {
        messages: [{ role: "user", content: "Hi" }]
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    await app.close();
  });

  it("allows local dev dashboard origins when the configured app URL uses a network host", async () => {
    const sessionToken = "session_test";
    const user = createUser();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ output_text: "Booked from local dev." }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildApp(
      {
        ...baseConfig,
        NODE_ENV: "development",
        API_PORT: 4001,
        PUBLIC_APP_URL: "http://100.81.152.74:4888",
        PUBLIC_API_URL: "http://100.81.152.74:4001"
      },
      createCollections({
        sessionToken,
        user,
        agents: [createAgent(user._id)]
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/dashboard/chat",
      headers: {
        origin: "http://localhost:4888"
      },
      cookies: {
        [baseConfig.SESSION_COOKIE_NAME]: sessionToken
      },
      payload: {
        messages: [{ role: "user", content: "Book my barber" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:4888");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.payload).toContain("Booked from local dev.");

    vi.unstubAllGlobals();
    await app.close();
  });

  it("streams call lifecycle events around phone tool execution", async () => {
    const sessionToken = "session_test";
    const user = createUser();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: [
              {
                type: "function_call",
                call_id: "call_1",
                name: "place_phone_call",
                arguments: JSON.stringify({
                  to_number: "+33757509222",
                  task: "Book a barber appointment for 11am.",
                  agent_identity_name: "Maxence AI Caller",
                  recipient_name: "Barber",
                  context: "Ask for next week.",
                  source_url: ""
                })
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output_text: "The call has ended and the appointment is noted." }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildApp(
      baseConfig,
      createCollections({
        sessionToken,
        user,
        agents: [createAgent(user._id)]
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/dashboard/chat",
      headers: {
        origin: "http://localhost:5173"
      },
      cookies: {
        [baseConfig.SESSION_COOKIE_NAME]: sessionToken
      },
      payload: {
        messages: [{ role: "user", content: "Call my barber get me an appointment" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain("data: {\"type\":\"call_started\"");
    expect(response.payload).toContain("\"toNumber\":\"+33757509222\"");
    expect(response.payload).toContain("data: {\"type\":\"delta\",\"text\":\"The call has ended and the appointment is noted.\"}");
    expect(response.payload).toContain("data: {\"type\":\"done\"}");

    vi.unstubAllGlobals();
    await app.close();
  });
});

function createCollections({
  sessionToken,
  user,
  agents
}: {
  sessionToken: string;
  user: UserDocument;
  agents: AgentDocument[];
}): Collections {
  const calls: Array<Record<string, unknown>> = [];
  const phoneNumberId = new ObjectId();
  return {
    sessions: {
      findOne: vi.fn().mockImplementation(({ tokenHash }: { tokenHash: string }) =>
        tokenHash === hashSessionToken(sessionToken, baseConfig.SESSION_SECRET)
          ? Promise.resolve({ _id: new ObjectId(), userId: user._id, tokenHash, expiresAt: new Date(Date.now() + 60_000) })
          : Promise.resolve(null)
      ),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 })
    },
    users: {
      findOne: vi.fn().mockResolvedValue(user)
    },
    billingAccounts: {
      findOne: vi.fn().mockResolvedValue({
        _id: new ObjectId(),
        ownerUserId: user._id,
        stripeCustomerId: "cus_test",
        plan: "scale",
        subscriptionStatus: "active",
        createdAt: new Date(),
        updatedAt: new Date()
      })
    },
    agents: {
      find: vi.fn().mockImplementation(({ ownerUserId }: { ownerUserId: ObjectId }) => ({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue(agents.filter((agent) => agent.ownerUserId?.equals(ownerUserId)))
          })
        })
      }))
    },
    phoneNumbers: {
      findOne: vi.fn().mockImplementation(({ agentId }: { agentId: ObjectId }) =>
        Promise.resolve({
          _id: phoneNumberId,
          agentId,
          e164: "+15005550001",
          country: "US",
          twilioSid: "PN123",
          elevenLabsPhoneNumberId: "el-phone-1",
          capabilitiesVoice: true,
          capabilitiesSms: true,
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date()
        })
      )
    },
    calls: {
      countDocuments: vi.fn().mockResolvedValue(0),
      insertOne: vi.fn().mockImplementation((call: Record<string, unknown>) => {
        calls.push(call);
        return Promise.resolve({ insertedId: call._id });
      }),
      updateOne: vi.fn().mockImplementation((filter: { _id: ObjectId }, update: { $set?: Record<string, unknown> }) => {
        const call = calls.find((candidate) => (candidate._id as ObjectId).equals(filter._id));
        if (call && update.$set) Object.assign(call, update.$set);
        return Promise.resolve({ matchedCount: call ? 1 : 0, modifiedCount: call ? 1 : 0 });
      }),
      findOne: vi.fn().mockImplementation((filter: { _id: ObjectId }) =>
        Promise.resolve(calls.find((call) => (call._id as ObjectId).equals(filter._id)) ?? null)
      )
    },
    policies: {
      findOne: vi.fn().mockResolvedValue({
        phone: {
          requireApprovalOutboundCall: "never",
          inboundEnabled: true,
          blockedCallers: [],
          inboundInstructions: "Answer naturally."
        }
      })
    },
    auditLogs: {
      insertOne: vi.fn().mockImplementation((entry: Record<string, unknown>) => Promise.resolve({ insertedId: entry._id }))
    }
  } as unknown as Collections;
}

function createUser(): UserDocument {
  return {
    _id: new ObjectId(),
    email: "dev@barkan.test",
    passwordHash: "unused",
    createdAt: new Date()
  } as UserDocument;
}

function createAgent(ownerUserId: ObjectId): AgentDocument {
  return {
    _id: new ObjectId(),
    ownerUserId,
    name: "Test site",
    slug: "test-site",
    status: "active",
    capabilities: { email: true, phone: true },
    approvalMode: "always",
    runtime: "openclaw",
    createdAt: new Date("2026-05-26T10:00:00.000Z"),
    updatedAt: new Date("2026-05-26T10:00:00.000Z")
  } as AgentDocument;
}
