import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { assignAgentToNumber, importTwilioNumber, removeNumber, type ElevenLabsPhoneClient } from "./elevenlabs-phone.js";

const liveConfig = {
  PROVIDER_MODE_PHONE: "live",
  ELEVENLABS_API_KEY: "el-key",
  ELEVENLABS_AGENT_ID: "agent-123",
  TWILIO_ACCOUNT_SID: "AC123",
  TWILIO_AUTH_TOKEN: "twilio-token"
} as unknown as AppConfig;

const mockConfig = {
  PROVIDER_MODE_PHONE: "mock"
} as unknown as AppConfig;

describe("elevenlabs phone provider", () => {
  it("imports a Twilio number with ElevenLabs convai shape", async () => {
    const fetch = vi.fn(async () => jsonResponse(200, { phone_number_id: "el-phone-1" }));
    const result = await importTwilioNumber(liveConfig, { e164: "+15005550001", label: "Maya (+15005550001)" }, { fetch });

    expect(result).toEqual({ phoneNumberId: "el-phone-1" });
    expect(fetch).toHaveBeenCalledWith("https://api.elevenlabs.io/v1/convai/phone-numbers", {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": "el-key" },
      body: JSON.stringify({
        provider: "twilio",
        phone_number: "+15005550001",
        label: "Maya (+15005550001)",
        sid: "AC123",
        token: "twilio-token"
      })
    });
  });

  it("assigns the shared ElevenLabs agent to an imported number", async () => {
    const fetch = vi.fn(async () => jsonResponse(200, {}));
    await assignAgentToNumber(liveConfig, "el-phone-1", { fetch });

    expect(fetch).toHaveBeenCalledWith("https://api.elevenlabs.io/v1/convai/phone-numbers/el-phone-1", {
      method: "PATCH",
      headers: { "content-type": "application/json", "xi-api-key": "el-key" },
      body: JSON.stringify({ agent_id: "agent-123" })
    });
  });

  it("removes numbers idempotently when ElevenLabs returns 404", async () => {
    const fetch = vi.fn(async () => jsonResponse(404, { detail: "not found" }));
    await expect(removeNumber(liveConfig, "missing-id", { fetch })).resolves.toBeUndefined();
  });

  it("surfaces ElevenLabs quota and validation failures", async () => {
    const quotaClient = fakeClient(402, { detail: "quota exceeded" });
    await expect(importTwilioNumber(liveConfig, { e164: "+15005550001", label: "Maya" }, quotaClient)).rejects.toMatchObject({
      statusCode: 402,
      code: "provider_error",
      message: "quota exceeded"
    });

    const validationClient = fakeClient(422, { message: "invalid phone number" });
    await expect(assignAgentToNumber(liveConfig, "el-phone-1", validationClient)).rejects.toMatchObject({
      statusCode: 422,
      code: "provider_error",
      message: "invalid phone number"
    });
  });

  it("mock mode returns local ids and no-ops assignment/removal", async () => {
    const fetch = vi.fn(async () => jsonResponse(500, { detail: "should not call live provider" }));

    const imported = await importTwilioNumber(mockConfig, { e164: "+15005550001", label: "Mock" }, { fetch });
    await assignAgentToNumber(mockConfig, imported.phoneNumberId, { fetch });
    await removeNumber(mockConfig, imported.phoneNumberId, { fetch });

    expect(imported.phoneNumberId).toMatch(/^mock_pn_[0-9a-f]{12}$/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

function fakeClient(status: number, body: Record<string, unknown>): ElevenLabsPhoneClient {
  return {
    fetch: vi.fn(async () => jsonResponse(status, body))
  };
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status });
}
