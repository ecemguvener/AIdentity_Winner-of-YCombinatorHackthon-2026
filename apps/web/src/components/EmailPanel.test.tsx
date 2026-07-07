import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentEmailThreadDetailResponse, AgentEmailThreadsResponse } from "../api/types";
import { EmailPanel } from "./EmailPanel";

const agent: Agent = {
  id: "agent_1",
  name: "Maya",
  slug: "maya",
  status: "active",
  description: null,
  runtime: "openclaw",
  capabilities: { email: true, phone: false },
  approvalMode: "policy",
  emailAddress: "maya@agents.barkan.dev",
  phoneE164: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

describe("EmailPanel", () => {
  const originalEventSource = globalThis.EventSource;

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      writable: true,
      value: originalEventSource
    });
  });

  it("selects a thread and renders its messages", async () => {
    mockFetch();
    render(<EmailPanel agent={agent} onNotify={vi.fn()} />);

    expect(await screen.findByText("First outbound")).toBeInTheDocument();
    fireEvent.click(screen.getByText("casey@example.com"));

    expect(await screen.findByText("Second inbound")).toBeInTheDocument();
  });

  it("prefills reply text from suggested reply", async () => {
    mockFetch();
    render(<EmailPanel agent={agent} onNotify={vi.fn()} />);

    fireEvent.click(await screen.findByText("casey@example.com"));
    fireEvent.click(await screen.findByRole("button", { name: /use suggested reply/i }));

    expect(screen.getByLabelText("Reply")).toHaveValue("Sounds good, thanks.");
  });

  it("shows an approval banner when compose returns 202", async () => {
    mockFetch({ approvalOnSend: true });
    render(<EmailPanel agent={agent} onNotify={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /compose/i }));
    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Review" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Please review." } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    expect(await screen.findByText(/approval required: send email to new@example.com/i)).toBeInTheDocument();
  });

  it("refreshes when email.received SSE arrives", async () => {
    let listener: (event: MessageEvent) => void = () => {
      throw new Error("email.received listener was not registered");
    };
    class MockEventSource {
      constructor(readonly url: string) {}
      addEventListener(type: string, callback: (event: MessageEvent) => void) {
        if (type === "email.received") listener = callback;
      }
      close() {}
    }
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      writable: true,
      value: MockEventSource
    });
    const fetchMock = mockFetch();
    render(<EmailPanel agent={agent} onNotify={vi.fn()} />);

    await screen.findAllByText("First outbound");
    const callsBeforeEvent = threadListCalls(fetchMock);
    listener(new MessageEvent("email.received", { data: JSON.stringify({ agentId: agent.id, threadId: "thread_1" }) }));

    await waitFor(() => expect(threadListCalls(fetchMock)).toBeGreaterThan(callsBeforeEvent));
  });
});

function mockFetch(options: { approvalOnSend?: boolean } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/events")) {
      return jsonResponse({});
    }
    if (url.endsWith("/api/v1/agents/agent_1/email/threads")) {
      return jsonResponse(threadsResponse());
    }
    if (url.endsWith("/api/v1/agents/agent_1/email/threads/thread_1")) {
      return jsonResponse(threadDetail("thread_1"));
    }
    if (url.endsWith("/api/v1/agents/agent_1/email/threads/thread_2")) {
      return jsonResponse(threadDetail("thread_2"));
    }
    if (url.endsWith("/api/v1/agents/agent_1/email/send?mode=async") && init?.method === "POST") {
      return jsonResponse(
        options.approvalOnSend
          ? {
              ok: false,
              status: "approval_required",
              decision: "pending",
              approval_id: "approval_1",
              approval: {
                id: "approval_1",
                status: "pending",
                payloadSummary: "Send email to new@example.com: Review",
                executionResult: null,
                executionError: null
              }
            }
          : { ok: true, message_id: "msg_new", thread_id: "thread_3", provider_message_id: "provider_1", from: "maya@agents.barkan.dev", to: "new@example.com", subject: "Review", status: "sent" },
        options.approvalOnSend ? 202 : 201
      );
    }
    if (url.endsWith("/api/v1/agents/agent_1/email/threads/thread_1/reply") && init?.method === "POST") {
      return jsonResponse({ ok: true, message_id: "msg_reply", thread_id: "thread_1", provider_message_id: "provider_2", from: "maya@agents.barkan.dev", to: "alex@example.com", subject: "Re: First", status: "sent" }, 201);
    }
    return jsonResponse({ error: "not found" }, 404);
  });
}

function threadListCalls(fetchMock: ReturnType<typeof mockFetch>) {
  return fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/api/v1/agents/agent_1/email/threads")).length;
}

function threadsResponse(): AgentEmailThreadsResponse {
  const now = new Date().toISOString();
  return {
    emailIdentity: {
      email_identity_id: "email_1",
      email_address: "maya@agents.barkan.dev",
      display_name: "Maya",
      provider: "resend",
      status: "active",
      created_at: now
    },
    todaySent: 2,
    policy: {
      requireApproval: "never",
      allowedRecipients: [],
      blockedRecipients: [],
      dailySendLimit: 50,
      maxRecipientsPerMessage: 5
    },
    threads: [
      {
        id: "thread_1",
        counterparty: "alex@example.com",
        subject: "First",
        snippet: "First outbound",
        lastDirection: "outbound",
        lastMessageAt: now,
        unreadCount: 0,
        messageCount: 1
      },
      {
        id: "thread_2",
        counterparty: "casey@example.com",
        subject: "Second",
        snippet: "Second inbound",
        lastDirection: "inbound",
        lastMessageAt: now,
        unreadCount: 1,
        messageCount: 1
      }
    ],
    nextCursor: null
  };
}

function threadDetail(threadId: "thread_1" | "thread_2"): AgentEmailThreadDetailResponse {
  const now = new Date().toISOString();
  const inbound = threadId === "thread_2";
  return {
    thread: {
      id: threadId,
      counterparty: inbound ? "casey@example.com" : "alex@example.com",
      subject: inbound ? "Second" : "First",
      lastMessageAt: now,
      messageCount: 1
    },
    messages: [
      {
        id: inbound ? "msg_2" : "msg_1",
        thread_id: threadId,
        direction: inbound ? "inbound" : "outbound",
        from_email: inbound ? "casey@example.com" : "maya@agents.barkan.dev",
        to_email: inbound ? "maya@agents.barkan.dev" : "alex@example.com",
        cc: [],
        subject: inbound ? "Second" : "First",
        body: inbound ? "Second inbound" : "First outbound",
        html: null,
        provider_message_id: "provider_msg",
        status: inbound ? "received" : "sent",
        parsed_by: null,
        summary: inbound ? "Casey replied with a decision." : null,
        suggested_reply: inbound ? "Sounds good, thanks." : null,
        attachments: inbound ? [{ filename: "brief.pdf", content_type: "application/pdf", size_bytes: 1200, id: "att_1" }] : [],
        created_at: now
      }
    ]
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
