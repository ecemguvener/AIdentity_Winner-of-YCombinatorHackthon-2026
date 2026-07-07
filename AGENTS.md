# Barkan - Agent Instructions

<!-- This is the single source of truth for repo-level agent guidance. -->

## Overview

This repo contains the web-based Barkan product for issuing real-world identities to AI agents.

- **Web dashboard**: React + Vite + TypeScript in `apps/web`
- **Node API**: Fastify + MongoDB backend in `apps/api`
- **MCP stdio bridge**: publishable `@barkan/mcp` package in `packages/mcp`

The current product lets a user sign up, create an agent identity, link it to an OpenClaw instance, and manage real-world tools such as phone and email. Payment cards are coming soon; Stripe is used for SaaS billing only. The public web surface includes the logged-out landing page, pricing page, and markdown docs site. The old embeddable website assistant, browser widget, Action Mode, route documentation generator, and codebase-scanning CLI have been removed.

## Architecture

### Web app

- **Public pages**: logged-out landing page, pricing, `/docs-site` markdown docs, SEO metadata, sitemap/robots output, and card waitlist CTA
- **Dashboard**: auth, identity list/detail, OpenClaw setup, dashboard chat, settings, phone/email panels, card coming-soon surfaces
- **UI**: Tailwind with shadcn-style local components
- **Auth**: classic email/password, bcrypt password hashes, HTTP-only cookie sessions
- **Identity setup**: user creates a named identity, chooses an OpenClaw endpoint or managed deployment, copies a link prompt/token, then completes setup
- **Current data model**: agents are first-class (`agents`/`identityTokens`/`auditLogs` collections); the legacy `/api/sites*` routes are thin deprecated adapters over `agents` until the web UI migrates to `/api/v1/agents` (task 012)

### Node API

The Node API exposes:

