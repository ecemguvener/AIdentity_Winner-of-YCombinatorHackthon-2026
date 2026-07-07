model: gpt 5.5

# Task 042 — Usage metering: count everything, report overage to Stripe

## Depends on
041 (+ hooks left in 017/026/027)

## Context
Tasks 017/026/027 left no-op usage hooks (`emails_sent`, `call_minutes`, `sms_messages`); numbers have monthly cost (`active_numbers`). Stripe's modern usage-based stack: **Billing Meters** — create meters, push meter events (`stripe.billing.meterEvents.create({ event_name, payload: { stripe_customer_id, value } })`), attach metered prices to the subscription for overage.

## Objective
Reliable usage pipeline: local `usageEvents` ledger → aggregated → reported to Stripe meters for amounts beyond plan-included quantities.

## Spec
- `apps/api/src/usage.ts`:
  - `recordUsage(collections, { ownerUserId, agentId, meter, quantity })` — insert `usageEvents` with `periodKey` (billing-period key `YYYY-MM` anchored to `currentPeriodEnd`; fallback calendar month for free plan), `stripeReported: false`. Wire the three capability hooks + a daily `active_numbers` sampler job (count active rows → one event/day/number).
  - `getUsageSummary(collections, ownerUserId, periodKey) -> { perMeter: { used, included, overage } }` — included amounts from the plan catalog (041).
  - Reporter job (every 5 min + on-demand script `npm run usage:report`): for each billing account with an active paid subscription, sum unreported events, compute overage beyond included (cumulative within period: report only the delta above included, tracked via a `usageReports` cursor doc per account/meter/period), push meter events, mark rows `stripeReported`. Free plan: never reported (quota enforcement is task 043's job).
  - Bootstrap: extend `stripe:bootstrap-billing` (041) to create the 4 meters + metered overage prices bound to them, added to pro/scale subscriptions as secondary items.
- Idempotency: meter events pushed with deterministic `identifier` (`<account>_<meter>_<period>_<seq>`) so retries don't double-bill.
- `GET /api/v1/billing/usage` → current period summary per meter (drives UI in 044).

## Implementation steps
1. Usage module + hooks wiring + sampler + tests (periodKey anchoring around period rollover, included-vs-overage math table: used 480/included 500 → 0 reported; 520 → 20; next batch 530 → +10).
2. Reporter with injected Stripe client; failure retry (report marks only on success); concurrency lock per account (simple findAndModify lease).
3. Meter bootstrap extension + doc.
4. Live drill: pro-subscribed test account, generate 30 mock emails, run reporter, see meter events in Stripe dashboard (Billing → Meters) and preview upcoming invoice line items.

## Acceptance criteria
- Overage math proven by table-driven tests including period rollover and out-of-order recording.
- Reporter crash between push and mark cannot double-report (identifier idempotency asserted with fake client capturing identifiers).
- Upcoming invoice in the drill shows the expected overage line.

## How to test
```bash
npm --workspace @barkan/api run test -- usage
npm --workspace @barkan/api run usage:report -- --dry-run   # prints per-account deltas
curl -s localhost:4001/api/v1/billing/usage -H "cookie: $COOKIE" | jq .
stripe billing meters list
```
