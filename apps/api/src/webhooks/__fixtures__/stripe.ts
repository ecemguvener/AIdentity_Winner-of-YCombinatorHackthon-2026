import { Stripe } from "../../providers/stripe-client.js";

export const stripeFixtureSecret = "whsec_stripe_fixture_secret";

export interface SignedStripeFixture<TEvent extends Stripe.Event> {
  event: TEvent;
  body: string;
  signature: string;
}

export function signStripeFixture<TEvent extends Stripe.Event>(
  event: TEvent,
  secret = stripeFixtureSecret
): SignedStripeFixture<TEvent> {
  const body = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret });
  return { event, body, signature };
}

export function checkoutSessionCompleted(
  overrides: Partial<Stripe.CheckoutSessionCompletedEvent> = {}
): Stripe.CheckoutSessionCompletedEvent {
  return {
    id: "evt_checkout_completed",
    object: "event",
    api_version: "2026-06-24.dahlia",
    created: 1783454400,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_completed",
        object: "checkout.session",
        customer: "cus_test_123",
        subscription: "sub_test_123",
        mode: "subscription",
        payment_status: "paid"
      } as Stripe.Checkout.Session
    },
    ...overrides
  } as Stripe.CheckoutSessionCompletedEvent;
}

export function customerSubscriptionCreated(
  overrides: Partial<Stripe.CustomerSubscriptionCreatedEvent> = {}
): Stripe.CustomerSubscriptionCreatedEvent {
  return subscriptionEvent("evt_subscription_created", "customer.subscription.created", overrides);
}

export function customerSubscriptionUpdated(
  overrides: Partial<Stripe.CustomerSubscriptionUpdatedEvent> = {}
): Stripe.CustomerSubscriptionUpdatedEvent {
  return subscriptionEvent("evt_subscription_updated", "customer.subscription.updated", overrides);
}

export function customerSubscriptionDeleted(
  overrides: Partial<Stripe.CustomerSubscriptionDeletedEvent> = {}
): Stripe.CustomerSubscriptionDeletedEvent {
  return subscriptionEvent("evt_subscription_deleted", "customer.subscription.deleted", overrides);
}

export function invoicePaymentFailed(
  overrides: Partial<Stripe.InvoicePaymentFailedEvent> = {}
): Stripe.InvoicePaymentFailedEvent {
  return {
    id: "evt_invoice_payment_failed",
    object: "event",
    api_version: "2026-06-24.dahlia",
    created: 1783454400,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: "invoice.payment_failed",
    data: {
      object: {
        id: "in_test_failed",
        object: "invoice",
        customer: "cus_test_123",
        subscription: "sub_test_123",
        status: "open"
      } as unknown as Stripe.Invoice
    },
    ...overrides
  } as Stripe.InvoicePaymentFailedEvent;
}

function subscriptionEvent<TEvent extends Stripe.Event>(
  id: string,
  type: TEvent["type"],
  overrides: Partial<TEvent>
): TEvent {
  return {
    id,
    object: "event",
    api_version: "2026-06-24.dahlia",
    created: 1783454400,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: {
      object: {
        id: "sub_test_123",
        object: "subscription",
        customer: "cus_test_123",
        status: "active"
      } as Stripe.Subscription
    },
    ...overrides
  } as TEvent;
}
