import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import {
  buildPurchaseParams,
  MockTwilioNumbers,
  purchaseNumber,
  releaseNumber,
  searchNumbers,
  type TwilioNumbersClient
} from "./twilio-numbers.js";

const config = {
  PROVIDER_MODE_PHONE: "live",
  PUBLIC_API_URL: "https://aidentity.space/api",
  TWILIO_ACCOUNT_SID: "AC123",
  TWILIO_AUTH_TOKEN: "token",
  TWILIO_NUMBER_COUNTRY: "US",
  TWILIO_ADDRESS_SID: "AD123",
  TWILIO_BUNDLE_SID: "BU123"
} as unknown as AppConfig;

describe("twilio number provider", () => {
  it("searches local voice+sms numbers with filters and max 10", async () => {
    const list = vi.fn(async () => Array.from({ length: 12 }, (_value, index) => ({
      phoneNumber: `+14155550${String(index).padStart(2, "0")}`,
      friendlyName: `San Francisco ${index}`,
      locality: "San Francisco",
      region: "CA",
      isoCountry: "US",
      capabilities: { voice: true, sms: true },
      monthlyPrice: "1.15"
    })));
    const client = fakeClient({ list });

    const candidates = await searchNumbers(config, { country: "US", areaCode: "415", contains: "555" }, client);

    expect(list).toHaveBeenCalledWith({
      limit: 10,
      voiceEnabled: true,
      smsEnabled: true,
      areaCode: "415",
      contains: "555"
    });
    expect(candidates).toHaveLength(10);
    expect(candidates[0]).toMatchObject({
      e164: "+1415555000",
      voiceEnabled: true,
      smsEnabled: true,
      monthlyPriceCents: 115
    });
  });

  it("builds purchase params with webhook URLs and regulatory passthrough", () => {
    expect(buildPurchaseParams(config, { e164: "+14155550123", friendlyName: "barkan:agent", agentId: "agent" })).toEqual({
      phoneNumber: "+14155550123",
      friendlyName: "barkan:agent",
      smsUrl: "https://aidentity.space/api/webhooks/twilio/sms",
      smsMethod: "POST",
      statusCallback: "https://aidentity.space/api/webhooks/twilio/status",
      addressSid: "AD123",
      bundleSid: "BU123"
    });
  });

  it("purchases numbers through IncomingPhoneNumbers.create", async () => {
    const create = vi.fn(async () => ({
      sid: "PN123",
      phoneNumber: "+14155550123",
      capabilities: { voice: true, sms: true },
      monthlyPrice: "1.15"
    }));
    const client = fakeClient({ create });

    const purchased = await purchaseNumber(config, { e164: "+14155550123", friendlyName: "barkan:agent", agentId: "agent" }, client);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      phoneNumber: "+14155550123",
      smsUrl: "https://aidentity.space/api/webhooks/twilio/sms",
      statusCallback: "https://aidentity.space/api/webhooks/twilio/status"
    }));
    expect(purchased).toEqual({
      twilioSid: "PN123",
      e164: "+14155550123",
      capabilities: { voice: true, sms: true },
      monthlyPriceCents: 115
    });
  });

  it("release is idempotent when Twilio returns 404", async () => {
    const remove = vi.fn(async () => {
      throw { status: 404 };
    });
    await expect(releaseNumber(config, "PN404", fakeClient({ remove }))).resolves.toBeUndefined();
  });

  it("mock provider returns deterministic searchable and purchasable numbers", async () => {
    const provider = new MockTwilioNumbers();
    const candidates = await provider.searchNumbers({ country: "US" });
    const purchased = await provider.purchaseNumber({ e164: candidates[0]!.e164, friendlyName: "barkan:mock", agentId: "agent" });

    expect(candidates[0]?.e164).toBe("+15005550001");
    expect(purchased).toMatchObject({ twilioSid: "PNmock00000001", e164: "+15005550001" });
    expect(await provider.listPurchasedNumbers()).toHaveLength(1);
    provider.releaseNumber(purchased.twilioSid);
    expect(await provider.listPurchasedNumbers()).toHaveLength(0);
  });
});

function fakeClient(handlers: {
  list?: (input: Record<string, unknown>) => Promise<unknown[]>;
  create?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  remove?: () => Promise<boolean>;
}): TwilioNumbersClient {
  const incoming = ((sid: string) => ({
    remove: handlers.remove ?? vi.fn(async () => sid.length > 0)
  })) as TwilioNumbersClient["incomingPhoneNumbers"];
  incoming.create = handlers.create ?? vi.fn(async () => ({ sid: "PN123", phoneNumber: "+14155550123" }));
  incoming.list = vi.fn(async () => []);
  return {
    availablePhoneNumbers: () => ({
      local: {
        list: handlers.list ?? vi.fn(async () => [])
      }
    }),
    incomingPhoneNumbers: incoming
  };
}
