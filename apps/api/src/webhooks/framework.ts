import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { MongoServerError, ObjectId } from "mongodb";
import { ZodError } from "zod";
import type { AppConfig } from "../config.js";
import type { Collections, WebhookEventDocument } from "../db.js";
import { ApiError } from "../errors.js";
import { recordWebhookEventMetric } from "../metrics.js";
import {
  verifyElevenLabsSignature,
  verifyStripeSignature,
  verifySvixSignature,
  verifyTwilioSignature
} from "./verify.js";

// ---------------------------------------------------------------------------
// Reusable webhook ingestion pipeline:
//   raw body capture → signature verification → exactly-once processing via
//   the `webhookEvents` unique {provider, providerEventId} index → dead-letter
//   visibility (`status: "failed"` + error text, retried on redelivery).
//
// Responses: handled outcomes always 200 (including idempotent replays as
// {skipped:true}); 5xx only when the handler crashes, so providers retry.
// ---------------------------------------------------------------------------

export type WebhookProvider = WebhookEventDocument["provider"];

export const WEBHOOK_PROVIDERS: readonly WebhookProvider[] = ["stripe", "twilio", "resend", "elevenlabs"];

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/** Thrown by verifiers/glue when a signature cannot be validated → 401. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export type WebhookVerifyFn = (
  rawBody: string,
  headers: Record<string, unknown>,
  config: AppConfig,
  request: FastifyRequest
) => void;

export interface WebhookRouteOptions {
  path: string;
  provider: WebhookProvider;
  verify: WebhookVerifyFn;
  validatePayload?: (payload: unknown) => void;
  extractEventId: (payload: unknown, request: FastifyRequest) => string | null;
  extractEventType: (payload: unknown) => string;
  handle: (payload: unknown, event: WebhookEventDocument) => Promise<unknown> | unknown;
  handleReplay?: (payload: unknown, event: WebhookEventDocument) => Promise<unknown> | unknown;
  responseContentType?: string;
}

/**
 * Content-type parsers that keep the exact raw request bytes on
 * `request.rawBody` for signature verification. JSON parses to an object;
 * urlencoded (Twilio) parses to a flat string record.
 */
export function registerRawBodyParsers(app: FastifyInstance): void {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    request.rawBody = typeof body === "string" ? body : "";
    if (typeof body !== "string" || body.trim() === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (error) {
      (error as Error & { statusCode?: number }).statusCode = 400;
      done(error as Error, undefined);
    }
  });

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (request, body, done) => {
    const raw = typeof body === "string" ? body : "";
    request.rawBody = raw;
    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(raw)) {
      params[key] = value;
    }
    done(null, params);
  });
}

export function registerWebhookRoute(
  app: FastifyInstance,
  collections: Collections,
  config: AppConfig,
  options: WebhookRouteOptions
): void {
  app.post(options.path, async (request, reply) => {
    const rawBody = request.rawBody ?? "";

    const mockBypass =
      mockSignatureAllowed(options.provider, config) && request.headers["x-mock-signature"] === "allow";
    if (!mockBypass) {
      try {
        options.verify(rawBody, request.headers as Record<string, unknown>, config, request);
      } catch (error) {
        // No agent is associated with an unverified delivery, so this cannot
        // go through the agent-scoped audit service; the structured log line
        // is the `webhook.signature_failed` audit trail for now.
        request.log.warn(
          { provider: options.provider, path: options.path, reason: (error as Error).message },
          "webhook.signature_failed"
        );
        throw new ApiError(401, "unauthorized", "invalid webhook signature");
      }
    }

    const payload = request.body;
    if (options.validatePayload) {
      try {
        options.validatePayload(payload);
      } catch (error) {
        if (error instanceof ZodError) {
          throw new ApiError(400, "validation_failed", error.issues[0]?.message ?? "invalid webhook payload");
        }
        throw error;
      }
    }
    const providerEventId = options.extractEventId(payload, request);
    if (!providerEventId) {
      throw new ApiError(400, "validation_failed", "missing provider event id");
    }

    const claim = await claimWebhookEvent(collections, {
      provider: options.provider,
      providerEventId,
      eventType: options.extractEventType(payload),
      payloadHash: crypto.createHash("sha256").update(rawBody).digest("hex")
    });
    if (!claim.claimed) {
      if (options.handleReplay) {
        const replayPayload = await options.handleReplay(payload, claim.event);
        if (replayPayload !== undefined) {
          return reply.code(200).send(replayPayload);
        }
      }
      return reply.code(200).send({ skipped: true });
    }

    let responsePayload: unknown;
    try {
      responsePayload = await options.handle(payload, claim.event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await collections.webhookEvents.updateOne(
        { _id: claim.event._id },
        { $set: { status: "failed", error: message.slice(0, 2000), updatedAt: new Date() } }
      );
      recordWebhookEventMetric(options.provider, "failed");
      request.log.error({ provider: options.provider, providerEventId, error }, "webhook handler failed");
      throw new ApiError(500, "internal", "webhook handler failed");
    }

    const finalStatus = isSkippedResponse(responsePayload) ? "skipped" : "processed";
    await collections.webhookEvents.updateOne(
      { _id: claim.event._id },
      { $set: { status: finalStatus, processedAt: new Date(), updatedAt: new Date() }, $unset: { error: "" } }
    );
    recordWebhookEventMetric(options.provider, finalStatus);
    if (options.responseContentType) {
      reply.type(options.responseContentType);
    }
    return reply.code(200).send(responsePayload !== undefined ? responsePayload : { ok: true, event_id: providerEventId });
  });
}

function isSkippedResponse(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { skipped?: unknown }).skipped === true);
}

