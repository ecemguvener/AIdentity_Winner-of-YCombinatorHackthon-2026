import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { searchNumbers } from "./twilio-numbers.js";

describe("twilio live search smoke", () => {
  it.skipIf(process.env.TWILIO_LIVE_TEST !== "1")("searches live available numbers without purchasing", async () => {
    const config = loadConfig();
    const candidates = await searchNumbers(config, { country: config.TWILIO_NUMBER_COUNTRY || "US" });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]).toMatchObject({ voiceEnabled: true, smsEnabled: true });
  });
});
