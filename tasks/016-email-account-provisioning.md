model: gpt 5.5

# Task 016 — Email account provisioning per agent

## Depends on
010, 015

## Context
`identity.ts` used to mint `slug-rand@domain` strings in memory via `provisionEmailIdentity` (in `email.ts`); nothing persisted, nothing owned. Task 004 created `emailAccounts`; task 010 created the provisioner registry.

## Objective
Real email-capability provisioner: allocate a unique persistent address per agent, lifecycle-managed.

## Spec
- Replace the stub email provisioner (task 010) in the registry:
  - `provision(agent)`: allocate `slug[-suffix]@EMAIL_AGENT_DOMAIN` — try bare slug, then `-2`, `-3`… (unique index is the arbiter; catch duplicate-key and retry). Insert `emailAccounts { agentId, address, displayName: agent.name, status: "active" }`. State: `{ state: "active", detail: address }`. Idempotent: existing active account → return it.
  - `deprovision(agent)`: set `status: "paused"`, keep the row + messages (audit trail; address is not reused: uniqueness stays).
  - `status(agent)`: `not_provisioned` | `active` | `paused` (+ address).
- In live mode also assert domain verified (task 015 status) — if not, provisioning fails with actionable `provider_error` naming the DNS records.
- Address rules: lowercase, `[a-z0-9-]`, max 30 chars local part, reserved prefixes blocked (`admin`, `postmaster`, `abuse`, `no-reply`, `support`, `billing`).
- Agent identity init (`/api/identity/init` with `tools:["email"]`) and dashboard capability toggle both flow through this provisioner (they already dispatch to the registry — verify).
- Serializer from task 010 now returns the real `emailAddress` in agent contact points.

## Implementation steps
1. Implement provisioner + address allocator with unit tests (collision retry, reserved names, length clamp, unicode names → slug fallback `agent`).
2. Wire audit entries `email.provisioned` / `email.paused`.
3. Integration test: two agents named "Maya" under two users → `maya@…` and `maya-2@…`; re-provision idempotent; deprovision pauses.

## Acceptance criteria
- Creating an agent with email capability yields a persistent unique address visible in the dashboard and via `GET /api/v1/agents/:id`.
- Restart-safe (addresses come from Mongo, proven by tests).
- Reserved local parts are unobtainable even via crafted agent names ("Support" → `support-2`? No — reserved list blocks the bare word; allocator must skip to suffixed variant only for collisions, and use `agent-support`-style prefix or first suffix for reserved hits; pick one behavior, test it).

## How to test
```bash
npm --workspace @barkan/api run test -- email-provision
# Manual:
curl -s -X POST localhost:4001/api/v1/agents -H "cookie: $COOKIE" -H 'content-type: application/json' \
  -d '{"name":"Maya","capabilities":{"email":true}}' | jq '.agent'
curl -s localhost:4001/api/v1/agents/<id> -H "cookie: $COOKIE" | jq '.provisioning.email'
# -> { "state": "active", "detail": "maya@agents.<domain>" }
```
