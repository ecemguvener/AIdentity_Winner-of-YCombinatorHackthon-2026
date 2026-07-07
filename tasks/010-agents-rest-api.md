model: fable 5

# Task 010 — Agents REST API v1 (replace the sites/site-setups flow)

## Depends on
005, 006, 007, 008

## Context
The dashboard drives identity creation through legacy `POST /api/site-setups` → `POST /api/site-setups/:projectId/complete` (see `apps/api/src/sites.ts`), which stores a "domain" that means nothing anymore. Agents are now first-class (`agents` collection). This task builds the owner-facing agent API; the web UI switches over in task 012.

## Objective
Full `/api/v1/agents` resource with capability toggles and token management, plus a provisioning status model that later capability tasks plug into.

## Spec — session-authenticated routes in new `apps/api/src/agents-routes.ts`
```
POST   /api/v1/agents                 { name, description?, runtime?, capabilities?: {email,phone}, approvalMode? }
                                      -> 201 { agent, identityToken: { secret, prefix } }  // secret shown once
GET    /api/v1/agents                 -> { agents: [...] } with per-capability provisioning summary
GET    /api/v1/agents/:agentId        -> { agent, tokens: [redacted], provisioning: { email: {...}, phone: {...} } }
PATCH  /api/v1/agents/:agentId        { name?, description?, approvalMode?, status? ("active"|"paused") }
DELETE /api/v1/agents/:agentId        -> soft delete: status "revoked", revoke all tokens, capability teardown hooks
POST   /api/v1/agents/:agentId/tokens          { name? } -> { secret, prefix }   (max 5 active)
DELETE /api/v1/agents/:agentId/tokens/:tokenId
POST   /api/v1/agents/:agentId/capabilities/:capability/enable    (capability = email|phone; "card" -> 400 `validation_failed` "coming soon")
POST   /api/v1/agents/:agentId/capabilities/:capability/disable
```
- Capability enable/disable dispatches to a **provisioner registry**: `apps/api/src/provisioning.ts` exposing `registerProvisioner(capability, { provision(agent), deprovision(agent), status(agent) })`. This task registers stub provisioners that set `agents.capabilities.<cap>` and return `{ state: "not_provisioned" }`; email/phone tasks (016/023) replace them with real ones. Provisioning runs async — enable returns 202 with `{ provisioning: { state: "pending" } }` and the UI polls agent detail.
- `serializeAgent` includes: id, name, slug, status, capabilities, approvalMode, contact points (emailAddress?, phoneE164? — read from `emailAccounts`/`phoneNumbers`), createdAt.
- Ownership enforced on every route; audit entries for create/update/delete/token ops.
- Legacy `/api/sites*` routes remain but are now thin adapters reading `agents` (map fields; keep response shapes) so the un-migrated web UI keeps functioning until task 012. Add `deprecation: true` response header on legacy routes.

## Implementation steps
1. Implement provisioner registry + stubs, routes, serializers, zod schemas.
2. Rewrite `sites.ts` handlers as adapters over `agents` (read path only; `POST /api/site-setups` creates an agent under the hood).
3. Integration tests: full CRUD lifecycle, token cap (6th token → 409 `validation_failed`), capability enable → 202 + status transitions, cross-user access → 404, legacy adapter parity (old client shape assertions).

## Acceptance criteria
- New dashboard flows possible entirely via `/api/v1/agents*`.
- Legacy site routes still return the shapes `apps/web/src/api.ts` expects (run existing web tests).
- Deleting an agent revokes tokens (agent API calls 401 afterward) and calls capability `deprovision` hooks.

## How to test
```bash
npm --workspace @barkan/api run test -- agents-routes
COOKIE=... # login as in task 007
curl -s -X POST localhost:4001/api/v1/agents -H "cookie: $COOKIE" -H 'content-type: application/json' \
  -d '{"name":"Maya","capabilities":{"email":true,"phone":false}}' | jq .
curl -s localhost:4001/api/v1/agents -H "cookie: $COOKIE" | jq '.agents[0]'
npm --workspace @barkan/web run test   # legacy client contract still green
```