- `POST /api/auth/check-email`
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `PATCH /api/auth/me`
- `PATCH /api/auth/me/notifications`
- `POST /api/auth/me/password`
- `POST /api/v1/account/export`
- `GET /api/v1/account/export/:exportId/download` (signed one-time URL)
- `DELETE /api/v1/account` (password + typed confirmation; queued checkpoint deletion job)
- `POST /api/v1/waitlist` (public card waitlist; email + feature)
- `POST /api/v1/agents`
- `GET /api/v1/agents`
- `GET /api/v1/agents/:agentId`
- `PATCH /api/v1/agents/:agentId`
- `POST /api/v1/agents/:agentId/freeze-all` (panic freeze: pauses agent, revokes active tokens, pauses email)
- `DELETE /api/v1/agents/:agentId` (soft delete: revokes agent + tokens, runs capability teardown)
- `POST /api/v1/agents/:agentId/tokens` (max 5 active)
- `DELETE /api/v1/agents/:agentId/tokens/:tokenId`
- `POST /api/v1/agents/:agentId/capabilities/:capability/enable|disable` (email|phone; card returns 400 "coming soon")
- `GET/PUT /api/v1/agents/:agentId/policies/email`
- `GET/PUT /api/v1/agents/:agentId/policies/phone`
- `GET /api/v1/agents/:agentId/email/threads`
- `GET /api/v1/agents/:agentId/email/threads/:threadId`
- `POST /api/v1/agents/:agentId/email/threads/:threadId/reply`
- `GET /api/v1/agents/:agentId/email/threads/:threadId/attachments/:attachmentId`
- `POST /api/v1/agents/:agentId/email/send`
- `POST /api/v1/agents/:agentId/email/pause|resume`
- `GET /api/v1/agents/:agentId/phone`
- `GET /api/v1/agents/:agentId/phone/calls`
- `GET /api/v1/agents/:agentId/phone/calls/:callId`
- `POST /api/v1/agents/:agentId/phone/call`
- `GET /api/v1/agents/:agentId/phone/sms`
- `POST /api/v1/agents/:agentId/phone/sms`
- Deprecated legacy adapters over `agents` (respond with `deprecation: true` header): `GET/POST /api/sites`, `POST /api/site-setups`, `GET /api/site-setups/:projectId`, `POST /api/site-setups/:projectId/complete`, `GET/PATCH/DELETE /api/sites/:siteId`, `POST /api/sites/:siteId/api-keys`, `DELETE /api/sites/:siteId/api-keys/:apiKeyId`
- `POST /api/dashboard/chat`
- `POST /api/identity/init`
- `POST /api/identity/revoke`
- `POST /api/identity/tokens/rotate`
- `GET /api/identity/:agentId/audit-log`
- `POST /api/tools/phone/call`
- `POST /api/v1/agent/phone/call`
- `GET /api/v1/agent/phone/number`
- `GET /api/v1/agent/phone/calls`
- `GET /api/v1/agent/phone/calls/:callId`
- `POST /api/v1/agent/phone/sms`
- `GET /api/v1/agent/phone/sms`
- `GET /api/v1/agent/phone/sms/latest-code`
- `POST /api/tools/calendar/book`
- Email tool routes under `/api/tools/email/*` and `/api/sites/:siteId/email/*`
- Agent email routes: `GET /api/v1/agent/email/address`, `POST /api/v1/agent/email/send`, `GET /api/v1/agent/email/threads`, `GET /api/v1/agent/email/threads/:threadId`, `POST /api/v1/agent/email/threads/:threadId/reply`, `GET /api/v1/agent/email/threads/:threadId/attachments/:attachmentId`
- `GET /api/v1/webhook-events` (session-authed ops listing of provider webhook deliveries)
- `GET /api/v1/ops/email-domain` (session-authed Resend DNS/domain status)
- `GET /api/v1/ops/status` (session-authed provider mode + billing/phone/email readiness)
- `GET /api/health` (shallow API + Mongo health)
- `GET /internal/metrics` (Prometheus text; localhost/internal only)
- `GET /internal/health/deep` (provider readiness; localhost/internal only, cached 60s)
- `GET /api/v1/openapi.json`
- `POST/GET /mcp` (agent-token MCP Streamable HTTP server with capability-scoped tools/resources)
- `POST /api/v1/pairing/start`
- `POST /api/v1/pairing/poll`
- `POST /api/v1/pairing/:code/confirm`
- `GET /api/v1/billing`
- `GET /api/v1/billing/plans`
- `GET /api/v1/billing/usage`
- `POST /api/v1/billing/checkout`
- `POST /api/v1/billing/portal`
- Plan entitlement failures return 402 `plan_limit` with `upgradeHint`
- `POST /webhooks/stripe` (registered only when `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` are configured; SaaS billing only)
- `POST /webhooks/resend` (Resend Svix-signed email lifecycle + inbound receive webhook)
- `POST /webhooks/elevenlabs/personalization` (ElevenLabs signed inbound-call personalization; returns conversation initiation data)
- `POST /webhooks/elevenlabs/post-call` (ElevenLabs signed post-call transcript/status/cost finalization)
- `POST /webhooks/twilio/sms` (Twilio inbound SMS webhook; TwiML empty response)
- `POST /webhooks/twilio/status` (Twilio SMS delivery status webhook)
- `GET /docs` (hosted API reference)
- Dev-only webhook smoke routes `POST /webhooks/ping/:provider` (mock mode only)

## Key Files

