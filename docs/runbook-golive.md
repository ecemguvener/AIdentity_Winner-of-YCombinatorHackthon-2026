# Barkan Go-Live Runbook

Target domain: `aidentity.space` with same-origin API routes under `/api`, `/mcp`, `/webhooks`, and `/docs`. Staging can use `staging.aidentity.space` if that DNS record exists; otherwise override staging URLs to `https://aidentity.space` for the current single-host launch.

Lead times to start early: Stripe account activation can take 1-3 business days, Twilio regulatory bundles and US A2P 10DLC can take several days, Resend domain verification depends on DNS TTL, and ElevenLabs phone import quota may require support approval.

| Step | Owner | Date | Rehearsed | Checklist |
|---|---|---|---|---|
| 1. Domain + DNS |  |  | yes | Point `aidentity.space` to the web/API host. Add `mail.aidentity.space` MX/TXT/CNAME records from `/settings/email-domain` and Resend Dashboard -> Domains. Install `infra/Caddyfile`, set `CADDY_ACME_EMAIL`, then `caddy reload --config infra/Caddyfile`. |
| 2. Stripe live billing |  |  | partial | Stripe Dashboard -> Settings -> Business details: activate live account. Developers -> API keys: set live `STRIPE_SECRET_KEY`. Developers -> Webhooks: add `https://aidentity.space/webhooks/stripe`, subscribe to customer/subscription/checkout events, set `STRIPE_WEBHOOK_SECRET`. Run `npm --workspace @barkan/api run stripe:bootstrap-billing -- --write-env` against `.env.production`. Branding -> Customer Portal: set logo, support email, terms/privacy URLs. |
| 3. Twilio production phone |  |  | partial | Twilio Console -> Billing: upgrade from trial. Pick number country: US default; France and other regulated countries require Address/Bundles before purchase. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_NUMBER_COUNTRY`, and any `TWILIO_ADDRESS_SID`/`TWILIO_BUNDLE_SID`. Messaging -> Regulatory Compliance -> A2P 10DLC: register brand/campaign before production SMS. Messaging Geo Permissions: allow outbound countries. |
| 4. ElevenLabs production voice |  |  | partial | ElevenLabs -> Workspace: create production API key. Conversational AI: export/import or manually replicate the shared agent config from staging. Set `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_WORKSPACE_WEBHOOK_SECRET`. Confirm phone import quota before enabling phone live. |
| 5. Resend production email |  |  | yes | Resend -> Domains: verify `mail.aidentity.space`; confirm `/api/v1/ops/email-domain` green. Webhooks: add `https://aidentity.space/webhooks/resend`, set `RESEND_WEBHOOK_SECRET`. DNS: add DMARC recommendation `v=DMARC1; p=quarantine; rua=mailto:dmarc@aidentity.space` after monitoring alignment. |
| 6. OpenAI, Sentry, alerts |  |  | yes | OpenAI Platform -> API keys: set `OPENAI_API_KEY`. Sentry -> Projects: set API `SENTRY_DSN` and web `VITE_SENTRY_DSN`. Set `ALERT_WEBHOOK_URL` to the production incident channel. |
| 7. Capability live switch |  |  | partial | Start with `PROVIDER_MODE_EMAIL=live`, `PROVIDER_MODE_PHONE=mock`. Run `E2E_MODE=live PUBLIC_API_URL=https://aidentity.space npm run e2e:integration`. Send a real email from a founder-owned agent, verify Resend and audit log. Then switch `PROVIDER_MODE_PHONE=live`, rerun live harness, place one founder-owned call, verify Twilio/ElevenLabs/audit/usage agree. |
| 8. Ops baseline |  |  | yes | Install `pm2-logrotate` using `docs/operations.md`. Set backup cron: `0 3 * * * cd /srv/barkan/current && BACKUP_DIR=/var/backups/barkan ./scripts/backup-mongo.sh`. Add external uptime monitor on `https://aidentity.space/api/health`. Run `pm2 save` and `pm2 startup`. |
| 9. Launch smoke |  |  | partial | Create a real user, subscribe to Pro through Stripe Checkout, create an agent, send one real email, approve it, place one real call, approve it, then verify Stripe customer/subscription, usage ledger, audit log, Resend, Twilio, and ElevenLabs records. Cancel and refund the subscription in Stripe. |
| 10. Legal + support |  |  | no | Have counsel review `docs/legal/terms.md` and `docs/legal/privacy.md`; publish final terms/privacy pages. Confirm `support@aidentity.space` receives mail and appears in Stripe/Resend/Caddy error contacts. |

## Deployment

Prepare env files:

```bash
cp .env.example .env.staging
cp .env.example .env.production
npm run check-env -- --env staging --file .env.staging
npm run check-env -- --env production --file .env.production
```

Deploy staging:

```bash
while true; do curl -sf https://aidentity.space/api/health >/dev/null || echo FAIL; sleep 0.3; done &
npm run deploy:prod -- --target staging
```

Deploy production:

```bash
npm run deploy:prod -- --target production
```

Rollback:

```bash
npm run deploy:prod -- --target production --rollback
```

The deploy script enforces env parity, `npm run build`, migrations, `npm run e2e`, PM2 zero-downtime reload, health smoke, and last-3-release pruning. For rehearsal only, `--skip-e2e` and `--skip-migrations` exist; do not use them for launch.

## Zero-Downtime Drill

1. Start the curl loop from the staging deploy section.
2. Run `npm run deploy:prod -- --target staging`.
3. Confirm no `FAIL` lines during PM2 reload.
4. Run rollback and confirm the curl loop stays green:

```bash
npm run deploy:prod -- --target staging --rollback
```

Record the release IDs and attach the terminal log to launch notes.
