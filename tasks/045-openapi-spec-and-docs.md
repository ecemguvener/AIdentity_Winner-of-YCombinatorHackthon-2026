model: gpt 5.5

# Task 045 — OpenAPI spec + hosted API reference

## Depends on
021, 030 (frozen contracts)

## Context
Two contract docs exist (`docs/api/email.md`, `phone.md`) plus agents/billing/approvals routes. Integrators (and tasks 046-050) need a machine-readable spec and a browsable reference.

## Objective
Complete OpenAPI 3.1 document generated from the zod schemas, served by the API, with a docs page.

## Spec
- Add `fastify-type-provider-zod` + `@fastify/swagger` (or `zod-openapi` if the fastify plugin fights the existing setup — implementer's call, but zod schemas remain the single source).
- Annotate all **public** surfaces: agent-facing `/api/v1/agent/*` (bearer auth scheme), owner `/api/v1/*` (cookie auth, marked `x-internal: true` — included but flagged), webhooks documented as callbacks where cheap.
- Serve: `GET /api/v1/openapi.json`; docs UI at `GET /docs` (Scalar via CDN or `@scalar/fastify-api-reference`) — public route (no auth), CORS-exempt path list updated (`cors.ts#isPublicCorsPath`).
- Spec completeness gate: a test walks Fastify's route table and fails if any `/api/v1/agent/*` route lacks an OpenAPI operation (forces future tasks to document).
- Security schemes: `bearerAuth` (identity token), `cookieAuth`; every operation tagged (`email`, `phone`, `agents`, `approvals`, `billing`).
- Error envelope (task 008) as a shared component schema referenced by all 4xx/5xx responses.
- Update `docs/api/*.md` to link the live reference; add `docs/api/authentication.md` (token issuance, rotation, header format, rate limits).

## Implementation steps
1. Wire the type provider incrementally (route registration refactor risk is real — do module by module, running tests between).
2. Completeness-gate test; fix gaps it finds.
3. Docs route + Scalar page + smoke test (200, contains "Barkan").
4. Add `npm --workspace @barkan/api run openapi:export` → writes `docs/api/openapi.json` (committed, used by SDK task 050).

## Acceptance criteria
- `openapi.json` validates (`npx @redocly/cli lint`).
- Every frozen-contract endpoint from 021/030 present with request/response schemas matching snapshots.
- `/docs` renders and is reachable unauthenticated; agent endpoints show bearer security.

## How to test
```bash
npm --workspace @barkan/api run test -- openapi
npm --workspace @barkan/api run openapi:export && npx @redocly/cli lint docs/api/openapi.json
open http://localhost:4001/docs
```
