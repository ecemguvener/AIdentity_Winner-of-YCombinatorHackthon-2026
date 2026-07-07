import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Collections, WebhookEventDocument } from "../db.js";
import { requireAuth } from "../auth.js";
import { AUDIT_ACTIONS, recordAudit } from "../audit.js";
import { ingestResendReceivedEmail } from "../email-service.js";
import {
  handleElevenLabsPersonalization,
  replayElevenLabsPersonalization,
  validateElevenLabsPersonalizationPayload
} from "../phone-personalization.js";
import { createEmailInboundClient } from "../providers/email-provider.js";
import {
  WEBHOOK_PROVIDERS,
  mockSignatureAllowed,
  providerVerifier,
  registerWebhookRoute
} from "./framework.js";

const webhookEventsQuerySchema = z.object({
  provider: z.enum(["stripe", "twilio", "resend", "elevenlabs"]).optional(),
  status: z.enum(["received", "processed", "failed", "skipped"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

export function registerWebhookRoutes(app: FastifyInstance, collections: Collections, config: AppConfig): void {
  const inboundClient = config.RESEND_API_KEY ? createEmailInboundClient(config) : null;
  registerWebhookRoute(app, collections, config, {
    path: "/webhooks/resend",
    provider: "resend",
    verify: providerVerifier("resend"),
    extractEventId: (payload) => (isRecord(payload) && typeof payload.id === "string" ? payload.id : null),
    extractEventType: (payload) => (isRecord(payload) && typeof payload.type === "string" ? payload.type : "unknown"),
    handle: (payload) => handleResendWebhook(payload, collections, config, inboundClient)
  });

  registerWebhookRoute(app, collections, config, {
    path: "/webhooks/elevenlabs/personalization",
    provider: "elevenlabs",
    verify: providerVerifier("elevenlabs"),
    validatePayload: validateElevenLabsPersonalizationPayload,
    extractEventId: (payload) => (isRecord(payload) && typeof payload.call_sid === "string" ? payload.call_sid : null),
    extractEventType: () => "conversation.personalization",
    handle: (payload) => handleElevenLabsPersonalization(collections, payload),
    handleReplay: (payload) => replayElevenLabsPersonalization(collections, payload)
  });

  // Ops visibility into the dead-letter queue (e.g. ?status=failed). Session
  // auth for now; owner-agnostic admin scoping lands in a later task.
  app.get("/api/v1/webhook-events", async (request, reply) => {
    await requireAuth(request, reply, collections, config);
    const query = webhookEventsQuerySchema.parse(request.query ?? {});
    const events = await collections.webhookEvents
      .find({
        ...(query.provider ? { provider: query.provider } : {}),
        ...(query.status ? { status: query.status } : {})
      })
      .sort({ createdAt: -1 })
      .limit(query.limit)
      .toArray();
    return { events: events.map(serializeWebhookEvent) };
  });

  // Dev-only pipeline smoke routes, registered only where the mock-signature
  // bypass applies (mock provider mode, no secret configured).
  for (const provider of WEBHOOK_PROVIDERS) {
    if (!mockSignatureAllowed(provider, config)) {
      continue;
    }
    registerWebhookRoute(app, collections, config, {
      path: `/webhooks/ping/${provider}`,
      provider,
      verify: providerVerifier(provider),
      extractEventId: (payload) => (isRecord(payload) && typeof payload.id === "string" ? payload.id : null),
      extractEventType: (payload) => (isRecord(payload) && typeof payload.type === "string" ? payload.type : "ping"),
      handle: () => {}
    });
  }
}

async function handleResendWebhook(
  payload: unknown,
  collections: Collections,
  config: AppConfig,
  inboundClient: ReturnType<typeof createEmailInboundClient> | null
): Promise<void> {
  if (isRecord(payload) && payload.type === "email.received") {
    if (!inboundClient) {
      throw new Error("RESEND_API_KEY is required to fetch inbound email content");
    }
    await ingestResendReceivedEmail(collections, config, inboundClient, payload);
    return;
  }
  await handleResendLifecycle(payload, collections);
}

async function handleResendLifecycle(payload: unknown, collections: Collections): Promise<void> {
  if (!isRecord(payload) || typeof payload.type !== "string" || !isRecord(payload.data)) {
    return;
  }
  const status = resendStatusForEvent(payload.type);
  if (!status) {
    return;
  }
  const providerMessageId = readProviderMessageId(payload.data);
  if (!providerMessageId) {
    return;
  }
  const updated = await collections.emailMessages.findOneAndUpdate(
    { providerMessageId },
    { $set: { status, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!updated || (payload.type !== "email.bounced" && payload.type !== "email.complained")) {
    return;
  }
  await recordAudit(collections, {
    agentId: updated.agentId,
    actor: "system",
    action: AUDIT_ACTIONS.email.blocked,
    status: "blocked",
    detail: `${payload.type} for ${updated.toEmail}: ${updated.subject}`,
    resourceType: "emailMessage",
    resourceId: updated._id.toHexString(),
    metadata: { providerMessageId }
  });
}

function resendStatusForEvent(eventType: string) {
  if (eventType === "email.sent") return "sent";
  if (eventType === "email.delivered") return "delivered";
  if (eventType === "email.bounced") return "bounced";
  if (eventType === "email.complained") return "failed";
  return null;
}

function readProviderMessageId(data: Record<string, unknown>): string | null {
  for (const key of ["email_id", "message_id", "id"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function serializeWebhookEvent(event: WebhookEventDocument) {
  return {
    id: event._id.toHexString(),
    provider: event.provider,
    provider_event_id: event.providerEventId,
    event_type: event.eventType,
    status: event.status,
    error: event.error ?? null,
    processed_at: event.processedAt ? event.processedAt.toISOString() : null,
    created_at: event.createdAt.toISOString(),
    updated_at: event.updatedAt.toISOString()
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
