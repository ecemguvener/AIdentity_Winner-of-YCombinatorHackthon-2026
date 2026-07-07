model: gpt 5.5

# Task 020 — Email tab UI: real inbox, threads, compose

## Depends on
011, 018, 019

## Context
`apps/web/src/components/EmailPanel.tsx` renders the old mock email flow. Real threads/messages now exist server-side. Owners need owner-scoped read access — add owner mirrors of the agent read APIs (the agent-facing ones are bearer-token).

## Spec
- API (session auth, owner-scoped — implement in this task on the API): `GET /api/v1/agents/:agentId/email/threads`, `GET .../threads/:threadId`, `POST .../threads/:threadId/reply`, `POST .../send` (owner sends as the agent — audited as `actor: "owner"`), plus `GET .../email/policy` already from 019.
- **Email tab** in agent detail (replace `EmailPanel.tsx`):
  - Header: agent address with copy button + status (paused banner with resume if `emailAccounts.status = "paused"`), today's send count vs `dailySendLimit`.
  - Two-pane inbox: left thread list (counterparty, subject, snippet, relative time, unread dot, direction glyph), right conversation view (bubbles by direction, sender line, timestamps, attachment chips downloading via proxy, AI `summary` block on newest inbound + "Use suggested reply" button pre-filling composer).
  - Composer: reply in-thread + "New email" modal (to, subject, body); shows policy outcome inline — if approval required, banner "Waiting for approval — check the bell" linking to the approval.
  - Policy editor card from task 019 embedded at the bottom (settings accordion).
- Live updates: subscribe to SSE `email.received` (task 018) → refresh active thread/list.
- Loading, empty ("No conversations yet — share {address} or let the agent introduce itself"), and error states throughout.

## Implementation steps
1. Owner-scoped API routes (thin wrappers over existing services with ownership checks) + tests.
2. Rebuild the tab per spec with the typed client; delete `EmailPanel.tsx` mock code entirely.
3. Component tests: thread selection renders messages, suggested-reply prefill, approval-pending banner on 202 response, SSE refresh handler.

## Acceptance criteria
- Owner can read every conversation, reply, and compose; all actions appear in Audit tab.
- Inbound mail arriving while the tab is open appears without refresh (<3s).
- No mock/demo email data or copy remains in the web bundle (`grep -rn "mockEmail\|Simulated" apps/web/src` → nothing relevant).

## How to test
```bash
npm --workspace @barkan/web run test -- email
# Manual: open agent detail → Email tab; run the task-018 live E2E (Gmail reply) and watch it appear live.
# Send as owner; verify audit entry actor=owner in Audit tab.
```