| File | Purpose |
|------|---------|
| `apps/web/src/App.tsx` | Dashboard, auth, identity onboarding, and settings UI |
| `apps/web/src/api.ts` | Browser API client |
| `apps/web/src/pages/PublicPages.tsx` | Logged-out landing page, pricing page, and `/docs-site` markdown renderer |
| `apps/web/src/docs/manifest.ts` | Docs-site markdown import manifest and slug lookup |
| `apps/web/src/api/billing.ts` | Browser API client for billing and ops status |
| `apps/web/src/api/phone.ts` | Browser API client for owner phone/SMS routes |
| `apps/web/src/api/pairing.ts` | Browser API client for runtime pairing confirmation |
| `apps/web/src/components/PhonePanel.tsx` | Real phone/SMS tab: number, calls, transcripts, SMS threads, and policy UI |
| `apps/web/src/components/EmailPanel.tsx` | Real email inbox, threads, compose, and policy UI |
| `apps/web/src/pages/PairingPage.tsx` | Dashboard page for confirming `@barkan/mcp --pair` codes |
| `apps/api/src/app.ts` | Fastify app wiring |
| `apps/api/src/auth.ts` | Auth routes and session helpers |
| `apps/api/src/billing.ts` | Stripe Billing account, checkout, portal, plan limits, and subscription webhook sync |
| `apps/api/src/usage.ts` | Usage ledger, summaries, Stripe meter reporting, and active-number sampling |
| `apps/api/src/entitlements.ts` | Plan entitlement checks for agent creation, capabilities, usage, and phone numbers |
| `apps/api/src/metrics.ts` | In-process Prometheus metrics and provider-call instrumentation |
| `apps/api/src/alerting.ts` | Webhook/provider/approval alert evaluator and optional alert webhook |
| `apps/api/src/health.ts` | Shallow and deep health endpoints |
| `apps/api/src/sentry.ts` | API Sentry initialization and event scrubber |
| `apps/api/src/account.ts` | Account export ZIPs, signed download URLs, and deletion checkpoint job |
| `apps/api/src/waitlist.ts` | Public card waitlist endpoint with dedupe and IP rate limiting |
| `apps/api/src/retention.ts` | Daily data retention sweep for transcripts, email bodies, webhooks, usage, approvals, pairing, audit, and tombstones |
| `apps/api/src/backup-retention.ts` | Pure backup archive pruning helper used by tests/runbooks |
| `apps/web/src/sentry.ts` | Web Sentry initialization and event scrubber |
| `apps/api/src/openapi.ts` | OpenAPI document and hosted API reference routes |
| `apps/api/src/mcp/server.ts` | MCP Streamable HTTP server, agent-token auth, capability-scoped tools, and resources |
| `apps/api/e2e/` | Mock-mode integration harness for owner, SDK/MCP, webhook, audit, and billing golden paths |
| `apps/api/src/pairing.ts` | Device-code-style runtime pairing routes, one-time token reveal, and expiry sweeper |
| `apps/api/src/agents-routes.ts` | Owner-facing /api/v1/agents REST API |
| `docs/security.md` | Threat model, hardening checklist, and provider key rotation/freeze guidance |
| `docs/operations.md` | Observability, alerts, health checks, metrics, and PM2 log rotation runbook |
| `docs/privacy-operations.md` | GDPR data inventory, export/delete behavior, retention windows, and subprocessors |
| `scripts/backup-mongo.sh` | Mongo dump, marker write, local prune, optional rclone upload |
| `scripts/restore-mongo.sh` | Safe restore to a separate target database |
| `apps/api/src/provisioning.ts` | Capability provisioner registry (stubs until email/phone tasks) |
| `apps/api/src/policies.ts` | Agent policy defaults, email/phone policy normalization, and policy routes |
| `apps/api/src/sites.ts` | Deprecated legacy site routes as adapters over agents |
| `apps/api/src/dashboard-chat.ts` | Simulated OpenClaw dashboard chat |
| `apps/api/src/identity.ts` | Bearer-token agent identity and tool endpoints |
| `apps/api/src/phone.ts` | Owner-facing phone overview, call, and SMS routes |
| `apps/api/src/phone-service.ts` | Per-agent outbound phone call service, policy/approval gating, call persistence, mock lifecycle, and call serializers |
| `apps/api/src/phone-policy.ts` | Phone/SMS country allowlist, quiet-hours, and local-day policy helpers |
| `apps/api/src/phone-post-call.ts` | ElevenLabs post-call webhook finalization, transcript storage, call cost, and usage metering |
| `apps/api/src/phone-provisioning.ts` | Twilio number purchase + ElevenLabs voice-agent phone capability provisioner |
| `apps/api/src/phone-personalization.ts` | ElevenLabs inbound-call personalization webhook and call row creation |
| `apps/api/src/phone-numbers.ts` | Twilio phone number persistence and lifecycle helpers |
| `apps/api/src/lib/phone.ts` | Shared E.164 phone normalization helper |
| `apps/api/src/lib/phone-country.ts` | Static E.164 prefix to ISO country mapping for phone policies |
| `apps/api/src/providers/twilio-numbers.ts` | Twilio/mock number search, purchase, release, and audit listing |
| `apps/api/src/providers/twilio-sms.ts` | Twilio/mock SMS send provider |
| `apps/api/src/providers/elevenlabs-phone.ts` | ElevenLabs Conversational AI phone number import/assign/remove provider |
| `apps/api/src/sms-service.ts` | Agent SMS send/receive, policy/approval gating, delivery status updates, latest-code extraction, and serializers |
| `apps/api/src/email.ts` | Email routes, drafting helpers, and email activity serializers |
| `apps/api/src/email-service.ts` | Persistent outbound/inbound email threads, idempotency, and replies |
| `apps/api/src/providers/email-provider.ts` | Resend/mock outbound email provider and Resend inbound client |
| `docs/api/email.md` | Frozen agent-facing email API contract |
| `docs/api/phone.md` | Frozen agent-facing phone/SMS API contract |
| `docs/integrations/mcp.md` | MCP Streamable HTTP integration guide |
| `docs/integrations/openclaw.md` | OpenClaw skill publish, install, env, and verification guide |
| `docs/integrations/hermes.md` | Hermes skill install, MCP config, messaging gateway, and verification guide |
| `docs/phone-setup.md` | Live phone provisioning and ElevenLabs setup guide |
| `packages/mcp/src/cli.ts` | `@barkan/mcp` stdio bridge and pairing CLI |
| `skills/barkan-identity/SKILL.md` | Canonical runtime-agnostic Barkan identity AgentSkill source |
| `openclaw-skills/barkan-identity/SKILL.md` | Built OpenClaw AgentSkill variant for Barkan identity usage |
| `hermes-skills/barkan-identity/SKILL.md` | Built Hermes AgentSkill variant for Barkan identity usage |
| `scripts/build-skills.mjs` | Builds OpenClaw and Hermes skill variants from canonical source |
| `scripts/validate-skills.mjs` | OpenClaw AgentSkill frontmatter and legacy-string validator |
| `apps/api/src/providers/stripe-client.ts` | Stripe Billing SDK singleton |
| `apps/api/src/stripe-webhooks.ts` | Stripe Billing webhook dispatcher |
| `apps/api/src/webhooks/framework.ts` | Webhook pipeline: raw-body capture, signature verification, exactly-once processing |
| `apps/api/src/webhooks/verify.ts` | Stripe/Svix/Twilio/ElevenLabs signature verifiers |
| `docs/payments-setup.md` | Stripe CLI billing webhook setup guide |

