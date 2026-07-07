import crypto from "node:crypto";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { instrumentProviderCall } from "../metrics.js";

export interface ImportTwilioNumberInput {
  e164: string;
  label: string;
}

export interface ElevenLabsPhoneClient {
  fetch(input: string, init: RequestInit): Promise<Response>;
}

const elevenLabsBaseUrl = "https://api.elevenlabs.io";

export async function importTwilioNumber(
  config: AppConfig,
  input: ImportTwilioNumberInput,
  client: ElevenLabsPhoneClient = defaultClient
): Promise<{ phoneNumberId: string }> {
  if (config.PROVIDER_MODE_PHONE === "mock") {
    return { phoneNumberId: `mock_pn_${crypto.randomBytes(6).toString("hex")}` };
  }
  requireElevenLabsConfig(config);
  const response = await instrumentProviderCall("elevenlabs", "phone-numbers.import", () => client.fetch(`${elevenLabsBaseUrl}/v1/convai/phone-numbers`, {
    method: "POST",
    headers: elevenLabsHeaders(config),
    body: JSON.stringify({
      provider: "twilio",
      phone_number: input.e164,
      label: input.label,
      sid: config.TWILIO_ACCOUNT_SID,
      token: config.TWILIO_AUTH_TOKEN
    })
  }));
  const body = await readJson(response);
  if (!response.ok) {
    throw elevenLabsError(response, body, "ElevenLabs phone import failed");
  }
  const phoneNumberId = readString(body.phone_number_id) ?? readString(body.phoneNumberId) ?? readString(body.id);
  if (!phoneNumberId) {
    throw new ApiError(502, "provider_error", "ElevenLabs did not return a phone number id");
  }
  return { phoneNumberId };
}

export async function assignAgentToNumber(
  config: AppConfig,
  phoneNumberId: string,
  client: ElevenLabsPhoneClient = defaultClient
): Promise<void> {
  if (config.PROVIDER_MODE_PHONE === "mock") {
    return;
  }
  requireElevenLabsConfig(config);
  const response = await instrumentProviderCall("elevenlabs", "phone-numbers.assign", () => client.fetch(`${elevenLabsBaseUrl}/v1/convai/phone-numbers/${encodeURIComponent(phoneNumberId)}`, {
    method: "PATCH",
    headers: elevenLabsHeaders(config),
    body: JSON.stringify({ agent_id: config.ELEVENLABS_AGENT_ID })
  }));
  const body = await readJson(response);
  if (!response.ok) {
    throw elevenLabsError(response, body, "ElevenLabs phone assignment failed");
  }
}

export async function removeNumber(
  config: AppConfig,
  phoneNumberId: string,
  client: ElevenLabsPhoneClient = defaultClient
): Promise<void> {
  if (config.PROVIDER_MODE_PHONE === "mock") {
    return;
  }
  requireElevenLabsConfig(config);
  const response = await instrumentProviderCall("elevenlabs", "phone-numbers.remove", () => client.fetch(`${elevenLabsBaseUrl}/v1/convai/phone-numbers/${encodeURIComponent(phoneNumberId)}`, {
    method: "DELETE",
    headers: elevenLabsHeaders(config)
  }));
  if (response.status === 404) {
    return;
  }
  const body = await readJson(response);
  if (!response.ok) {
    throw elevenLabsError(response, body, "ElevenLabs phone removal failed");
  }
}

const defaultClient: ElevenLabsPhoneClient = {
  fetch: (input, init) => fetch(input, init)
};

function elevenLabsHeaders(config: AppConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    "xi-api-key": config.ELEVENLABS_API_KEY ?? ""
  };
}

function requireElevenLabsConfig(config: AppConfig): void {
  if (!config.ELEVENLABS_API_KEY || !config.ELEVENLABS_AGENT_ID || !config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
    throw new ApiError(500, "internal", "ElevenLabs/Twilio phone configuration is incomplete");
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { detail: text };
  }
}

function elevenLabsError(response: Response, body: Record<string, unknown>, fallback: string): ApiError {
  const detail = readString(body.detail) ?? readString(body.message) ?? fallback;
  return new ApiError(response.status, "provider_error", detail);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
