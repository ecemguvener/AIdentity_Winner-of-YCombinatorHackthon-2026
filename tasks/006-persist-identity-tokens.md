model: fable 5

# Task 006 — Persist agent identities and bearer tokens (kill the in-memory maps)

## Depends on
005

## Context
`apps/api/src/identity.ts` keeps `identitiesByToken` / `identitiesById` in memory: every API restart wipes all agent identities and tokens — the single worst fake in the codebase. Tokens are also stored in plaintext in memory and returned as `identity_live_...`.

## Objective
Identity issuance, authentication, and revocation fully backed by MongoDB (`agents` + `identityTokens` from task 004), with hashed tokens and a reusable Fastify auth helper for all agent-facing routes.

## Spec
- Token format: `brk_live_<43 chars base64url>` (mock mode: `brk_test_...`). Store only `sha256` hash (reuse `security.ts#hashApiKey`), plus `prefix` (first 12 chars) for display.
- New module `apps/api/src/agent-auth.ts`:
  - `issueIdentityToken(collections, agentId, name) -> { plaintext, tokenDoc }` (plaintext returned exactly once).
  - `authenticateAgentRequest(request, collections) -> { agent, token } | null` — parses `Authorization: Bearer`, hash-lookups `identityTokens` (status active, not expired), loads agent (status active), updates `lastUsedAt` (throttled to 1/min).
  - Fastify `preHandler` factory `requireAgentAuth(collections)` that attaches `request.agentContext` and replies 401 otherwise.
- Rewrite `POST /api/identity/init`: creates an `agents` row (+ default `policies` row) and one token; provisioning of email/phone/card stays behind capability flags but now only records *placeholders pending later tasks* — remove the fake `+1 415 555 XXXX` number and fake calendar URL generation. Response shape stays backward compatible where real (`agent_id`, `identity_token`, `tool_endpoints`), but `phone`/`email` are `null` until the real provisioning tasks land, and `calendar_url` is dropped.
- `POST /api/identity/revoke` revokes the presented token; new `POST /api/identity/tokens/rotate` issues a replacement and revokes the old one atomically.
- `GET /api/identity/:agentId/audit-log` reads from Mongo (`auditLogs` — written via task 007's service; until 007 lands, write directly to the collection with the same document shape).
- Delete `identitiesByToken`/`identitiesById`/`auditLogsByAgentId` maps and the module-level accessors (`getAgentIdentityByToken`, `getAgentIdentityById`, `recordIdentityAudit`) — replace call sites in `payments.ts`/`email.ts` with the new auth helper + collection access (they still compile against their in-memory stores for now; only the identity lookup changes).

## Implementation steps
1. Implement `agent-auth.ts` with unit tests (valid, revoked, expired, wrong scheme, unknown token, inactive agent).
2. Rewrite `identity.ts` routes onto Mongo. Keep zod schemas; extend `initIdentitySchema` with optional `owner_email` used to attach the agent to an existing user (else agent is owned by a system "unclaimed" user and claimable later — implement `ownerUserId: null` + claim in task 047's linking flow; keep it simple: allow null owner).
3. Wire `sites.ts`-created legacy keys: `authenticateAgentRequest` must also match legacy `apiKeys` hashes migrated into `identityTokens` (same hash function — already ensured by task 005).
4. Integration tests: init → token authenticates; restart simulation (new app instance, same in-memory Mongo) → token still authenticates. Rotation: old token 401s, new works. Revocation: 401 + audit row.

## Acceptance criteria
- No in-memory identity/token/audit `Map` remains in `identity.ts`.
- Tokens survive process restart (proven by test).
- Plaintext tokens never logged nor stored; only hash + prefix in DB.

## How to test
```bash
npm --workspace @barkan/api run test -- identity agent-auth
# Manual:
curl -s -X POST localhost:4001/api/identity/init -H 'content-type: application/json' \
  -d '{"agent_name":"Maya","tools":["email"]}' | tee /tmp/init.json
TOKEN=$(jq -r .identity_token /tmp/init.json)
pm2 restart dev-barkan-api --update-env && sleep 2
curl -s localhost:4001/api/identity/$(jq -r .agent_id /tmp/init.json)/audit-log -H "authorization: Bearer $TOKEN"
# -> 200 with identity.init audit entry (survived the restart)
```
