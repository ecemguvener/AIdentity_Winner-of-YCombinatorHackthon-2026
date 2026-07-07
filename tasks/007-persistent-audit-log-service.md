model: gpt 5.5

# Task 007 — Persistent audit log service + owner-facing audit API

## Depends on
006

## Context
Audit entries are the product's trust backbone ("every agent action is accountable") yet they live in per-module in-memory maps (`identity.ts#pushAudit`, called from `payments.ts`/`email.ts` via `recordIdentityAudit`). Task 004 created the `auditLogs` collection; task 006 started writing identity events into it directly.

## Objective
One audit service module used by every capability, plus owner-facing query APIs with filtering/pagination and CSV export.

## Spec
- New `apps/api/src/audit.ts`:
  - `recordAudit(collections, entry: { agentId, ownerUserId?, actor, action, status, detail, resourceType?, resourceId?, metadata? })` — inserts, never throws to callers (log + swallow storage errors), returns the inserted id.
  - Action taxonomy constants: `identity.init|revoke|token.rotate`, `email.send|receive|blocked`, `phone.call.outbound|inbound`, `sms.send|receive`, `approval.requested|approved|rejected|expired`, `policy.updated`, `billing.*`.
- Owner routes (session-authenticated, in a new `apps/api/src/audit-routes.ts` registered from `app.ts`):
  - `GET /api/v1/audit?agentId=&action=&status=&from=&to=&cursor=&limit=` (default 50, max 200; cursor = last `_id`).
  - `GET /api/v1/audit/export.csv` same filters, streams CSV.
- Agent route `GET /api/identity/:agentId/audit-log` switches to this service (keep response shape).
- Replace every `pushAudit`/`recordIdentityAudit` call site across `identity.ts`, `payments.ts`, `email.ts`, `dashboard-chat.ts` with `recordAudit`. Delete the old helpers.

## Implementation steps
1. Implement service + constants + unit tests (insert shape, filter query building, cursor pagination edge cases).
2. Implement owner routes with zod-validated query params; enforce `ownerUserId` scoping (a user can only read audit for agents they own).
3. CSV export: header row, RFC4180 escaping, streams in chunks of 500 docs.
4. Integration test: two users, two agents each; user A queries → only own rows; filters by action prefix (`action=email.`) work via regex anchored prefix.

## Acceptance criteria
- Zero in-memory audit stores left (`grep -rn "auditLogsByAgentId" apps/api/src` → nothing).
- Pagination is stable under concurrent inserts (cursor by `_id`).
- Export of 1,000+ rows streams without buffering everything (verified by memory-friendly implementation: no `.toArray()` on the full set).

## How to test
```bash
npm --workspace @barkan/api run test -- audit
# Manual:
COOKIE=$(curl -si -X POST localhost:4001/api/auth/login -H 'content-type: application/json' -d '{"email":"demo@aidentity.test","password":"demo-password"}' | grep -oi 'barkan_session=[^;]*')
curl -s "localhost:4001/api/v1/audit?limit=5" -H "cookie: $COOKIE" | jq '.entries | length'
curl -s "localhost:4001/api/v1/audit/export.csv" -H "cookie: $COOKIE" | head -3
```
