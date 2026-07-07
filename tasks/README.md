# Barkan — Production Task Plan

This folder is the execution plan that takes Barkan from a hackathon demo (mostly mocked) to a fully operational, end-to-end business: **real-world identities for AI agents** — a real phone number and a real email address per agent, governed by owner-defined policies and human approvals, integrated into OpenClaw and Hermes. The **payment card capability is deferred** (regulatory/issuing-approval lead times): it is marketed as **"Coming soon"** on the website and excluded from the build (tasks 032–040 reserved).

Every file `NNN-*.md` is one self-contained task for a coding agent. Execute them **in numeric order** unless the `Depends on` section says otherwise. Tasks within a phase sometimes allow parallel execution — the dependency section is authoritative.

## Model line

The first line of every task file is the model that should execute it:

- `model: fable 5` — reserved for the hardest tasks (money movement, real-time webhooks, migrations, protocol servers). Quota-limited, spend it here.
- `model: gpt 5.5` — everything else (UI panels, config, docs, tests, mechanical refactors).

## Target architecture (the finished business)

```
                        ┌──────────────────────────────┐
        OpenClaw skill  │          Barkan API           │   Stripe (Billing —
        Hermes skill ──▶│   Fastify + MongoDB (apps/api)│◀─ SaaS subscriptions)
        MCP clients ───▶│                               │◀─ Twilio (numbers, SMS,
        REST + SDK      │  /api/v1/*   /mcp   /webhooks │   voice trunk)
                        └──────────────┬───────────────┘◀─ ElevenLabs (voice AI)
                                       │                 ◀─ Resend (email in/out)
                        ┌──────────────▼───────────────┐
                        │   Dashboard (apps/web, React) │
                        │ agents, approvals, inbox,     │
                        │ calls, billing                │
                        └──────────────────────────────┘
```

**Core objects** (all persisted in MongoDB — nothing in memory):

- **Agent** — an identity created by a user. Owns capabilities: `email`, `phone` (card: coming soon, not built in this plan).
- **Identity token** — hashed bearer credential an agent runtime uses against the public API/MCP.
- **Email account** — real address `name-xxxx@<EMAIL_AGENT_DOMAIN>`; send via Resend, receive via Resend `email.received` webhooks (MX on the agent subdomain).
- **Phone number** — real Twilio number purchased per agent; voice AI via ElevenLabs (number imported through the ElevenLabs phone-numbers API, inbound personalization webhook, outbound-call API); SMS via Twilio messaging webhooks.
- **Approval** — human-in-the-loop gate for sensitive actions (send email, place call, send SMS), delivered over SSE + email.
- **Audit log** — append-only record of every action an agent takes.
- **Usage + Billing** — Stripe Billing subscriptions with metered usage (call minutes, SMS, emails, active numbers).

**Key design decisions** (do not re-litigate in individual tasks):

1. **Everything works in provider test/sandbox mode first.** Stripe test mode, Twilio test credentials/magic numbers, Resend sandbox. Every capability keeps an explicit `mock` provider for CI, selected by env var, never silently.
2. **The card capability is deferred, honestly.** No mock cards, no fake purchases anywhere. The website and app present cards as "Coming soon" (tasks 012/055); the fake payment demo code is deleted in task 031. Task numbers 032–040 stay reserved for the future card phase.
3. **One ElevenLabs conversational agent, many phone numbers.** Per-call behavior (agent name, persona, owner context, task) is injected via the inbound personalization webhook and outbound `dynamic_variables` — we do not create one ElevenLabs agent per Barkan agent.
4. **MCP is the primary integration surface** (OpenClaw and Hermes both speak MCP), with AgentSkills-spec skills as the zero-config on-ramp and a REST API + typed SDK underneath.
5. **Legacy `sites`/`site-setups` naming dies** in Phase 0/1 via a real migration to `agents`.

## Phases

