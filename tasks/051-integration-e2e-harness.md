model: fable 5

# Task 051 — Integration harness: scripted end-to-end capability proof

## Depends on
046, 047, 050

## Context
Individual capabilities are tested; the business needs proof the *whole loop* works: runtime → MCP/SDK → policy → approval → provider → webhook → audit → billing meter. This harness is the regression net that keeps the product honest after every future change, runnable in mock mode (CI) and live mode (staging drills). (No card scenarios — the capability is deferred.)

## Objective
`npm run e2e:integration` — a scripted scenario runner exercising the golden paths across email, phone, and billing, with human-readable pass/fail report.

## Spec
- New `apps/api/e2e/` (vitest, separate config `vitest.e2e.config.ts`, sequential):
  - Boots the full app (memory Mongo replset, mock providers, fake timers off — real async).
  - **Scenario: owner lifecycle** — signup → create agent (email + phone) → provisioning completes (mock) → token works.
  - **Scenario: email loop** — SDK send (approval wait) → approve via owner API → mock provider "delivers" → synthetic inbound webhook (framework fixture) → SDK reads thread → reply → audit chain complete (assert exact action sequence).
  - **Scenario: phone loop** — SDK call → approve → mock completes → synthetic post-call webhook with transcript → SDK `waitForCompletion` returns summary; inbound personalization fixture → call row attributed.
  - **Scenario: sms 2FA** — synthetic inbound SMS with code → SDK `latestCode` extracts.
  - **Scenario: billing loop** — subscribe fixture (`checkout.session.completed` + `customer.subscription.created`) → plan flips to pro → usage events recorded from the email/phone scenarios → reporter dry-run shows expected overage deltas.
  - **Scenario: safety** — declined paths: policy block, plan limit, revoked token mid-loop (assert 401 + audit).
  - Each scenario asserts final **invariants**: audit completeness, usageEvents counts, zero `webhookEvents` in `failed`.
- MCP-path variant: run the email scenario again through a real MCP client (SDK from `@modelcontextprotocol/sdk`) against `/mcp` to prove parity (result + audit identical to service path).
- Live mode (`E2E_MODE=live`, staging env + real test-mode providers): same scenarios where automatable (email via a mailbox check API is overkill — live mode asserts provider acceptance + webhook receipt within timeout, not inbox content; phone scenario places a real call to a Twilio test number). Document which assertions relax.
- Report: per-scenario table (name, steps passed, duration) printed at end; non-zero exit on any failure.

## Implementation steps
1. E2E config + app-boot helper + fixture toolkit (signed webhook builders reused from unit suites).
2. Scenarios in order; keep each under 200 lines by sharing step helpers (`asOwner`, `asAgent`, `deliverWebhook`).
3. MCP parity variant.
4. Root script `e2e:integration`; CI wiring note (runs on PR, mock mode, target < 5 min).

## Acceptance criteria
- Full mock run green locally + in CI < 5 min.
- Deliberately breaking the email threading logic (mutation test: comment a line) fails the email scenario — prove the net catches regressions (document the drill in PR).
- Live run against staging completes with relaxed assertions (attach report).

## How to test
```bash
npm run e2e:integration
E2E_MODE=live PUBLIC_API_URL=https://staging.barkan.dev npm run e2e:integration   # staging drill
```
