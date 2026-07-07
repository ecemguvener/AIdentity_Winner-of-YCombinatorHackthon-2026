import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDetailResponse } from "../api/types";
import { AgentDetailPage } from "./AgentDetailPage";

describe("Agent detail page", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the v1 capability endpoint when email is enabled", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/capabilities/email/enable")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({ provisioning: { state: "pending", capability: "email" } });
      }
      if (url.endsWith("/api/v1/agents/agent_1")) {
        return jsonResponse(detail({ email: true }));
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    render(
      <AgentDetailPage
        detail={detail({ email: false })}
        activeTab="credentials"
        onAgentDetailLoaded={vi.fn()}
        onAgentUpdated={vi.fn()}
        onAgentDeleted={vi.fn()}
        onTokensChanged={vi.fn()}
        onNotify={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText(/email/i));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/capabilities/email/enable"), expect.anything()));
  });

  it("renders the real email panel from the Email tab", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/email/threads")) {
        return jsonResponse(emailThreadsResponse());
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    render(
      <AgentDetailPage
        detail={detail({ email: true })}
        activeTab="email"
        onAgentDetailLoaded={vi.fn()}
        onAgentUpdated={vi.fn()}
        onAgentDeleted={vi.fn()}
        onTokensChanged={vi.fn()}
        onNotify={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(await screen.findByText("maya@agents.barkan.dev")).toBeInTheDocument();
  });

  it("renders the real phone panel from the Phone tab", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/agents/agent_1/phone")) {
        return jsonResponse({ phone: { number: { id: "phone_1", e164: "+15005550001", country: "US", status: "active", capabilities: { voice: true, sms: true }, created_at: new Date().toISOString() }, capability_enabled: true }, policy: phonePolicy() });
      }
      if (url.endsWith("/api/v1/agents/agent_1/phone/calls")) return jsonResponse({ calls: [], next_cursor: null });
      if (url.endsWith("/api/v1/agents/agent_1/phone/sms")) return jsonResponse({ conversations: [], next_cursor: null });
      return jsonResponse({ error: "not found" }, 404);
    });

    render(
      <AgentDetailPage
        detail={detail({ email: false, phone: true })}
        activeTab="phone"
        onAgentDetailLoaded={vi.fn()}
        onAgentUpdated={vi.fn()}
        onAgentDeleted={vi.fn()}
        onTokensChanged={vi.fn()}
        onNotify={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(await screen.findByText(/\+1 \(500\) 555-0001/)).toBeInTheDocument();
  });

  it("renders remote and stdio MCP snippets", () => {
    render(
      <AgentDetailPage
        detail={detail({ email: true })}
        activeTab="credentials"
        onAgentDetailLoaded={vi.fn()}
        onAgentUpdated={vi.fn()}
        onAgentDeleted={vi.fn()}
        onTokensChanged={vi.fn()}
        onNotify={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getAllByText("Remote MCP").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Stdio MCP").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/@barkan\/mcp/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/BARKAN_IDENTITY_TOKEN/).length).toBeGreaterThan(0);
  });

  it("calls freeze-all from danger zone after name confirmation", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("Maya");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/freeze-all")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({ ok: true });
      }
      if (url.endsWith("/api/v1/agents/agent_1")) {
        return jsonResponse(detail({ email: true }));
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    render(
      <AgentDetailPage
        detail={detail({ email: true })}
        activeTab="credentials"
        onAgentDetailLoaded={vi.fn()}
        onAgentUpdated={vi.fn()}
        onAgentDeleted={vi.fn()}
        onTokensChanged={vi.fn()}
        onNotify={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getAllByRole("button", { name: /freeze all access/i })[0]!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/freeze-all"), expect.anything()));
  });
});

function detail(capabilities: { email: boolean; phone?: boolean }): AgentDetailResponse {
  const now = new Date().toISOString();
  return {
    agent: {
      id: "agent_1",
      name: "Maya",
      slug: "maya",
      status: "active",
      description: null,
      runtime: "openclaw",
      capabilities: { email: capabilities.email, phone: capabilities.phone ?? false },
      approvalMode: "always",
      emailAddress: null,
      phoneE164: null,
      createdAt: now,
      updatedAt: now
    },
    tokens: [],
    provisioning: {
      email: { enabled: capabilities.email, state: capabilities.email ? "pending" : "not_provisioned" },
      phone: { enabled: capabilities.phone ?? false, state: "not_provisioned" }
    }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function emailThreadsResponse() {
  return {
    emailIdentity: {
      email_identity_id: "email_1",
      email_address: "maya@agents.barkan.dev",
      display_name: "Maya",
      provider: "resend",
      status: "active",
      created_at: new Date().toISOString()
    },
    todaySent: 0,
    policy: {
      requireApproval: "never",
      allowedRecipients: [],
      blockedRecipients: [],
      dailySendLimit: 50,
      maxRecipientsPerMessage: 5
    },
    threads: [],
    nextCursor: null
  };
}

function phonePolicy() {
  return {
    requireApprovalOutboundCall: "always",
    requireApprovalSms: "new_recipients",
    allowedCountries: [],
    blockedCallers: [],
    inboundEnabled: true,
    inboundInstructions: "Answer naturally.",
    dailyCallLimit: 20,
    dailySmsLimit: 50,
    quietHours: { start: "22:00", end: "08:00", timezone: "Europe/Paris" },
    storeTranscripts: true
  };
}
