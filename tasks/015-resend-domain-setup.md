model: gpt 5.5

# Task 015 — Email infrastructure: Resend domain automation (send + receive)

## Depends on
003, 009

## Context
Agents need real addresses like `maya-a1b2@agents.<domain>` that can **send and receive**. Research decision: Resend supports both — sending domains (SPF/DKIM DNS records) and receiving via an MX record on the same subdomain, delivering `email.received` webhooks for *any* address at that domain (route by `to`). Current code has Resend send-only with a sandbox redirect hack (`EMAIL_SANDBOX_REDIRECT_TO` in `config.ts`).

## Objective
Programmatic domain lifecycle + verification status surfaced to the operator, so email capability can be turned live with a checklist instead of tribal knowledge.

## Spec
- Add `resend` SDK to `@barkan/api`. New `apps/api/src/providers/resend-domain.ts`:
  - `ensureAgentDomain(config) -> DomainStatus` — idempotently creates the domain `EMAIL_AGENT_DOMAIN` in Resend (`resend.domains.create`), returns required DNS records (SPF, DKIM, MX for receiving) + verification state (`resend.domains.list/get`, then `verify`).
  - `getDomainStatus(config)` — cached 5min.
- Ops route `GET /api/v1/ops/email-domain` (session auth): full record list + per-record verified state — the UI for this lands in settings during task 044; for now curl-able JSON.
- Boot check: when `PROVIDER_MODE_EMAIL=live` and domain unverified → log a loud warning with the exact missing DNS records (do not crash; sends will fail with actionable `provider_error`).
- Webhook endpoint registration (framework from 009): `POST /webhooks/resend` verifying Svix signature with `RESEND_WEBHOOK_SECRET`; this task handles only delivery lifecycle events (`email.sent`, `email.delivered`, `email.bounced`, `email.complained`) by updating `emailMessages.status` via `providerMessageId`; `email.received` is task 018.
- Remove `EMAIL_SANDBOX_REDIRECT_TO` and its redirect logic — live mode requires a verified domain, mock mode fakes locally; the half-real hack goes away.
- `docs/email-setup.md`: step-by-step — choose subdomain, add records at the DNS host, verify in Resend, create webhook (events + URL `PUBLIC_API_URL/webhooks/resend`), paste `whsec` into env.

## Implementation steps
1. Add SDK; implement provider module with injected client for tests.
2. Wire webhook route through the framework; map lifecycle events → status updates + audit on bounce/complaint.
3. Tests: domain ensure idempotency (mock client), status mapping, bounce updates message status + audit row.
4. Write the docs file; update `.env.example` comments.

## Acceptance criteria
- With real creds and DNS access: `curl /api/v1/ops/email-domain` shows all records verified.
- Bounce webhook flips a seeded message to `bounced` and writes `email.blocked` audit.
- No sandbox-redirect code paths remain (`grep -rn EMAIL_SANDBOX_REDIRECT` → nothing outside .env history).

## How to test
```bash
npm --workspace @barkan/api run test -- resend-domain
# Live (requires RESEND_API_KEY + DNS):
curl -s localhost:4001/api/v1/ops/email-domain -H "cookie: $COOKIE" | jq '.records[] | {type, name, status}'
# Tunnel + real webhook:
cloudflared tunnel --url http://localhost:4001   # register printed URL + /webhooks/resend in Resend dashboard
```
