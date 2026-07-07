# Barkan Operations

## Observability

Set `SENTRY_DSN` for API error tracking and `VITE_SENTRY_DSN` for the dashboard. Leave either unset to disable that side. Release tags come from `SENTRY_RELEASE` or `GIT_SHA` on the API and `VITE_SENTRY_RELEASE` on the web build. Sentry events are scrubbed before send: auth/cookie headers, emails, passwords, bodies, and transcripts are redacted.

The API exposes shallow health at `GET /api/health`:

```json
{ "ok": true, "mongo": "ok", "uptime": 123.4 }
```

Internal-only checks:

- `GET /internal/metrics` returns Prometheus text for HTTP latency, provider latency, webhook totals, pending approvals, and SSE connections.
- `GET /internal/health/deep` returns provider readiness for Stripe, Twilio, Resend, ElevenLabs, and OpenAI. The result is cached for 60 seconds.

Both internal routes are intended for localhost/VPC callers only.

## Alerts

The API evaluates alerts every 60 seconds outside tests. It emits fatal Sentry messages and optionally posts JSON to `ALERT_WEBHOOK_URL` for:

- failed webhook deliveries in the last 5 minutes
- provider error rate above 20% over the last 5 minutes with at least 5 samples
- pending approvals older than 55 minutes

Staging drill:

1. Set `SENTRY_DSN` and restart the API.
2. Send a mock webhook whose handler fails or insert a failed `webhookEvents` row.
3. Confirm Sentry receives `failed webhook deliveries in the last 5 minutes` within 2 minutes.
4. Run the integration harness and confirm `/internal/metrics` contains all metric families.

## PM2 Logs

Install log rotation once per host:

```powershell
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 save
```

For a deploy smoke check:

```powershell
pm2 restart dev-barkan-api dev-barkan-web --update-env
curl http://127.0.0.1:4001/api/health
curl http://127.0.0.1:4001/internal/metrics
```