/**
 * Exactly-once claim: the unique {provider, providerEventId} index arbitrates
 * concurrent deliveries — one insert wins and runs the handler, the loser sees
 * the duplicate and skips. Previously `failed` events (dead letters) can be
 * reclaimed exactly once per redelivery via the guarded findOneAndUpdate.
 */
async function claimWebhookEvent(
  collections: Collections,
  input: Pick<WebhookEventDocument, "provider" | "providerEventId" | "eventType" | "payloadHash">
): Promise<{ event: WebhookEventDocument; claimed: boolean }> {
  const now = new Date();
  const event: WebhookEventDocument = {
    _id: new ObjectId(),
    ...input,
    status: "received",
    createdAt: now,
    updatedAt: now
  };

  try {
    await collections.webhookEvents.insertOne(event);
    return { event, claimed: true };
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== 11000) {
      throw error;
    }
  }

  const existing = await collections.webhookEvents.findOne({
    provider: input.provider,
    providerEventId: input.providerEventId
  });
  if (!existing) {
    throw new Error("webhook event disappeared after duplicate key error");
  }
  if (existing.status !== "failed") {
    // received (another delivery is mid-flight), processed, or skipped.
    return { event: existing, claimed: false };
  }

  const reclaimed = await collections.webhookEvents.findOneAndUpdate(
    { _id: existing._id, status: "failed" },
    { $set: { status: "received", payloadHash: input.payloadHash, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!reclaimed) {
    return { event: existing, claimed: false };
  }
  return { event: reclaimed, claimed: true };
}

/**
 * Local/CI escape hatch: `x-mock-signature: allow` replaces verification only
 * when the relevant provider mode is mock AND no secret is configured — never
 * in live mode. Stripe billing is optional in development, so its ping route
 * is gated on non-production without a configured webhook secret.
 */
export function mockSignatureAllowed(provider: WebhookProvider, config: AppConfig): boolean {
  switch (provider) {
    case "resend":
      return config.PROVIDER_MODE_EMAIL === "mock" && !config.RESEND_WEBHOOK_SECRET;
    case "twilio":
      return config.PROVIDER_MODE_PHONE === "mock" && !config.TWILIO_AUTH_TOKEN;
    case "elevenlabs":
      return config.PROVIDER_MODE_PHONE === "mock" && !config.ELEVENLABS_WORKSPACE_WEBHOOK_SECRET;
    case "stripe":
      return config.NODE_ENV !== "production" && !config.STRIPE_WEBHOOK_SECRET;
  }
}

/** Standard verifier glue wiring each provider's secret from config. */
export function providerVerifier(provider: WebhookProvider): WebhookVerifyFn {
  switch (provider) {
    case "stripe":
      return (rawBody, headers, config) => {
        if (!config.STRIPE_WEBHOOK_SECRET) {
          throw new WebhookVerificationError("STRIPE_WEBHOOK_SECRET is not configured");
        }
        if (!verifyStripeSignature(config.STRIPE_WEBHOOK_SECRET, headers, rawBody)) {
          throw new WebhookVerificationError("invalid stripe signature");
        }
      };
    case "resend":
      return (rawBody, headers, config) => {
        if (!config.RESEND_WEBHOOK_SECRET) {
          throw new WebhookVerificationError("RESEND_WEBHOOK_SECRET is not configured");
        }
        if (!verifySvixSignature(config.RESEND_WEBHOOK_SECRET, headers, rawBody)) {
          throw new WebhookVerificationError("invalid svix signature");
        }
      };
    case "twilio":
      return (_rawBody, headers, config, request) => {
        if (!config.TWILIO_AUTH_TOKEN) {
          throw new WebhookVerificationError("TWILIO_AUTH_TOKEN is not configured");
        }
        const params = isStringRecord(request.body) ? request.body : {};
        // Twilio signs the public URL it was configured to call.
        const url = `${config.PUBLIC_API_URL}${request.raw.url ?? request.url}`;
        const signature = request.headers["x-twilio-signature"];
        if (!verifyTwilioSignature(config.TWILIO_AUTH_TOKEN, url, params, typeof signature === "string" ? signature : undefined)) {
          throw new WebhookVerificationError("invalid twilio signature");
        }
      };
    case "elevenlabs":
      return (rawBody, headers, config) => {
        if (!config.ELEVENLABS_WORKSPACE_WEBHOOK_SECRET) {
          throw new WebhookVerificationError("ELEVENLABS_WORKSPACE_WEBHOOK_SECRET is not configured");
        }
        if (!verifyElevenLabsSignature(config.ELEVENLABS_WORKSPACE_WEBHOOK_SECRET, headers, rawBody)) {
          throw new WebhookVerificationError("invalid elevenlabs signature");
        }
      };
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every((entry) => typeof entry === "string")
  );
}
