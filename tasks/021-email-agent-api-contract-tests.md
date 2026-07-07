model: gpt 5.5

# Task 021 — Email capability: agent API contract freeze + test suite

## Depends on
017, 018, 019

## Context
Email is the first complete capability. Before phone copies its patterns, freeze the agent-facing contract and prove it with an exhaustive suite — these tests define what the MCP server (046) and skills (047/048) rely on.

## Objective
A single spec-grade test file + fixture kit covering every email endpoint, auth mode, policy branch, and failure shape.

## Spec — the frozen contract (bearer token)
```
POST /api/v1/agent/email/send                    {to, subject, text, html?, idempotencyKey?}  [?wait|mode=async]
GET  /api/v1/agent/email/threads?cursor=
GET  /api/v1/agent/email/threads/:threadId
POST /api/v1/agent/email/threads/:threadId/reply {text}  [?wait|mode=async]
GET  /api/v1/agent/email/address                 -> { address, displayName, status }   (add if missing)
GET  /api/v1/agent/approvals/:id
```
Error codes agents must be able to rely on: `unauthorized`, `policy_blocked` (+reason), `approval_required` (+approval_id/status), `validation_failed`, `provider_error`, `rate_limited`.

## Implementation steps
1. `apps/api/src/email-contract.test.ts`: table-driven cases — happy paths, every policy branch (blocked recipient, allowlist miss, cap, approval wait approved/rejected/expired/timeout), idempotent replay, thread ownership 404s, revoked-token 401, malformed payload 400 shapes, pagination cursors, mock-provider call counting.
2. Snapshot the JSON shapes (vitest inline snapshots) so accidental contract drift fails CI.
3. Add `GET /api/v1/agent/email/address` if task 016/017 didn't.
4. Write `docs/api/email.md`: endpoint table, request/response examples pulled from the snapshots, error code table. This doc is the source for OpenAPI in task 045.

## Acceptance criteria
- Suite ≥ 25 cases, all green, zero live-network calls (mock provider + memory Mongo).
- Contract doc matches snapshots exactly.
- Coverage report for `email-service.ts` ≥ 90% lines (`vitest run --coverage`).

## How to test
```bash
npm --workspace @barkan/api run test -- email-contract
npm --workspace @barkan/api run test -- --coverage email
```
