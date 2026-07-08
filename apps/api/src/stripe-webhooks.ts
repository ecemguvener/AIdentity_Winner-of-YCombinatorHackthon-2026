import type { Stripe } from "./providers/stripe-client.js";
import type { WebhookEventDocument } from "./db.js";

export type StripeEventHandler = (
  stripeEvent: Stripe.Event,
  webhookEvent: WebhookEventDocument
) => Promise<unknown> | unknown;

const handlers = new Map<string, StripeEventHandler>();

export function registerStripeEventHandler(eventType: string, handler: StripeEventHandler): void {
  handlers.set(eventType, handler);
}

export function clearStripeEventHandlersForTest(): void {
  handlers.clear();
}

export async function dispatchStripeWebhook(payload: unknown, webhookEvent: WebhookEventDocument): Promise<unknown> {
  const stripeEvent = payload as Stripe.Event;
  const handler = handlers.get(stripeEvent.type);
  if (!handler) {
    return { skipped: true, event_id: stripeEvent.id, event_type: stripeEvent.type };
  }

  return await handler(stripeEvent, webhookEvent) ?? { ok: true, event_id: stripeEvent.id, event_type: stripeEvent.type };
}

export function readStripeEventId(payload: unknown): string | null {
  return isStripeEventLike(payload) ? payload.id : null;
}

export function readStripeEventType(payload: unknown): string {
  return isStripeEventLike(payload) ? payload.type : "unknown";
}

function validateStripeEventPayload(payload: unknown): void {
  if (!isStripeEventLike(payload)) {
    throw new Error("invalid Stripe event payload");
  }
}

function isStripeEventLike(value: unknown): value is { id: string; type: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { id?: unknown }).id === "string" &&
      typeof (value as { type?: unknown }).type === "string"
  );
}
