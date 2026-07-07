model: gpt 5.5

# Task 059 — Production deployment + go-live runbook (test mode → live money)

## Depends on
052, 053, 054, 058

## Context
Everything works in provider test/sandbox modes behind PM2 on the dev box. Going live means: hardened hosting with TLS, live provider accounts with real approvals (Twilio number compliance, Resend domain), and a rehearsed cutover. This task delivers the automation + the runbook; executing live applications is founder work the runbook orchestrates.

## Objective
Production infrastructure-as-config in the repo + `docs/runbook-golive.md` precise enough that going live is checklist execution, not archaeology.

## Spec
- **Hosting hardening** (current: PM2 on a host at `aidentity.tech` — decide final domain, e.g. `barkan.dev`, and parameterize):
  - Caddy (or nginx) reverse proxy config in `infra/`: TLS (auto-cert), `api.<domain>` → API port, `<domain>` → web dist, `/webhooks/*` + `/mcp` routed to API with no buffering (SSE + streamable HTTP), internal routes (`/internal/*`) denied from public.
  - `ecosystem.config.cjs` production apps finalized: `prod-barkan-api` (cluster mode ×2, `wait_ready`), add graceful shutdown to the API (SIGTERM → stop accepting, drain 10s, close Mongo) — implement + test.
  - Deploy scripts: `scripts/deploy-prod.sh` = build → run migrations (`npm run migrate`) → run `npm run e2e` gate against staging → `pm2 reload` (zero-downtime) → smoke curl suite → rollback instructions (`pm2 reload` previous build dir — keep last 3 builds in `releases/` symlink pattern; implement).
  - Staging: second env (`staging-barkan-api`, `-prod`-suffix-free staging db, staging subdomains) — config only, same box acceptable.
- **Runbook `docs/runbook-golive.md`** — ordered checklist with owner/date columns:
  1. Domain + DNS (web, api, agents email subdomain records from 015 output).
  2. Stripe: activate account (business details), live keys → env, live webhook via dashboard with prod URL, bootstrap billing catalog on live (`stripe:bootstrap-billing`), Customer Portal branding.
  3. Twilio: upgrade from trial, buy first prod number pool country decision (US default; FR requires bundle — document application), set `TWILIO_*` live, geo-permissions for outbound countries, A2P/sender compliance notes for SMS (US A2P 10DLC registration steps).
  4. ElevenLabs: production workspace, shared agent config replicated (export/import per docs), workspace webhook secrets → env, phone import quota check.
  5. Resend: production domain verify (015 ops route green), webhook to prod URL, DMARC record recommendation.
  6. OpenAI, Sentry DSNs, `ALERT_WEBHOOK_URL`.
  7. Switch `PROVIDER_MODE_* = live` one capability at a time (email → phone), running the 051 live-mode harness scenario for each before enabling the next.
  8. Backups cron live (054), pm2-logrotate, uptime monitor on `/api/health` (external service), `pm2 save` + startup script.
  9. Launch smoke: real user journey with a real paid-plan subscription and a real email + call by a founder-owned agent; verify Stripe dashboard + audit agree; cancel/refund it.
  10. Legal: terms/privacy reviewed (055 placeholders), support email live.
- Env parity checker: `scripts/check-env.mjs --env production` — diffs required keys (from config schema) against the deployed `.env`, fails on gaps; wire into deploy script.

## Implementation steps
1. Infra configs + graceful shutdown + release/rollback structure + deploy script (test shutdown drain with a long request in dev).
2. Staging env bring-up; run the full E2E gate against it.
3. Write the runbook with exact dashboard paths/URLs per provider; dry-run every step you can in test mode, marking each "rehearsed ✓".
4. Env checker + tests.

## Acceptance criteria
- `bash scripts/deploy-prod.sh` on staging: zero-downtime reload proven (continuous `curl` loop shows no failures during deploy), migration + e2e gates enforced, rollback drill executed once.
- Env checker catches a deliberately removed key.
- Runbook reviewed end-to-end with every rehearsable step marked; provider application lead times documented at top.

## How to test
```bash
bash scripts/check-env.mjs --env staging
while true; do curl -sf https://staging-api.<domain>/api/health >/dev/null || echo FAIL; sleep 0.3; done &
bash scripts/deploy-prod.sh --target staging   # watch: zero FAIL lines
E2E_MODE=live PUBLIC_API_URL=https://staging-api.<domain> npm run e2e:integration
```
