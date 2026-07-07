model: gpt 5.5

# Task 012 — Agents UI: creation wizard, list, detail on the v1 API

## Depends on
010, 011

## Context
The current onboarding ("choose an OpenClaw endpoint or managed deployment", "copy a link prompt") is built around the legacy site-setup flow and fake provisioning. Task 010 delivered `/api/v1/agents` with capability provisioning states.

## Objective
The real agent lifecycle in the dashboard: create an agent, pick capabilities, watch provisioning progress, manage tokens — user-facing language per `AGENTS.md` (agent identity, OpenClaw link).

## Spec
- **Creation wizard** (`/agents/new`, 3 steps):
  1. Identity: name, description, runtime (OpenClaw / Hermes / API — radio with icons).
  2. Capabilities: email / phone toggle cards, each stating exactly what will be provisioned and (from task 043 onward) plan limits; a third **Payment card** tile rendered disabled with a "Coming soon" badge (tooltip: "Controlled agent spending is on the roadmap") — not clickable, never sent to the API.
  3. Review & create → POST → **token reveal screen**: identity token displayed once with copy button + "I stored it" confirm; then runtime-specific connect instructions (env vars `BARKAN_API_URL`, `BARKAN_IDENTITY_TOKEN`; deeper skill/MCP install instructions land with tasks 047/048 — link placeholders now).
- **List page**: cards with name, status pill (`provisioning` animated, `active`, `paused`, `revoked`), contact points (email, phone when provisioned), capability icons, created date. Empty state sells the product ("Give your agent a real phone number and email address").
- Delete `apps/web/src/components/PaymentsPanel.tsx` and its payment client methods in `api.ts` (the API-side fake payment routes are removed later, in task 031) — the only card surface left in the web app is the "Coming soon" tile.
- **Detail page Overview tab**: status, contact points with copy buttons, capability toggles calling enable/disable endpoints (with confirm dialogs; disable warns about releasing the phone number), token list (prefix, name, created, last used) + rotate/revoke + create, danger zone (pause / delete with typed-name confirm).
- Provisioning progress: poll `GET /api/v1/agents/:agentId` every 3s while any capability state is `pending`; render per-capability progress rows (e.g. "Buying phone number…", "Configuring voice agent…" from `provisioning.<cap>.detail`).
- Remove the old site-setup screens and their `api.ts` calls entirely.

## Implementation steps
1. Build `api/agents.ts` client functions for every task-010 endpoint with types.
2. Implement wizard, list, detail-overview per spec; reuse existing Tailwind component idioms (`components/`).
3. Delete legacy onboarding components + dead `api.ts` functions; run web tests.
4. Component tests: wizard step validation (empty name blocked), token reveal shows secret exactly once (re-render → masked), capability toggle fires correct endpoint, provisioning poller stops when all states terminal.

## Acceptance criteria
- A new user can create an agent end-to-end without ever seeing "site" or "domain" language.
- Refreshing mid-provisioning resumes correct progress display.
- Tokens manageable from the UI; revoked token immediately fails on the API (manually verified).

## How to test
```bash
npm --workspace @barkan/web run test -- agents
pm2 restart dev-barkan-web dev-barkan-api --update-env
# Manual: http://localhost:4888/agents/new — create "Maya" with email capability only.
# Copy the token, then:
curl -s localhost:4001/api/identity/<agent_id>/audit-log -H "authorization: Bearer <token>" | jq .
# UI shows contact points after provisioning tasks (016/023/034) land — for now states show "not provisioned".
```
