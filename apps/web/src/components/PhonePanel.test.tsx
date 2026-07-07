import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhonePanel } from "./PhonePanel";
import type { Agent, PhonePolicy } from "../api/types";

describe("PhonePanel", () => {
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

  it("loads and saves phone policy edits", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/v1/agents/agent_1/phone")) {
        return jsonResponse({ phone: { number: phoneNumber(), capability_enabled: true }, policy: phonePolicy() });
      }
      if (url.endsWith("/api/v1/agents/agent_1/phone/calls")) {
        return jsonResponse({ calls: [phoneCall()], next_cursor: null });
      }
      if (url.endsWith("/api/v1/agents/agent_1/phone/sms")) {
        return jsonResponse({ conversations: [], next_cursor: null });
      }
      if (url.endsWith("/api/v1/agents/agent_1/policies/phone") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as PhonePolicy;
        expect(body.allowedCountries).toEqual(["FR", "GB"]);
        expect(body.dailySmsLimit).toBe(75);
        return jsonResponse({ policy: body });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    render(<PhonePanel agent={agent()} provisioning={{ enabled: true, state: "active" }} onEnablePhone={vi.fn()} onNotify={vi.fn()} />);

    expect(await screen.findByText("Phone policy")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /phone policy/i }));
    fireEvent.change(screen.getByLabelText("Allowed countries"), { target: { value: "FR, GB" } });
    fireEvent.change(screen.getByLabelText("Daily SMS"), { target: { value: "75" } });
    fireEvent.click(screen.getByRole("button", { name: /save policy/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/v1/agents/agent_1/policies/phone"), expect.objectContaining({ method: "PUT" })));
  });

  it("renders call transcript and refreshes on call.completed SSE", async () => {
    let listener: (event: MessageEvent) => void = () => {
      throw new Error("call.completed listener was not registered");
    };
    class MockEventSource {
      constructor(readonly url: string) {}
      addEventListener(type: string, callback: (event: MessageEvent) => void) {
        if (type === "call.completed") listener = callback;
      }
      close() {}
    }
    Object.defineProperty(globalThis, "EventSource", { configurable: true, writable: true, value: MockEventSource });
    let completed = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/agents/agent_1/phone")) return jsonResponse({ phone: { number: phoneNumber(), capability_enabled: true }, policy: phonePolicy() });
      if (url.endsWith("/api/v1/agents/agent_1/phone/calls")) {
        return jsonResponse({ calls: [completed ? { ...phoneCall(), summary: "Call finished.", transcript: [{ role: "agent", message: "Done now.", timeInCallSecs: 2 }] } : phoneCall()], next_cursor: null });
      }
      if (url.endsWith("/api/v1/agents/agent_1/phone/sms")) return jsonResponse({ conversations: [], next_cursor: null });
      return jsonResponse({ error: "not found" }, 404);
    });

    render(<PhonePanel agent={agent()} provisioning={{ enabled: true, state: "active" }} onEnablePhone={vi.fn()} onNotify={vi.fn()} />);

    expect(await screen.findByText("Hello from Maya.")).toBeInTheDocument();
    completed = true;
    listener(new MessageEvent("call.completed", { data: JSON.stringify({ agentId: "agent_1", callId: "call_1" }) }));
    expect(await screen.findByText("Done now.")).toBeInTheDocument();
  });

  it("rolls back optimistic SMS when send fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/v1/agents/agent_1/phone")) return jsonResponse({ phone: { number: phoneNumber(), capability_enabled: true }, policy: phonePolicy() });
      if (url.endsWith("/api/v1/agents/agent_1/phone/calls")) return jsonResponse({ calls: [], next_cursor: null });
      if (url.endsWith("/api/v1/agents/agent_1/phone/sms")) return jsonResponse({ conversations: [smsConversation()], next_cursor: null });
      if (url.endsWith("/api/v1/agents/agent_1/phone/sms?with=%2B33612345678")) return jsonResponse({ messages: [smsMessage("inbound", "Existing")], next_cursor: null });
      if (url.endsWith("/api/v1/agents/agent_1/phone/sms?mode=async") && init?.method === "POST") return jsonResponse({ error: { message: "failed" } }, 500);
      return jsonResponse({ error: "not found" }, 404);
    });

    render(<PhonePanel agent={agent()} provisioning={{ enabled: true, state: "active" }} onEnablePhone={vi.fn()} onNotify={vi.fn()} />);

    const input = await screen.findByLabelText("SMS message");
    fireEvent.change(input, { target: { value: "Please confirm" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/failed/i);
    expect(screen.queryByText("Please confirm", { selector: "p" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("SMS message")).toHaveValue("Please confirm");
  });
});

const now = new Date().toISOString();

function agent(): Agent {
  return {
    id: "agent_1",
    name: "Maya",
    slug: "maya",
    status: "active",
    description: null,
    runtime: "openclaw",
    capabilities: { email: false, phone: true },
    approvalMode: "policy",
    emailAddress: null,
    phoneE164: "+15005550001",
    createdAt: now,
    updatedAt: now
  };
}

function phoneNumber() {
  return {
    id: "phone_1",
    e164: "+15005550001",
    country: "US",
    status: "active",
    capabilities: { voice: true, sms: true },
    created_at: now
  };
}

function phoneCall() {
  return {
    id: "call_1",
    agent_id: "agent_1",
    phone_number_id: "phone_1",
    direction: "inbound",
    counterparty_e164: "+33612345678",
    task: null,
    status: "completed",
    provider_call_id: "CA1",
    elevenlabs_conversation_id: "conv_1",
    duration_secs: 65,
    transcript: [{ role: "agent", message: "Hello from Maya.", timeInCallSecs: 1 }],
    summary: "Caller confirmed the appointment.",
    cost_cents: 15,
    created_at: now,
    updated_at: now
  };
}

function smsConversation() {
  return {
    counterparty_e164: "+33612345678",
    last_message: smsMessage("inbound", "Existing"),
    message_count: 1
  };
}

function smsMessage(direction: "inbound" | "outbound", body: string) {
  return {
    id: `sms_${body}`,
    direction,
    counterparty_e164: "+33612345678",
    body,
    status: direction === "inbound" ? "received" : "sent",
    twilio_message_sid: "SM1",
    created_at: now,
    updated_at: now
  };
}

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
