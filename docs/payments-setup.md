# Stripe Billing Setup

Barkan uses Stripe for SaaS billing only. Agent card and Issuing capability are deferred.

## Environment

Set both values before using the Stripe webhook endpoint:

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

The API registers `POST /webhooks/stripe` only when both are configured.

## Local Webhook

Install and log in to the Stripe CLI, then forward events:

```bash
stripe login
npm --workspace @barkan/api run stripe:listen
```

Copy the printed `whsec_...` value into `STRIPE_WEBHOOK_SECRET`.

## Trigger Cookbook

```bash
stripe trigger checkout.session.completed
stripe trigger customer.subscription.created
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted
stripe trigger invoice.payment_failed
```

Confirm delivery:

```bash
mongosh barkan --eval 'db.webhookEvents.find({provider:"stripe"}).sort({_id:-1}).limit(1).toArray()'
```

Unhandled events are recorded as `skipped`. Phase 5 billing tasks register handlers for subscription and invoice event types.
