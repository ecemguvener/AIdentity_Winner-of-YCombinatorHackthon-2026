model: gpt 5.5

# Task 030 — Phone capability: contract freeze + test suite

## Depends on
025, 026, 027, 028

## Context
Mirror of task 021 for the phone capability: freeze the agent-facing contract before MCP/skills consume it, and prove mock-mode determinism for CI.

## Spec — frozen contract (bearer token)
```
POST /api/v1/agent/phone/call            {to, task, context?, recipientName?}   [?wait|mode=async]
GET  /api/v1/agent/phone/calls?cursor=
GET  /api/v1/agent/phone/calls/:callId   -> status, durationSecs, summary, transcript?
POST /api/v1/agent/phone/sms             {to, body, idempotencyKey?}            [?wait|mode=async]
GET  /api/v1/agent/phone/sms?with=&cursor=
GET  /api/v1/agent/phone/sms/latest-code?from=&since=
GET  /api/v1/agent/phone/number          -> { e164, country, capabilities, status }  (add if missing)
```

## Implementation steps
1. `apps/api/src/phone-contract.test.ts`: table-driven — happy paths (mock provider), all policy branches (country, caps, quiet hours, approval wait/async/reject/expire), no-number 409, idempotent SMS replay, latest-code extraction matrix, transcript retrieval after simulated post-call webhook, revoked token 401, pagination, snapshot every response shape.
2. Mock determinism: with `PROVIDER_MODE_PHONE=mock`, the full suite runs with zero network and stable time (vitest fake timers for the 2s mock call completion).
3. Add `GET /api/v1/agent/phone/number` if missing.
4. `docs/api/phone.md` contract doc from snapshots (feeds task 045 OpenAPI).

## Acceptance criteria
- ≥ 30 cases green, zero live calls, suite < 30s.
- `phone-service.ts` + `sms-service.ts` line coverage ≥ 90%.
- Docs match snapshots.

## How to test
```bash
npm --workspace @barkan/api run test -- phone-contract
npm --workspace @barkan/api run test -- --coverage phone sms
```
