import twilio from "twilio";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";

export interface SendSmsInput {
  from: string;
  to: string;
  body: string;
  statusCallback?: string;
}

export interface TwilioSmsClient {
  messages: {
    create(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
}

let mockSequence = 0;

export async function sendSms(
  config: AppConfig,
  input: SendSmsInput,
  client?: TwilioSmsClient
): Promise<{ twilioMessageSid: string }> {
  if (config.PROVIDER_MODE_PHONE === "mock") {
    mockSequence += 1;
    return { twilioMessageSid: `SMmock${String(mockSequence).padStart(8, "0")}` };
  }
  const twilioClient = client ?? createTwilioSmsClient(config);
  const created = await twilioClient.messages.create({
    from: input.from,
    to: input.to,
    body: input.body,
    ...(input.statusCallback ? { statusCallback: input.statusCallback } : {})
  });
  const sid = readString(created.sid);
  if (!sid) {
    throw new ApiError(502, "provider_error", "Twilio did not return an SMS sid");
  }
  return { twilioMessageSid: sid };
}

export function createTwilioSmsClient(config: AppConfig): TwilioSmsClient {
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
    throw new ApiError(500, "internal", "Twilio credentials are not configured");
  }
  return twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN) as unknown as TwilioSmsClient;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
