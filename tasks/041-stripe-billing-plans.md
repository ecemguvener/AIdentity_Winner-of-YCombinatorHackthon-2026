model: fable 5

# Task 041 — SaaS billing: plans, subscriptions, customer portal

## Depends on
031

## Context
The business needs revenue. Model: subscription plans + usage-based metering (task 042). Stripe Billing with Checkout for subscribe and the hosted Customer Portal for self-serve management. `billingAccounts` collection exists (task 004).

## Objective
Plan catalog, subscribe/upgrade/cancel flows, subscription state sync — the commercial skeleton.

## Spec
- Plan catalog (constants + bootstrap script, not hardcoded price ids):
  ```
  free : €0        — 1 agent, email only, 50 emails/mo, community support
  pro  : €29/mo    — 3 agents, email+phone, 1 phone number incl., 500 emails, 120 call min, 200 SMS incl., then metered overage
  scale: €99/mo    — 10 agents, 3 numbers incl., 2000 emails, 600 call min, 1000 SMS, priority support
  ```
  Overage prices (metered, task 042): €0.02/email, €0.15/call-min, €0.05/SMS, €2.00/number/mo beyond included.
- Bootstrap script `npm --workspace @barkan/api run stripe:bootstrap-billing`: idempotently creates Products/Prices (+ meters in 042) by `lookup_key` (`barkan_pro_monthly`…), prints ids → env/config map `BILLING_PRICE_PRO`, `BILLING_PRICE_SCALE` (read from env; script offers `--write-env`).
- `apps/api/src/billing.ts`:
  - `ensureBillingAccount(collections, config, user)` — create Stripe Customer (`metadata.barkanUserId`) + `billingAccounts` row lazily (called at signup + on first billing route).
  - `POST /api/v1/billing/checkout { plan: "pro"|"scale" }` → subscription-mode Checkout Session → `{ checkoutUrl }`.
  - `POST /api/v1/billing/portal` → `stripe.billingPortal.sessions.create` → `{ portalUrl }` (return URL `PUBLIC_APP_URL/settings/billing`).
  - `GET /api/v1/billing` → plan, status, period end, included-usage snapshot (wired fully in 042/043).
  - Dispatcher handlers: `customer.subscription.created|updated|deleted` → sync `plan` (via price lookup_key), `subscriptionStatus`, `currentPeriodEnd`; `invoice.payment_failed` → status `past_due` + owner email + audit `billing.payment_failed`.
- Plan changes take effect via webhook only (never trust redirect query params).
- Downgrade guard: deny checkout to a plan whose limits are below current usage (e.g. 5 agents → pro) with actionable 409 listing what to remove — implement check against live counts.

## Implementation steps
1. Bootstrap script (idempotent by lookup_key; safe re-run) + doc in `docs/payments-setup.md`.
2. Billing module + routes + webhook sync with fixture tests (subscription lifecycle, price→plan mapping, past_due flow, downgrade guard).
3. Signup hook: `ensureBillingAccount` (plan `free`).
4. Live test-mode drill: subscribe to pro with 4242 card via real Checkout, verify webhook flips plan, open portal, cancel, verify downgrade at period end state.

## Acceptance criteria
- `billingAccounts` always converges to Stripe truth after any webhook replay/out-of-order delivery (guard by `subscription.updated` timestamps — test out-of-order).
- Downgrade guard blocks with the precise blocking resources listed.
- Full subscribe→portal→cancel drill works against test mode.

## How to test
```bash
npm --workspace @barkan/api run stripe:bootstrap-billing
npm --workspace @barkan/api run test -- billing
curl -s -X POST localhost:4001/api/v1/billing/checkout -H "cookie: $COOKIE" -H 'content-type: application/json' -d '{"plan":"pro"}' | jq -r .checkoutUrl
# pay with 4242..., then:
curl -s localhost:4001/api/v1/billing -H "cookie: $COOKIE" | jq '{plan, subscriptionStatus}'
```