| Phase | Tasks | Outcome |
|---|---|---|
| 0 — Foundation | 001–009 | Dead code removed, `@barkan/*` naming, config/env overhaul, Mongo persistence for identities + audit, webhook framework, rate limits |
| 1 — Agent lifecycle | 010–014 | Agents CRUD API + UI, approvals engine with SSE, approvals inbox |
| 2 — Email | 015–021 | Real send/receive per agent, threads, policies, inbox UI |
| 3 — Phone | 022–030 | Real numbers, inbound/outbound AI calls, transcripts, SMS, UI |
| 4 — Stripe foundation | 031 (032–040 reserved) | Stripe client + billing webhook endpoint, fake payment stack deleted; card capability deferred |
| 5 — SaaS billing | 041–044 | Plans, metered usage, quotas, billing UI |
| 6 — Integrations | 045–051 | OpenAPI, MCP server + stdio package, OpenClaw skill, Hermes skill, SDK, integration harness |
| 7 — Production | 052–060 | Security pass, observability, GDPR, landing/docs, onboarding, E2E suite, go-live runbook |

## Environment variables (final target set)

Defined incrementally by tasks; the full set lives in `.env.example` and is validated by `apps/api/src/config.ts` (zod). Never commit real secrets. Highlights:

```
MONGODB_URI, SESSION_SECRET, PUBLIC_APP_URL, PUBLIC_API_URL
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET   (SaaS billing only — no Issuing)
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER_COUNTRY=US, TWILIO_STATUS_CALLBACK_BASE
ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_WORKSPACE_WEBHOOK_SECRET, ELEVENLABS_VOICE_ID
RESEND_API_KEY, EMAIL_AGENT_DOMAIN, RESEND_WEBHOOK_SECRET, EMAIL_PLATFORM_FROM
PROVIDER_MODE_EMAIL|PHONE = live | mock   (explicit, no silent fallback)
OPENAI_API_KEY (drafting/summaries), SENTRY_DSN
```

## Conventions every task must follow

- **Read `AGENTS.md` first.** Product language: agent identity, OpenClaw link, phone, email, payments, calendar.
- TypeScript strict; explicit descriptive names; Fastify + zod on the API; React + Tailwind (existing shadcn-style components) on the web.
- All new API surface under `/api/v1/` (task 010 introduces it; legacy routes stay as aliases until task 060 removes them).
- Money is **integer minor units** (`amountCents`) + ISO `currency`. Never floats.
- External calls: timeouts, retries with backoff where safe, idempotency keys on anything that moves money or provisions resources.
- Webhooks: verify signatures on raw bytes, store event in `webhookEvents` with unique provider event id, process idempotently (task 009 framework).
- Every agent-visible action writes an audit entry (task 007 service).
- Tests: `vitest` colocated `*.test.ts`; integration tests use `mongodb-memory-server`; provider clients are injected so tests never hit live APIs. Run with `npm --workspace @barkan/api run test` (and `@barkan/web`).
- Local webhook testing: `stripe listen --forward-to localhost:4001/...`, and a tunnel (`ngrok http 4001` or `cloudflared tunnel --url http://localhost:4001`) for Twilio/Resend/ElevenLabs.
- Dev services: `pm2 restart dev-barkan-api dev-barkan-web --update-env` (API :4001, web :4888).
- When a task materially changes architecture, routes, or env — update `AGENTS.md`, `README.md`, and `.env.example` in the same task.

## Definition of done (whole plan)

A brand-new user can: sign up → subscribe to a plan → create an agent → get a real email address and real phone number → link the agent to OpenClaw or Hermes in under 5 minutes → the agent sends/receives email, makes/receives calls, and sends/receives SMS — every sensitive step gated by policy/approvals, every action audited, all usage metered and billed, with monitoring, backups, and a documented go-live path to live mode. The card capability appears as "Coming soon" on the site and is not part of this plan's scope.
