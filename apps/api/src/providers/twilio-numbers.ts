import twilio from "twilio";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";

export interface TwilioNumberCandidate {
  e164: string;
  friendlyName: string;
  locality: string | null;
  region: string | null;
  country: string;
  voiceEnabled: boolean;
  smsEnabled: boolean;
  monthlyPriceCents: number | null;
}

export interface PurchasedTwilioNumber {
  twilioSid: string;
  e164: string;
  capabilities: {
    voice: boolean;
    sms: boolean;
  };
  monthlyPriceCents: number;
}

export interface TwilioPurchasedNumberSummary {
  twilioSid: string;
  e164: string;
  friendlyName: string | null;
}

export interface SearchNumbersInput {
  country: string;
  areaCode?: string;
  contains?: string;
}

export interface PurchaseNumberInput {
  e164: string;
  friendlyName: string;
  agentId: string;
}

export interface TwilioNumbersClient {
  availablePhoneNumbers(country: string): {
    local: {
      list(input: Record<string, unknown>): Promise<unknown[]>;
    };
  };
  incomingPhoneNumbers: {
    create(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    list(input?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  } & ((sid: string) => { remove(): Promise<boolean> });
}

export async function searchNumbers(
  config: AppConfig,
  input: SearchNumbersInput,
  client?: TwilioNumbersClient
): Promise<TwilioNumberCandidate[]> {
  if (config.PROVIDER_MODE_PHONE === "mock" && !hasLiveTwilioCredentials(config)) {
    return new MockTwilioNumbers().searchNumbers(input);
  }
  const twilioClient = client ?? createTwilioNumbersClient(config);
  const country = (input.country || config.TWILIO_NUMBER_COUNTRY || "US").toUpperCase();
  const params: Record<string, unknown> = {
    limit: 10,
    voiceEnabled: true,
    smsEnabled: true
  };
  if (input.areaCode) params.areaCode = input.areaCode;
  if (input.contains) params.contains = input.contains;
  const results = await twilioClient.availablePhoneNumbers(country).local.list(params);
  return results.slice(0, 10).map((candidate) => normalizeCandidate(candidate, country));
}

export async function purchaseNumber(
  config: AppConfig,
  input: PurchaseNumberInput,
  client?: TwilioNumbersClient
): Promise<PurchasedTwilioNumber> {
  if (config.PROVIDER_MODE_PHONE === "mock" && !hasLiveTwilioCredentials(config)) {
    return new MockTwilioNumbers().purchaseNumber(input);
  }
  const twilioClient = client ?? createTwilioNumbersClient(config);
  const created = await twilioClient.incomingPhoneNumbers.create(buildPurchaseParams(config, input));
  return {
    twilioSid: readString(created.sid) || readString(created.accountSid) || "",
    e164: readString(created.phoneNumber) || input.e164,
    capabilities: {
      voice: readCapability(created.capabilities, "voice", true),
      sms: readCapability(created.capabilities, "sms", true)
    },
    monthlyPriceCents: readMonthlyPriceCents(created)
  };
}

export async function releaseNumber(
  config: AppConfig,
  twilioSid: string,
  client?: TwilioNumbersClient
): Promise<void> {
  if (config.PROVIDER_MODE_PHONE === "mock" && !hasLiveTwilioCredentials(config)) {
    new MockTwilioNumbers().releaseNumber(twilioSid);
    return;
  }
  const twilioClient = client ?? createTwilioNumbersClient(config);
  try {
    await twilioClient.incomingPhoneNumbers(twilioSid).remove();
  } catch (error) {
    if (isTwilioNotFound(error)) return;
    throw error;
  }
}

export async function listPurchasedNumbers(
  config: AppConfig,
  client?: TwilioNumbersClient
): Promise<TwilioPurchasedNumberSummary[]> {
  if (config.PROVIDER_MODE_PHONE === "mock" && !hasLiveTwilioCredentials(config)) {
    return new MockTwilioNumbers().listPurchasedNumbers();
  }
  const twilioClient = client ?? createTwilioNumbersClient(config);
  const numbers = await twilioClient.incomingPhoneNumbers.list({ limit: 1000 });
  return numbers.map((number) => ({
    twilioSid: readString(number.sid) || "",
    e164: readString(number.phoneNumber) || "",
    friendlyName: readString(number.friendlyName)
  })).filter((number) => number.twilioSid && number.e164);
}

function createTwilioNumbersClient(config: AppConfig): TwilioNumbersClient {
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
    throw new ApiError(500, "internal", "Twilio credentials are not configured");
  }
  return twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN) as unknown as TwilioNumbersClient;
}

