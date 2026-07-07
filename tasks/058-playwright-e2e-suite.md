model: fable 5

# Task 058 — Playwright E2E: the golden path through real browsers

## Depends on
051, 056, 057

## Context
Task 051 proved the API loops; this proves the *product* — real browser, real UI, mock providers. This suite is the pre-deploy gate: if the golden path breaks, deploys stop.

## Objective
Playwright suite covering the money paths of the UI, runnable headless in CI (< 8 min) against a freshly booted stack.

## Spec
- New root `e2e/` with `@playwright/test`; `playwright.config.ts` boots API (mock providers, ephemeral Mongo via `mongodb-memory-server` wrapper script, distinct port) + web (vite preview build) via `webServer` config; base fixtures: `freshUser` (API-signup via request context), `demoUser` (seed script), `agentToken`.
- Specs:
  1. `auth.spec` — signup, logout, login, wrong password, session persistence across reload.
  2. `agent-creation.spec` — wizard end-to-end, token reveal copy, provisioning progress reaches active (mock), contact points render.
  3. `approvals.spec` — trigger approval via API token (email send wait mode in background request), bell badge appears, approve from dropdown, background request resolves `sent` (poll the API from the test).
  4. `email.spec` — synthetic inbound webhook → thread appears live (SSE) → owner replies → outbound row.
  5. `phone.spec` — owner test-call (mock) → call row → synthetic post-call webhook → transcript drawer renders turns.
  6. `billing.spec` — plan grid renders from API, free-plan limit modal on 2nd agent (entitlements), ops status card shows mock modes.
  7. `onboarding.spec` — fresh user checklist steps 1-4 (mock runtime connect by calling whoami with the revealed token from the test).
- Stability rules: no `waitForTimeout` (event/response-based waits only), `data-testid` on interactive elements added across the web app where selectors are brittle (sweep included), retries=1 in CI, trace+video on failure.
- Scripts: root `npm run e2e:ui` (headed debug) + `npm run e2e` (CI); GitHub-Actions-ready notes (cache browsers) in `docs/operations.md` even if CI isn't wired yet.

## Implementation steps
1. Config + boot orchestration + fixtures (the API test-support endpoints for webhook fixtures exist from 051 — expose behind `NODE_ENV=test`-only routes; never in production builds: assert route absent in prod-mode test).
2. Specs in order, hardening selectors as you go.
3. Flake pass: run suite 5× (`--repeat-each=5` on critical specs) and fix any intermittents.
4. Wire `npm run e2e` into the deploy script (task 059) as a pre-deploy gate.

## Acceptance criteria
- Full suite green headless < 8 min; 5× repeat of specs 3/4/5 with zero flakes.
- Trace artifacts produced on an intentionally broken run (drill documented in PR).

## How to test
```bash
npx playwright install --with-deps chromium
npm run e2e
npm run e2e -- --repeat-each=5 e2e/approvals.spec.ts e2e/email.spec.ts e2e/phone.spec.ts
```