## Build & Run

Local PM2 dev services:

```powershell
pm2 restart dev-barkan-api dev-barkan-web --update-env
pm2 save
```

Barkan runs with hot reload on:

- API: `http://100.81.152.74:4001`
- Web: `http://100.81.152.74:4888`

```powershell
npm install
npm run build
npm test
npm run e2e:integration
```

Development:

```powershell
copy .env.example .env
npm run dev
```

Node API only:

```powershell
npm --workspace @barkan/api run dev
```

Web dashboard only:

```powershell
npm --workspace @barkan/web run dev
```

Production deploy:

```powershell
npm run pm2:start-prod-api
npm run deploy:barkan-web
```

## Code Style & Conventions

### Naming

- Prefer explicit, descriptive names over short names
- Keep argument names aligned with the variables passed into them
- Use current product language in UI copy: agent identity, OpenClaw link, phone, email, payments, calendar
- Do not reintroduce old embedded widget, Action Mode, route documentation, or codebase-scanning CLI terminology

### Code clarity

- Clear is better than clever
- Add comments only when they explain non-obvious intent or tradeoffs
- Avoid unnecessary indirection

## Do Not

- Do not add features beyond the request
- Do not reintroduce desktop companion code or routes
- Do not reintroduce the old embeddable widget, browser extension assistant, Action Mode, route documentation, or CLI scanner
- Do not revert user changes outside the current task
- Do not use destructive git commands like `git reset --hard`

## Self-Update Instructions

Update this file when architecture, routes, key files, or build instructions materially change.
