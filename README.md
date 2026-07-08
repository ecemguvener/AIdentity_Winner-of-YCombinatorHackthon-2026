# Barkan

Barkan is a web product for issuing real-world identities to AI agents. Each agent identity can be linked to an OpenClaw instance and provisioned with a phone number, email address, and governed real-world tools. Payment cards are coming soon; Stripe is used for SaaS billing.

The dashboard supports the current agent identity flow:

- Create a new agent identity.
- Choose an existing OpenClaw instance or a managed OpenClaw deployment.
- Copy a prompt into OpenClaw so it can install the Barkan identity skill and confirm linking through a tokenized endpoint.
- Manage identity details, OpenClaw link tokens, dashboard chat, phone, email, billing, and card waitlist surfaces.
- Use the first-run checklist to connect a runtime, send the first governed email, approve it, and inspect activation progress.

## Runtime

- Web dashboard: React + Vite in `apps/web`
- Node API: Fastify + MongoDB in `apps/api`

## Prerequisites

- Node.js 18+
- MongoDB
- OpenAI API key for dashboard chat
- ElevenLabs API keys for real outbound calls; without them calls run in mock mode
- Resend API key for real email sending; without it email runs in mock mode

## Web Setup

Install dependencies:

```powershell
npm install
```

Create `.env` from `.env.example` and set:

```text
PUBLIC_APP_URL=http://localhost:4888
PUBLIC_API_URL=http://localhost:4001
MONGODB_URI=mongodb://127.0.0.1:27017/barkan
SESSION_SECRET=replace-with-a-long-random-secret
ELEVENLABS_API_KEY=
ELEVENLABS_AGENT_ID=
ELEVENLABS_AGENT_PHONE_NUMBER_ID=
ELEVENLABS_VOICE_ID=kPzsL2i3teMYv0FxEYQ6
OPENAI_API_KEY=
OPENAI_DASHBOARD_CHAT_MODEL=gpt-5.4-2026-03-05
```

Run locally:

```powershell
npm run dev
```

The dashboard runs on `http://localhost:4888` and the API runs on `http://localhost:4001`.

## Demo Account

Seed a polished local demo account on the current agent model with three coherent agents, email/phone history, approvals, billing usage, and audit logs:

```powershell
npm run seed:demo
```

Login:

```text
Email: demo@barkan.dev
Password: demo-password
```

You can override the credentials with `DEMO_EMAIL`, `DEMO_PASSWORD`, and `DEMO_NAME`.

## Production Deploy

Normal builds are verification-only and do not update production:

```powershell
npm run build
```

Initialize or reload the production API process in PM2:

```powershell
npm run pm2:start-prod-api
```

Production and staging releases use the go-live deploy script:

```powershell
npm run check-env -- --env staging --file .env.staging
npm run deploy:prod -- --target staging
npm run check-env -- --env production --file .env.production
npm run deploy:prod -- --target production
```

Web-only static releases remain available:

```powershell
npm run deploy:barkan-web
```

## Agent APIs

Agent-facing endpoints use `Authorization: Bearer <identity_token>` and live under `/api/v1/agent/*`:

| Method & path | Purpose |
|---|---|
| `POST /api/v1/agent/email/send` | Send governed email |
| `GET /api/v1/agent/email/threads` | List email threads |
| `POST /api/v1/agent/email/threads/:threadId/reply` | Reply in an email thread |
| `POST /api/v1/agent/phone/call` | Place governed outbound call |
| `POST /api/v1/agent/phone/sms` | Send governed SMS |
| `GET /api/identity/:agentId/audit-log` | Read agent audit log |

Payment cards are waitlist-only. Current production payments are SaaS billing through Stripe under `/api/v1/billing/*`.

## Project Structure

```text
apps/
  api/                     Fastify + MongoDB backend
  web/                     React + Vite dashboard
packages/                  Workspace packages (empty for now)
scripts/                   Dev, deploy, and build helper scripts
infra/                     Caddy reverse proxy configuration
openclaw-skills/           OpenClaw-facing identity skill
docs/                      Product and integration notes
_bmad/                     BMAD configuration
.agents/                   BMAD agent skills
ecosystem.config.cjs       PM2 process definitions
package.json               npm workspace root
AGENTS.md                  Repo architecture and agent instructions
```
