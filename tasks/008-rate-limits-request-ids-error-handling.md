model: gpt 5.5

# Task 008 — Platform hardening: rate limits, request IDs, consistent errors

## Depends on
003

## Context
`apps/api/src/app.ts` has a decent error handler but no rate limiting, no request correlation, and error payloads vary between modules (`PaymentError`, `EmailError`, `PhoneCallError` each invent shapes). Agent-facing endpoints will be hit programmatically by LLM loops — they need hard limits and machine-readable errors.

## Objective
Uniform API error contract, per-token and per-IP rate limiting, request IDs in logs and responses.

## Spec
- Install `@fastify/rate-limit`. Two policies:
  - Global per-IP: `API_RATE_LIMIT_MAX`/min (config, default 300).
  - Agent-token routes (`/api/tools/*`, `/api/identity/*`, later `/api/v1/agent/*`): 60/min per token (keyGenerator: token hash if bearer present, else IP).
  - Auth routes (`/api/auth/login`, `/api/auth/signup`, `/api/auth/check-email`): 10/min per IP + exponential backoff response header.
- Error contract for every non-2xx: `{ error: { code, message, requestId, details? } }` with stable `code` strings (`unauthorized`, `forbidden`, `not_found`, `rate_limited`, `validation_failed`, `provider_error`, `policy_blocked`, `approval_required`, `plan_limit`, `internal`). Keep top-level legacy `error: string` field too (equal to `message`) so the current web client keeps working until task 011.
- New `apps/api/src/errors.ts`: `ApiError extends Error { statusCode, code, details? }`; refactor `PaymentError`/`EmailError`/`PhoneCallError` to subclass it. Central `setErrorHandler` maps `ApiError`, `ZodError` (→ `validation_failed`), rate-limit errors (→ `rate_limited`), unknown (→ `internal`, logged at error level with stack).
- Request IDs: use Fastify's `genReqId` (crypto random, 16 hex), echo as `x-request-id` response header, include in every log line and error payload.

## Implementation steps
1. Add dependency, register plugin with the three policies (route-level config for auth + agent routes).
2. Implement `errors.ts`, refactor the three error classes and the handler in `app.ts`.
3. Sweep modules for ad-hoc `reply.code(4xx).send({error: ...})` and convert to `throw new ApiError(...)` (grep `reply.code(4`).
4. Tests: rate limit triggers 429 with `code: "rate_limited"` and `retry-after`; zod failure shape; unknown error hides internals (message `internal server error`, no stack leak); `x-request-id` present on success and failure.

## Acceptance criteria
- 61st request in a minute with the same bearer token → 429; different tokens → independent buckets.
- Every error response has `error.code`, `error.requestId`; legacy `error` string preserved.
- No route handler sends raw 5xx bodies anymore.

## How to test
```bash
npm --workspace @barkan/api run test -- errors rate-limit
# Manual burst:
for i in $(seq 1 12); do curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:4001/api/auth/login -H 'content-type: application/json' -d '{"email":"x@x.co","password":"nope"}'; done
# -> 401s then 429s
curl -si localhost:4001/api/health | grep -i x-request-id
```
