# Stripe Billing Setup

Barkan uses Stripe for SaaS billing only. Agent card and Issuing capability are deferred.

## Environment

Set both values before using the Stripe webhook endpoint:

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
BILLING_PRICE_PRO=price_...
BILLING_PRICE_SCALE=price_...
```

The API registers `POST /webhooks/stripe` only when both are configured.

## Bootstrap Plans

Create or reuse Stripe Products/Prices by lookup key:

```bash
npm --workspace @barkan/api run stripe:bootstrap-billing
npm --workspace @barkan/api run stripe:bootstrap-billing -- --write-env
```

Plan prices:

- `free`: €0, 1 agent, email only, 50 emails/month
- `pro`: €29/month, 3 agents, 1 phone number, 500 emails, 120 call minutes, 200 SMS
- `scale`: €99/month, 10 agents, 3 phone numbers, 2000 emails, 600 call minutes, 1000 SMS

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
