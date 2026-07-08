import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  verifyElevenLabsSignature,
  verifyStripeSignature,
  verifySvixSignature,
  verifyTwilioSignature
} from "./verify.js";

// Fixtures are generated with the same HMAC construction inverted: each
// helper builds a known-good signature for a payload, and tests then assert
// acceptance plus rejection after flipping a single byte of the payload.

function nowSeconds(offsetSeconds = 0): string {
  return String(Math.floor(Date.now() / 1000) + offsetSeconds);
}

function flipFirstByte(body: string): string {
  return String.fromCharCode(body.charCodeAt(0) ^ 1) + body.slice(1);
}

describe("verifyStripeSignature", () => {
  const secret = "whsec_stripe_test_secret";
  const body = JSON.stringify({ id: "evt_1PXYZ", type: "invoice.paid" });

  function sign(timestamp: string, payload: string): string {
    const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
    return `t=${timestamp},v1=${signature}`;
  }

  it("accepts a correctly signed, fresh payload", () => {
    const timestamp = nowSeconds();
    expect(verifyStripeSignature(secret, { "stripe-signature": sign(timestamp, body) }, body)).toBe(true);
  });

  it("accepts when one of several v1 signatures matches", () => {
    const timestamp = nowSeconds();
    const header = `t=${timestamp},v1=${"0".repeat(64)},${sign(timestamp, body).split(",")[1]}`;
    expect(verifyStripeSignature(secret, { "stripe-signature": header }, body)).toBe(true);
  });

  it("rejects a payload with one byte flipped", () => {
    const timestamp = nowSeconds();
    expect(verifyStripeSignature(secret, { "stripe-signature": sign(timestamp, body) }, flipFirstByte(body))).toBe(false);
  });

  it("rejects a timestamp outside the 300s tolerance", () => {
    const timestamp = nowSeconds(-400);
    expect(verifyStripeSignature(secret, { "stripe-signature": sign(timestamp, body) }, body)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyStripeSignature(secret, {}, body)).toBe(false);
  });
});

describe("verifySvixSignature", () => {
  const secret = `whsec_${Buffer.from("svix-signing-key-for-tests").toString("base64")}`;
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_123" } });

  function headers(id: string, timestamp: string, payload: string): Record<string, unknown> {
    const key = Buffer.from(secret.slice("whsec_".length), "base64");
    const signature = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`).digest("base64");
    return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` };
  }

  it("accepts a correctly signed, fresh payload", () => {
    expect(verifySvixSignature(secret, headers("msg_1", nowSeconds(), body), body)).toBe(true);
  });

  it("rejects a payload with one byte flipped", () => {
    expect(verifySvixSignature(secret, headers("msg_1", nowSeconds(), body), flipFirstByte(body))).toBe(false);
  });

  it("rejects a stale timestamp", () => {
    expect(verifySvixSignature(secret, headers("msg_1", nowSeconds(-4000), body), body)).toBe(false);
  });
});

describe("verifyTwilioSignature", () => {
  const authToken = "twilio-auth-token-for-tests";
  const url = "https://aidentity.space/webhooks/twilio/sms";
  const params = { MessageSid: "SM123", MessageStatus: "delivered", To: "+15550100", From: "+15550111" };

  function sign(targetUrl: string, targetParams: Record<string, string>): string {
    const signedContent =
      targetUrl +
      Object.keys(targetParams)
        .sort()
        .map((key) => key + targetParams[key])
        .join("");
    return crypto.createHmac("sha1", authToken).update(signedContent).digest("base64");
  }

  it("accepts a correctly signed form post", () => {
    expect(verifyTwilioSignature(authToken, url, params, sign(url, params))).toBe(true);
  });

  it("rejects a tampered parameter value", () => {
    expect(verifyTwilioSignature(authToken, url, { ...params, MessageStatus: "failed" }, sign(url, params))).toBe(false);
  });

  it("rejects a different URL", () => {
    expect(verifyTwilioSignature(authToken, "https://evil.example/webhooks", params, sign(url, params))).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyTwilioSignature(authToken, url, params, undefined)).toBe(false);
  });
});

describe("verifyElevenLabsSignature", () => {
  const secret = "wsec_elevenlabs_test_secret";
  const body = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "conv_1" } });

  function header(timestamp: string, payload: string): string {
    const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
    return `t=${timestamp},v0=${signature}`;
  }

  it("accepts a correctly signed, fresh payload", () => {
    expect(verifyElevenLabsSignature(secret, { "elevenlabs-signature": header(nowSeconds(), body) }, body)).toBe(true);
  });

  it("accepts within the 30 minute tolerance", () => {
    expect(verifyElevenLabsSignature(secret, { "elevenlabs-signature": header(nowSeconds(-25 * 60), body) }, body)).toBe(true);
  });

  it("rejects a payload with one byte flipped", () => {
    expect(verifyElevenLabsSignature(secret, { "elevenlabs-signature": header(nowSeconds(), body) }, flipFirstByte(body))).toBe(
      false
    );
  });

  it("rejects a timestamp older than 30 minutes", () => {
    expect(verifyElevenLabsSignature(secret, { "elevenlabs-signature": header(nowSeconds(-31 * 60), body) }, body)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyElevenLabsSignature(secret, {}, body)).toBe(false);
  });
});
