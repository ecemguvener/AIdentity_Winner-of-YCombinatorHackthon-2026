import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhonePanel } from "./PhonePanel";
import type { PhonePolicy } from "../api/types";

describe("PhonePanel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads and saves phone policy edits", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/v1/agents/agent_1/policies/phone") && !init?.method) {
        return jsonResponse({ policy: phonePolicy() });
      }
      if (url.endsWith("/api/v1/agents/agent_1/policies/phone") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as PhonePolicy;
        expect(body.allowedCountries).toEqual(["FR", "GB"]);
        expect(body.dailySmsLimit).toBe(75);
        return jsonResponse({ policy: body });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    render(<PhonePanel siteName="Maya" agentId="agent_1" />);

    expect(await screen.findByText("Phone policy")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Allowed countries"), { target: { value: "FR, GB" } });
    fireEvent.change(screen.getByLabelText("Daily SMS"), { target: { value: "75" } });
    fireEvent.click(screen.getByRole("button", { name: /save policy/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/v1/agents/agent_1/policies/phone"), expect.objectContaining({ method: "PUT" })));
  });
});

function phonePolicy(): PhonePolicy {
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

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  }));
}
