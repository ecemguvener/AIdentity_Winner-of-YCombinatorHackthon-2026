model: gpt 5.5

# Task 044 — Billing UI: plans, usage, invoices, ops status

## Depends on
011, 041, 042, 043

## Context
Billing endpoints exist (`/api/v1/billing*`); Settings needs the commercial surface. Also fold in the ops status views deferred from earlier tasks (email domain 015).

## Spec
- **Settings → Billing** (`/settings/billing`):
  - Current plan card: name, price, status pill (`active`, `past_due` warning with fix-payment CTA → portal), renewal date, cancel note when `cancel_at_period_end`.
  - Plan comparison grid (free/pro/scale from the entitlements catalog — render from a `/api/v1/billing/plans` endpoint added here so web never hardcodes limits): feature rows, current plan highlighted, Upgrade/Downgrade buttons → checkout (upgrade) with downgrade-guard 409 errors rendered as the blocking-resources list.
  - Usage section: per-meter progress bars (used / included, overage amount + projected cost) from `/api/v1/billing/usage`.
  - "Manage payment method & invoices" → portal redirect (invoices live in the Stripe portal — no custom invoice UI in v1).
- **Settings → Platform status** (small ops card): email domain verification state (task 015 route) with per-record copy buttons for missing DNS; provider modes (email/phone live|mock) via a `GET /api/v1/ops/status` endpoint added here (session auth): `{ providerModes, emailDomainVerified, stripeWebhookLastSeenAt, twilioNumbers: count }` — the "is everything wired" glance for the operator.
- Global: plan badge in the sidebar footer (plan name + usage warning dot when any meter > 80%).

## Implementation steps
1. `GET /api/v1/billing/plans` + `GET /api/v1/ops/status` endpoints + tests.
2. Billing page per spec; upgrade/downgrade/portal flows with redirect handling.
3. Ops status card; sidebar badge.
4. Component tests: past_due banner, downgrade 409 rendering, usage bar math (80% warning), plan grid renders from API data.

## Acceptance criteria
- Subscribe → return from Checkout → plan card reflects Pro within one webhook cycle (poll `/api/v1/billing` on landing).
- Usage bars match `usageEvents` truth for a seeded account.
- Ops card correctly reports a missing DNS record and last webhook timestamps.

## How to test
```bash
npm --workspace @barkan/web run test -- billing
curl -s localhost:4001/api/v1/ops/status -H "cookie: $COOKIE" | jq .
# Manual drill: full subscribe/cancel via UI in test mode.
```
