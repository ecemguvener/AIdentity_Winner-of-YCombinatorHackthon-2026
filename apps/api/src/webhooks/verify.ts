import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Per-provider webhook signature verifiers. All are pure functions over the
// exact raw request bytes (plus headers/URL) so they can be unit-tested with
// fixture payloads. Each returns a boolean; the framework translates a false
// result into a 401.
// ---------------------------------------------------------------------------

const STRIPE_TOLERANCE_SECONDS = 300;
const SVIX_TOLERANCE_SECONDS = 300;
const ELEVENLABS_TOLERANCE_SECONDS = 30 * 60;

/**
 * Stripe `Stripe-Signature` header: `t=<ts>,v1=<hex hmac>,v1=...` where each
 * v1 is HMAC-SHA256(secret, `${t}.${rawBody}`) in hex, tolerance 300s.
 * (Real captured format: `t=1714000000,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd`.)
 * Task 031 may swap this for stripe.webhooks.constructEvent; the wire format
 * is identical so fixtures stay valid.
 */
export function verifyStripeSignature(secret: string, headers: Record<string, unknown>, rawBody: string): boolean {
  const header = asString(headers["stripe-signature"]);
  if (!header) {
    return false;
  }

  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (key === "t") {
      timestamp = value;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  if (!timestamp || signatures.length === 0 || !isFreshTimestampSeconds(timestamp, STRIPE_TOLERANCE_SECONDS)) {
    return false;
  }

  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return signatures.some((signature) => timingSafeEqualStrings(signature, expected));
}

/**
 * Svix (used by Resend): `svix-id`/`svix-timestamp`/`svix-signature` headers,
 * signature `v1,<base64 hmac>` of `${id}.${timestamp}.${rawBody}` with the
 * base64-decoded `whsec_` secret, tolerance 300s. Ported from `email.ts`
 * (`verifyResendSignature`), which this supersedes once the email inbound
 * route moves onto the framework.
 * (Real captured format: `svix-signature: v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=`.)
 */
export function verifySvixSignature(secret: string, headers: Record<string, unknown>, rawBody: string): boolean {
  const id = asString(headers["svix-id"]);
  const timestamp = asString(headers["svix-timestamp"]);
  const signatureHeader = asString(headers["svix-signature"]);
  if (!id || !timestamp || !signatureHeader || !isFreshTimestampSeconds(timestamp, SVIX_TOLERANCE_SECONDS)) {
    return false;
  }

  const key = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(key, "base64");
  } catch {
    return false;
  }

  const expected = crypto.createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  return signatureHeader.split(" ").some((part) => {
    const commaIndex = part.indexOf(",");
    const value = commaIndex === -1 ? part : part.slice(commaIndex + 1);
    return timingSafeEqualStrings(value, expected);
  });
}

/**
 * Twilio `X-Twilio-Signature`: base64 HMAC-SHA1 with the account auth token
 * over the full webhook URL followed by every POST parameter key+value,
 * sorted by key. Twilio posts `application/x-www-form-urlencoded`.
 * (Real captured format: `X-Twilio-Signature: 0/KCTR6DLpKmkAf8muzZqo1nDgQ=`.)
 */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signatureHeader: string | undefined
): boolean {
  if (!signatureHeader) {
    return false;
  }
  const signedContent =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join("");
  const expected = crypto.createHmac("sha1", authToken).update(signedContent).digest("base64");
  return timingSafeEqualStrings(signatureHeader, expected);
}

/**
 * ElevenLabs `ElevenLabs-Signature` header: `t=<ts>,v0=<hex hmac>` where v0 is
 * HMAC-SHA256(secret, `${ts}.${rawBody}`) in hex, tolerance 30 minutes.
 * (Real captured format: `t=1714000000,v0=8022a1eb6c33d3b7d8b74a0f47a621eb0f04c9142d701e4f8dbc1cd4e3d4a613`.)
 */
export function verifyElevenLabsSignature(secret: string, headers: Record<string, unknown>, rawBody: string): boolean {
  const header = asString(headers["elevenlabs-signature"]);
  if (!header) {
    return false;
  }

  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (key === "t") {
      timestamp = value;
    } else if (key === "v0") {
      signatures.push(value);
    }
  }
  if (!timestamp || signatures.length === 0 || !isFreshTimestampSeconds(timestamp, ELEVENLABS_TOLERANCE_SECONDS)) {
    return false;
  }

  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return signatures.some((signature) => timingSafeEqualStrings(signature, expected));
}

function isFreshTimestampSeconds(timestamp: string, toleranceSeconds: number): boolean {
  const timestampSeconds = Number(timestamp);
  return Number.isFinite(timestampSeconds) && Math.abs(Date.now() / 1000 - timestampSeconds) <= toleranceSeconds;
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBytes = Buffer.from(a);
  const bBytes = Buffer.from(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBytes, bBytes);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
