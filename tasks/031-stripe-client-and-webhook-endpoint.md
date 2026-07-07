model: fable 5

# Task 031 — Stripe foundation (billing only): client, webhook endpoint, remove fake payment stack

## Depends on
003, 009

## Context
The agent **card capability is deferred** (no Stripe Issuing in this plan — tasks 032–040 are intentionally reserved/empty; the website markets cards as "Coming soon", task 055). Stripe is used for **SaaS billing only** (Phase 5: subscriptions + metered usage). This task lays that plumbing and removes the fake payment demo code so no mock card/purchase surface survives.

## Objective
Stripe SDK wiring, one verified webhook endpoint with an event dispatcher, a local test harness — and the legacy mock-payments code deleted.

## Spec
- Add `stripe` SDK. `apps/api/src/providers/stripe-client.ts`: singleton from `STRIPE_SECRET_KEY`, `apiVersion` pinned to current, `timeout: 10_000`, `maxNetworkRetries: 2` (safe: Stripe dedupes by idempotency key), typed re-export.
- Webhook endpoint via framework 009 with `verifyStripeSignature` (switch verifier internals to `stripe.webhooks.constructEvent`):
  - `POST /webhooks/stripe` — secret `STRIPE_WEBHOOK_SECRET`. Internal dispatcher `registerStripeEventHandler(eventType, handler)`; tasks 041/042 register handlers. Unhandled types → `skipped`.
- Config assertions (extend task 003 superRefine): billing routes require `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` when used (guard at route registration, not boot — billing is optional in dev).
- **Remove the fake payment stack** (the old demo's biggest lie):
  - Delete `apps/api/src/payments.ts` (mockCharge/mockCreateCard, in-memory stores, purchase parsing) and its route registrations in `app.ts` (`/api/tools/payments/*`, site payment routes).
  - Delete purchase/card handling from `identity.ts` and the `payments`-related tools from `dashboard-chat.ts` (chat replies "card capability coming soon" if asked).
  - Delete `payments.test.ts`; sweep web `api.ts` client methods that called those routes (UI panel removal is task 011/012).
  - `grep -rn "mockCharge\|mockCreateCard\|request-purchase\|preq_" apps/` → zero after this task.
- Test harness:
  - `docs/payments-setup.md`: Stripe CLI setup — `stripe listen --forward-to localhost:4001/webhooks/stripe`, copying `whsec_...` into env; `stripe trigger` cookbook for billing events.
  - Fixture builders `apps/api/src/webhooks/__fixtures__/stripe.ts`: typed builders for the events Phase 5 consumes (`checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.payment_failed`), signed with the real signature algorithm + test secret so verification paths run for real in tests.

## Implementation steps
1. SDK + client module (unit test: config wiring, no network).
2. Dispatcher + endpoint; fixture builders + framework integration tests: valid signature happy path, tampered 401, replay skip, unhandled type skip, dispatcher routing.
3. Fake-payments removal + grep sweep + fix any broken imports/tests.
4. Harness doc + `npm --workspace @barkan/api run stripe:listen` convenience script (requires Stripe CLI installed).

## Acceptance criteria
- `stripe trigger checkout.session.completed` (CLI) reaches the dispatcher and records a `webhookEvents` row `processed|skipped`.
- Zero mock-payment code remains (`grep` sweep above); API boots and full test suite green after removal.
- Wrong-secret events rejected 401 with `webhook.signature_failed` audit.

## How to test
```bash
npm --workspace @barkan/api run test -- stripe-client stripe-webhooks
stripe listen --forward-to localhost:4001/webhooks/stripe &
stripe trigger checkout.session.completed
mongosh barkan --eval 'db.webhookEvents.find({provider:"stripe"}).sort({_id:-1}).limit(1).toArray()'
grep -rn "mockCharge\|mockCreateCard\|request-purchase" apps/ || echo CLEAN
```