export function buildPurchaseParams(config: AppConfig, input: PurchaseNumberInput): Record<string, unknown> {
  const publicApiUrl = config.PUBLIC_API_URL.replace(/\/$/, "");
  return {
    phoneNumber: input.e164,
    friendlyName: input.friendlyName || `barkan:${input.agentId}`,
    smsUrl: `${publicApiUrl}/webhooks/twilio/sms`,
    smsMethod: "POST",
    statusCallback: `${publicApiUrl}/webhooks/twilio/status`,
    ...(config.TWILIO_ADDRESS_SID ? { addressSid: config.TWILIO_ADDRESS_SID } : {}),
    ...(config.TWILIO_BUNDLE_SID ? { bundleSid: config.TWILIO_BUNDLE_SID } : {})
  };
}

export class MockTwilioNumbers {
  private readonly registry = new Map<string, PurchasedTwilioNumber>();
  private sequence = 0;

  async searchNumbers(input: SearchNumbersInput): Promise<TwilioNumberCandidate[]> {
    const country = (input.country || "US").toUpperCase();
    return Array.from({ length: 10 }, (_value, index) => {
      const suffix = String(index + 1).padStart(4, "0");
      return {
        e164: `+1500555${suffix}`,
        friendlyName: `Mock ${country} ${suffix}`,
        locality: null,
        region: null,
        country,
        voiceEnabled: true,
        smsEnabled: true,
        monthlyPriceCents: 115
      };
    });
  }

  async purchaseNumber(input: PurchaseNumberInput): Promise<PurchasedTwilioNumber> {
    this.sequence += 1;
    const twilioSid = `PNmock${String(this.sequence).padStart(8, "0")}`;
    const purchased = {
      twilioSid,
      e164: input.e164,
      capabilities: { voice: true, sms: true },
      monthlyPriceCents: 115
    };
    this.registry.set(twilioSid, purchased);
    return purchased;
  }

  releaseNumber(twilioSid: string): void {
    this.registry.delete(twilioSid);
  }

  async listPurchasedNumbers(): Promise<TwilioPurchasedNumberSummary[]> {
    return [...this.registry.values()].map((number) => ({
      twilioSid: number.twilioSid,
      e164: number.e164,
      friendlyName: null
    }));
  }
}

function normalizeCandidate(value: unknown, country: string): TwilioNumberCandidate {
  const record = isRecord(value) ? value : {};
  return {
    e164: readString(record.phoneNumber) || "",
    friendlyName: readString(record.friendlyName) || readString(record.phoneNumber) || "",
    locality: readString(record.locality),
    region: readString(record.region),
    country: readString(record.isoCountry) || country,
    voiceEnabled: readCapability(record.capabilities, "voice", true),
    smsEnabled: readCapability(record.capabilities, "sms", true),
    monthlyPriceCents: readMonthlyPriceCents(record)
  };
}

function readCapability(value: unknown, key: "voice" | "sms", fallback: boolean): boolean {
  return isRecord(value) && typeof value[key] === "boolean" ? value[key] : fallback;
}

function readMonthlyPriceCents(value: Record<string, unknown>): number {
  const raw = readString(value.monthlyPrice) ?? readString(value.price) ?? "";
  const amount = Number(raw.replace(/[^0-9.]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : 0;
}

function hasLiveTwilioCredentials(config: AppConfig): boolean {
  return Boolean(config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN);
}

function isTwilioNotFound(error: unknown): boolean {
  return isRecord(error) && (error.status === 404 || error.code === 20404);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
