model: fable 5

# Task 017 — Outbound email: real sending, persistent threads, idempotency

## Depends on
016

## Context
`apps/api/src/email.ts` (39KB) holds the hackathon email stack: in-memory threads/messages/notifications, Resend send with sandbox redirect, OpenAI drafting. Threads must move to Mongo (`emailThreads`/`emailMessages` from task 004) and sending must be production-grade. Keep the OpenAI drafting helpers (`draft from plain text`) — they're real and useful.

## Objective
Rewrite the outbound path onto persistent storage with a provider interface, delivery-status tracking, and idempotent sends.

## Spec
- Provider interface `apps/api/src/providers/email-provider.ts`: `sendEmail({ from, to, cc?, subject, text, html?, attachments?, headers? }) -> { providerMessageId }`; implementations `ResendEmailProvider` (SDK, `reply_to` = agent address, custom `Idempotency-Key` header passthrough if supported by SDK — else dedupe on our side) and `MockEmailProvider` (logs, returns `mock_<id>`; used when `PROVIDER_MODE_EMAIL=mock`). Selection at boot from config — no per-call fallback.
- Service `apps/api/src/email-service.ts`:
  - `sendAgentEmail(collections, config, { agent, to, subject, text, html?, threadId?, idempotencyKey? })`:
    1. Resolve the agent's `emailAccounts` address (403 `policy_blocked` if paused).
    2. Thread resolution: explicit `threadId` (must belong to agent) → else find `emailThreads` by `{agentId, counterpartyEmail: to}` → else create.
    3. Idempotency: `idempotencyKey` stored on the message; same key + agent → return existing message, no re-send.
    4. Insert `emailMessages` (`status: "queued"`) → call provider → update `providerMessageId`, `status: "sent"` (delivery/bounce updates arrive via task 015 webhook) → on provider throw: `status: "failed"` + `ApiError provider_error`.
    5. Audit `email.send`; usage event hook (`emails_sent`, no-op until task 042).
  - `From` format: `"{agent.name}" <address>`.
- Rewrite bearer routes on the service, replacing in-memory versions in `email.ts`: `POST /api/tools/email/send` (compat) + new `POST /api/v1/agent/email/send` (same handler; `?wait`/approval handling arrives in task 019 — for now direct send).
- Delete the in-memory outbound stores; inbound maps die in task 018 (leave them compiling meanwhile, clearly marked `// LEGACY — removed in task 018`).

## Implementation steps
1. Provider interface + both implementations (+ contract test run against mock; live test skipped unless `RESEND_API_KEY` present).
2. Service with thread/idempotency logic + unit tests (new thread vs reuse, ownership check on threadId, idempotent replay, failure path).
3. Route rewiring + integration tests through Fastify inject with bearer token.
4. Verify delivery-status webhook (task 015) updates these rows end-to-end in a live smoke test.

## Acceptance criteria
- Same `idempotencyKey` twice → one provider call, one message row (asserted with mock provider call counter).
- Live mode with verified domain: a real email lands in an external inbox with correct From name/address, and `status` progresses `queued → sent → delivered` via webhook.
- No outbound in-memory state; restart mid-thread keeps thread continuity (test: send, restart-simulate, send same counterparty → same thread).

## How to test
```bash
npm --workspace @barkan/api run test -- email-service
# Live smoke (real Resend + verified domain + tunnel from task 015):
curl -s -X POST localhost:4001/api/v1/agent/email/send -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"to":"you@yourinbox.com","subject":"Barkan live test","text":"Hello from Maya"}' | jq .
# Check your inbox; then:
curl -s "localhost:4001/api/v1/agent/email/threads" -H "authorization: Bearer $TOKEN" | jq '.threads[0]'
```
