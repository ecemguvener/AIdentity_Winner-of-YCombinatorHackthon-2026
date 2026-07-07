# Barkan - Agent Instructions

<!-- This is the single source of truth for repo-level agent guidance. -->

## Overview

This repo contains the web-based Barkan product for issuing real-world identities to AI agents.

- **Web dashboard**: React + Vite + TypeScript in `apps/web`
- **Node API**: Fastify + MongoDB backend in `apps/api`

The current product lets a user sign up, create an agent identity, link it to an OpenClaw instance, and manage real-world tools such as phone, email, payments, and calendar. The old embeddable website assistant, browser widget, Action Mode, route documentation generator, and codebase-scanning CLI have been removed.

## Architecture

### Web app

- **Dashboard**: auth, identity list/detail, OpenClaw setup, dashboard chat, settings, phone/email/payment panels
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
- `POST /api/v1/agents`
- `GET /api/v1/agents`
- `GET /api/v1/agents/:agentId`
- `PATCH /api/v1/agents/:agentId`
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
- Payment tool routes under `/api/tools/payments/*`
- Email tool routes under `/api/tools/email/*` and `/api/sites/:siteId/email/*`
- Agent email routes: `GET /api/v1/agent/email/address`, `POST /api/v1/agent/email/send`, `GET /api/v1/agent/email/threads`, `GET /api/v1/agent/email/threads/:threadId`, `POST /api/v1/agent/email/threads/:threadId/reply`, `GET /api/v1/agent/email/threads/:threadId/attachments/:attachmentId`
- `GET /api/v1/webhook-events` (session-authed ops listing of provider webhook deliveries)
- `GET /api/v1/ops/email-domain` (session-authed Resend DNS/domain status)
- `POST /webhooks/resend` (Resend Svix-signed email lifecycle + inbound receive webhook)
- `POST /webhooks/elevenlabs/personalization` (ElevenLabs signed inbound-call personalization; returns conversation initiation data)
- `POST /webhooks/elevenlabs/post-call` (ElevenLabs signed post-call transcript/status/cost finalization)
- `POST /webhooks/twilio/sms` (Twilio inbound SMS webhook; TwiML empty response)
- `POST /webhooks/twilio/status` (Twilio SMS delivery status webhook)
- Dev-only webhook smoke routes `POST /webhooks/ping/:provider` (mock mode only)

## Key Files

| File | Purpose |
|------|---------|
| `apps/web/src/App.tsx` | Dashboard, auth, identity onboarding, and settings UI |
| `apps/web/src/api.ts` | Browser API client |
| `apps/web/src/api/phone.ts` | Browser API client for owner phone/SMS routes |
| `apps/web/src/components/PhonePanel.tsx` | Real phone/SMS tab: number, calls, transcripts, SMS threads, and policy UI |
| `apps/web/src/components/EmailPanel.tsx` | Real email inbox, threads, compose, and policy UI |
| `apps/web/src/components/PaymentsPanel.tsx` | Payment capability UI |
| `apps/api/src/app.ts` | Fastify app wiring |
| `apps/api/src/auth.ts` | Auth routes and session helpers |
| `apps/api/src/agents-routes.ts` | Owner-facing /api/v1/agents REST API |
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
| `docs/phone-setup.md` | Live phone provisioning and ElevenLabs setup guide |
| `apps/api/src/payments.ts` | Payment capability and policy engine |
| `apps/api/src/webhooks/framework.ts` | Webhook pipeline: raw-body capture, signature verification, exactly-once processing |
| `apps/api/src/webhooks/verify.ts` | Stripe/Svix/Twilio/ElevenLabs signature verifiers |

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
