import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentListItem } from "../api/types";
import { PairingPage } from "./PairingPage";

describe("PairingPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefills code and confirms pairing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toContain("/api/v1/pairing/ABCD-1234/confirm");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ agentId: "agent_1" });
      return jsonResponse({ status: "confirmed", agentId: "agent_1", tokenPrefix: "brk_test_abc" });
    });

    render(
      <PairingPage
        agents={[agent()]}
        search="?code=ABCD-1234"
        onClose={vi.fn()}
        onNotify={vi.fn()}
      />
    );

    expect(screen.getByDisplayValue("ABCD-1234")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /confirm pairing/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(await screen.findByText(/brk_test_abc/)).toBeInTheDocument();
  });
});

function agent(): AgentListItem {
  const now = new Date().toISOString();
  return {
    id: "agent_1",
    name: "Maya",
    slug: "maya",
    status: "active",
    description: null,
    runtime: "openclaw",
    capabilities: { email: true, phone: false },
    approvalMode: "always",
    emailAddress: "maya@agents.barkan.dev",
    phoneE164: null,
    createdAt: now,
    updatedAt: now,
    provisioning: {
      email: { enabled: true, state: "active" },
      phone: { enabled: false, state: "not_provisioned" }
    }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
