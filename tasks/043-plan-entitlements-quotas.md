model: gpt 5.5

# Task 043 — Plan entitlements: enforce limits everywhere

## Depends on
041, 042

## Context
Plans promise limits (agents count, capabilities, included usage). Nothing enforces them yet — a free user could provision 50 phone numbers. Enforcement must be helpful (clear upgrade path), not just blocking.

## Objective
Central entitlements module consulted by every provisioning and usage path.

## Spec
- `apps/api/src/entitlements.ts`:
  - Catalog (single source, shared with 041 plan constants): per plan → `{ maxAgents, capabilities: {email, phone}, includedNumbers, monthlyEmails, monthlyCallMinutes, monthlySms }`. Free: `{1, email-only, 0 numbers, 50, 0, 0}`.
  - `checkEntitlement(collections, ownerUserId, check) -> { allowed, reason?, upgradeHint? }` where check ∈ `agent.create`, `capability.enable(email|phone)`, `usage(email|call_minutes|sms)` (hard stop at 2× included for free/paywall-less accounts; paid plans never hard-stop on metered usage — they pay overage), `number.provision`.
- Enforcement points (each returns 402-style `ApiError` code `plan_limit` with `upgradeHint`):
  - `POST /api/v1/agents` (max agents), capability enable endpoints (capability + number count), `sendAgentEmail`/`sendAgentSms`/`placeOutboundCall` (free-plan usage stops).
- Grandfathering: check against *current* counts only for new actions; existing over-limit resources keep working after a downgrade but paused capabilities cannot re-enable while over limit (test this).
- Web: upgrade prompts — intercept `plan_limit` errors globally in the API client → modal "You've reached the {plan} limit: {reason}" with CTA to `/settings/billing`.

## Implementation steps
1. Entitlements module + catalog + unit tests (every check × every plan matrix — table-driven).
2. Sweep enforcement points (grep provisioning + send paths), integration tests per point (free user enabling phone → 402 `plan_limit`).
3. Web interceptor + modal + component test.
4. Update task 041's downgrade guard to reuse this module (single catalog).

## Acceptance criteria
- Free account: 2nd agent create → 402 with hint "Upgrade to Pro for 3 agents"; phone enable → 402; 51st email → allowed but 101st (2× included) → 402.
- Pro account: 4th agent → 402; metered overage sends never blocked.
- Matrix test covers all plans × all checks (≥ 20 rows).

## How to test
```bash
npm --workspace @barkan/api run test -- entitlements
# Manual: with a free session cookie
for i in 1 2; do curl -s -X POST localhost:4001/api/v1/agents -H "cookie: $COOKIE" -H 'content-type: application/json' -d "{\"name\":\"A$i\"}" | jq -r '.error.code // "created"'; done
# -> created, plan_limit
```
