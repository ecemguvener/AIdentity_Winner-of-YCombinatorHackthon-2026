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

  it("loads and saves email policy from the Email tab", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/policies/email") && init?.method === "PUT") {
        expect(JSON.parse(String(init.body))).toMatchObject({
          requireApproval: "never",
          allowedRecipients: ["alice@example.com"],
          dailySendLimit: 25
        });
        return jsonResponse({
          policy: {
            requireApproval: "never",
            allowedRecipients: ["alice@example.com"],
            blockedRecipients: [],
            dailySendLimit: 25,
            maxRecipientsPerMessage: 5
          }
        });
      }
      if (url.endsWith("/policies/email")) {
        return jsonResponse({
          policy: {
            requireApproval: "always",
            allowedRecipients: [],
            blockedRecipients: [],
            dailySendLimit: 50,
            maxRecipientsPerMessage: 5
          }
        });
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

    await screen.findByDisplayValue("50");
    fireEvent.click(screen.getByLabelText("Never"));
    fireEvent.change(screen.getByLabelText("Allowed recipients"), { target: { value: "alice@example.com" } });
    fireEvent.change(screen.getByLabelText("Daily limit"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: /save policy/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/policies/email"), expect.objectContaining({ method: "PUT" })));
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
