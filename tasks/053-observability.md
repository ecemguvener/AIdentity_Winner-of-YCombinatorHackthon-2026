model: gpt 5.5

# Task 053 — Observability: errors, metrics, alerts, provider health

## Depends on
008, 009; after capability phases so instrumentation covers everything.

## Context
Real communications + billing = you must know when something breaks before customers do. Current state: pino logs to PM2, nothing else.

## Objective
Sentry error tracking, core metrics, webhook/provider health alerting, and a status endpoint suitable for uptime monitoring.

## Spec
- **Sentry** (`@sentry/node` in API, `@sentry/react` in web, DSNs via env, disabled when unset): request context (route, requestId, userId/agentId when authed — no PII in `extra`), release tagging from git sha (build scripts pass `GIT_SHA`), traces sampled 10%.
- **Metrics** `apps/api/src/metrics.ts` (in-process counters/histograms, exposed at `GET /internal/metrics` in Prometheus text format, bound to localhost/internal only — PM2 host):
  - `http_request_duration_ms` (route, method, status) histogram
  - `provider_call_duration_ms` (provider, operation, outcome) — wrap Stripe/Twilio/Resend/ElevenLabs/OpenAI client calls via a shared `instrumentProviderCall` helper
  - `webhook_events_total` (provider, status)
  - `approvals_pending` gauge, `sse_connections` gauge
- **Alerts** (simple + effective for a small team): `apps/api/src/alerting.ts` — rule loop every 60s → Sentry `captureMessage` (fatal level) + optional `ALERT_WEBHOOK_URL` (Slack/Discord) on:
  - any `webhookEvents.status="failed"` in last 5min
  - provider error rate > 20% over 5min for any provider
  - `approvals_pending` older than 55min (about to expire) — owner-facing nudge email as well
- **Health**: extend `GET /api/health` → `{ ok, mongo: ping, uptime }` (fast, unauthenticated, no provider calls); `GET /internal/health/deep` → provider reachability checks (parallel, 3s budget, cached 60s).
- PM2 log hygiene: JSON logs in production (`pino` default), `pm2 install pm2-logrotate` documented with size/retention settings in the runbook.

## Implementation steps
1. Sentry wiring (API + web) with scrubbing (strip `authorization`, cookie headers, email bodies, transcripts from breadcrumbs/events) + test that scrubber redacts.
2. Metrics module + provider instrumentation wrapper + endpoint + tests (histogram buckets, label cardinality guard: routes normalized to patterns not raw URLs).
3. Alert rules + fake-clock tests per rule.
4. Deep health + docs (`docs/operations.md` — where to look when X breaks; wire dashboards later if Grafana available, out of scope).

## Acceptance criteria
- Thrown test error appears in Sentry (staging drill) with requestId and release tag, without PII.
- `curl /internal/metrics` shows all metric families with data after the integration harness (051) run.
- Simulated webhook failure (force a handler throw in dev) produces an alert within 2min.

## How to test
```bash
npm --workspace @barkan/api run test -- metrics alerting
curl -s localhost:4001/internal/metrics | grep provider_call
curl -s localhost:4001/api/health | jq .
curl -s localhost:4001/internal/health/deep | jq .
```
