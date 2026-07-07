model: fable 5

# Task 013 — Approvals engine: pending actions, SSE stream, decision API

## Depends on
006, 007, 008

## Context
Human-in-the-loop is the core safety promise. Today "approval" is a boolean the *agent itself* sends (`approved: true` in `identity.ts#checkAction`) — security theater: the agent approves its own actions. Real design: the agent's request creates a **pending approval**; the owner decides in the dashboard (or via email link); the action executes only after approval.

## Objective
Generic approvals service any capability can use, with SSE push to the dashboard, email notification to the owner, expiry, and a blocking "wait for decision" helper for agent calls.

## Spec
- `apps/api/src/approvals.ts` service:
  - `requestApproval(collections, { agentId, ownerUserId, kind, payloadSummary, payload, ttlMinutes = 60 }) -> approval` (status `pending`, `expiresAt`); audit `approval.requested`; notify owner (email via platform sender when `PROVIDER_MODE_EMAIL=live` and user preference on; always SSE).
  - `decideApproval(collections, ownerUserId, approvalId, decision: "approved"|"rejected", note?)` — only while `pending`; sets `decidedAt`; audit; emits SSE + resolves waiters.
  - `waitForDecision(approvalId, { timeoutMs }) -> "approved"|"rejected"|"expired"|"timeout"` — in-process pub/sub (EventEmitter keyed by id) + DB poll fallback every 5s (correct across multi-process deploys).
  - Expiry sweeper: `setInterval` 60s — flips overdue `pending` → `expired`, audits, emits.
- Routes (session auth):
  - `GET /api/v1/approvals?status=pending|all&cursor=` (owner-scoped)
  - `POST /api/v1/approvals/:id/approve` / `POST /api/v1/approvals/:id/reject` `{ note? }`
  - `GET /api/v1/events` — SSE (`content-type: text/event-stream`): events `approval.requested|approval.decided|approval.expired` + heartbeat comment every 25s; auth via session cookie; one connection per tab is fine.
- Agent-facing behavior contract (used by capability tasks 019/028): when policy says approval required, the tool endpoint either
  - `mode=wait` (default, `?wait=90` max 120s): block awaiting decision, then execute or return 403 `approval_required` variant with `approval.status`, or
  - `mode=async`: return 202 `{ approval_id, status: "pending" }` immediately; agent polls `GET /api/v1/agent/approvals/:id` (bearer-token route, own agent only).

## Implementation steps
1. Service + EventEmitter bus + sweeper; unit tests incl. race (decide vs expire — first writer wins via `findOneAndUpdate` on `status: "pending"`).
2. Routes + SSE endpoint (test with `supertest`-style injected Fastify + manual curl).
3. Bearer route `GET /api/v1/agent/approvals/:id` scoped to the token's agent.
4. Owner email notification: simple template "Agent {name} requests: {payloadSummary} — Approve / Reject" linking to `PUBLIC_APP_URL/approvals?focus=<id>` (links only; decision requires session). Respect `notificationPreferences`.
5. Integration test: request → SSE event received → approve → waiter resolves `approved`; expiry path with fake timers.

## Acceptance criteria
- Two concurrent decisions on one approval: exactly one wins, other gets 409.
- SSE reconnect-safe (client resumes with `GET ...?since=<iso>` returning missed events from DB — implement `since` param).
- `waitForDecision` works when decision happens in another process (DB-poll fallback covered by test that bypasses the emitter).

## How to test
```bash
npm --workspace @barkan/api run test -- approvals
# Manual SSE:
curl -N localhost:4001/api/v1/events -H "cookie: $COOKIE" &
curl -s -X POST localhost:4001/api/v1/approvals/<id>/approve -H "cookie: $COOKIE"
# -> SSE line: event: approval.decided
```
