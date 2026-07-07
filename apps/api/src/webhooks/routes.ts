import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Collections, WebhookEventDocument } from "../db.js";
import { requireAuth } from "../auth.js";
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
