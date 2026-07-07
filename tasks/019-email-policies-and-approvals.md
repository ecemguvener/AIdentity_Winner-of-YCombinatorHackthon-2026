model: gpt 5.5

# Task 019 — Email policies + approval gating

## Depends on
013, 017, 018

## Context
Approvals engine (013) and real sending (017) exist. Now enforce the owner's rules: who the agent may email, how much, and when a human must confirm. Policy docs live in `policies.email` (task 004).

## Spec
- `policies.email` shape:
  ```ts
  { requireApproval: "always" | "new_recipients" | "never",
    allowedRecipients: string[],      // exact emails or "@domain.com" patterns; empty = all allowed
    blockedRecipients: string[],      // same patterns; beats allowed
    dailySendLimit: number,           // default 50
    maxRecipientsPerMessage: number } // default 5 (when cc support used)
  ```
  Defaults created with the agent (`requireApproval: "always"` when agent.approvalMode = "always", else "new_recipients").
- Enforcement in `sendAgentEmail` before provider call, order: blocked → allowed-list → daily cap (count today's outbound from `emailMessages`) → approval decision:
  - `always` → approval; `new_recipients` → approval only if no prior outbound to that address; `never` → send.
  - Approval path uses task 013 contract: `?wait=` blocks (default 90s), `mode=async` returns 202 with `approval_id`; on approval the send executes server-side (the stored payload is executed by `decideApproval` via an executor callback registry — register `email.send` executor in this task).
- Owner routes: `GET/PUT /api/v1/agents/:agentId/policies/email` (zod-validated, audit `policy.updated` with diff summary).
- Violations return 403 `policy_blocked` with human-readable reason; audit `email.blocked`.
- Web: policy editor card in agent detail Email tab (recipient chips, limits, approval mode radio) — minimal but functional; full email UI is task 020.

## Implementation steps
1. Policy module `apps/api/src/policies.ts` with generic `getPolicy/updatePolicy` (email section now; phone section in 028) + pattern matcher (`alice@x.com`, `@x.com`) with tests (case-insensitivity, subdomain non-match).
2. Executor registry in approvals service: `registerApprovalExecutor(kind, fn)`; on approve → run executor with stored payload; store `executionResult`/`executionError` on the approval.
3. Wire enforcement into `sendAgentEmail`; integration tests: each policy branch, wait-mode approve → mail sent exactly once; reject → 403 + no send; expiry → no send.
4. Policy editor UI + client + component test.

## Acceptance criteria
- With `requireApproval: "always"`: agent send call blocks, owner approves in dashboard, email sends, agent receives the final message payload (status `sent`, message id) in the original blocked response (wait mode).
- Daily cap: 51st send today → 403 `policy_blocked` and audit row; cap counts only `sent|delivered` (not failed).
- Approved payload executes even if the agent disconnected (async mode) — verified by test.

## How to test
```bash
npm --workspace @barkan/api run test -- email-policy approvals-executor
# Manual (wait mode):
curl -s -X POST "localhost:4001/api/v1/agent/email/send?wait=60" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"to":"new-person@example.com","subject":"Hi","text":"Intro"}' &
# Approve in the dashboard bell -> curl returns {"status":"sent",...}
```
