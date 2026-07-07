model: gpt 5.5

# Task 014 — Approvals inbox UI + live notification bell

## Depends on
011, 013

## Context
Task 013 exposes `/api/v1/approvals`, decision endpoints, and an SSE stream. The dashboard needs a first-class approvals surface — this is what owners look at daily.

## Objective
`/approvals` page + global notification bell fed by SSE, with decision UX fast enough to beat the agent's `wait` timeout.

## Spec
- **Bell in AppShell topbar**: subscribes to `/api/v1/events` via `EventSource` on login; badge = pending count (initial fetch + SSE increments/decrements); dropdown shows 5 newest pending with inline Approve/Reject; toast on new request (`Agent Maya requests: Send email to alice@…`).
- **Approvals page**: tabs Pending / History. Pending cards show: agent name+avatar, kind icon (email/phone/sms), `payloadSummary`, structured payload details (expandable: full recipient, subject, body preview / call target + task), requested time + expiry countdown, Approve / Reject with optional note. History = decided/expired with decision, note, decider timestamps.
- Deep-link `?focus=<id>` (from notification emails) scrolls to and highlights the approval.
- SSE resilience: on `EventSource` error, reconnect with backoff and re-fetch pending list (use `since` param from task 013).
- Optimistic UI on decision; rollback + toast on 409 (someone else decided).
- Empty state: "Nothing needs you. Agents are operating within policy."

## Implementation steps
1. `api/approvals.ts` client + `useApprovalsStream()` hook (EventSource lifecycle, visibility-aware reconnect).
2. Bell + dropdown in AppShell; approvals page with the two tabs; countdown via `expiresAt`.
3. Component tests: badge increments on synthetic SSE event, decision optimistic flow + 409 rollback, focus deep-link highlight.

## Acceptance criteria
- New approval appears in bell + page within 2s without refresh.
- Approve from dropdown works and the corresponding blocked agent call (task 013 `mode=wait`) proceeds — verified manually with two terminals.
- History paginates with cursor.

## How to test
```bash
npm --workspace @barkan/web run test -- approvals
# Manual two-terminal drill:
# T1: create a pending approval via a capability endpoint in wait mode (once 019 lands), or:
curl -s -X POST localhost:4001/api/v1/dev/approvals-demo -H "cookie: $COOKIE"   # add tiny dev-only seeding route behind NODE_ENV!=production if helpful
# T2: watch the bell at http://localhost:4888 — badge appears; approve; T1 unblocks.
```
