model: fable 5

# Task 005 — Migrate legacy `sites`/`atlasProjects` to `agents`

## Depends on
004

## Context
Agent identities are stored in legacy `sites` (name, domain, publicSiteKey) and `site-setups`/`atlasProjects` shaped collections (see `apps/api/src/sites.ts`, `db.ts`). The product now has a real `agents` collection (task 004). The web app talks to `/api/sites*` routes — those keep working during migration; they will be replaced in task 010 and removed in 060.

## Objective
One-shot migration script + dual-read compatibility so existing accounts keep their identities, while all new code reads/writes `agents` only.

## Spec
- New script `apps/api/src/migrations/2026-07-sites-to-agents.ts`, runnable via `npm --workspace @barkan/api run migrate`.
- Mapping per `sites` row: `agents { ownerUserId: site.ownerUserId, name: site.name, slug: slugify(site.name) (dedupe with -2, -3 …), status: "active", runtime: "openclaw", capabilities: {email:false, phone:false}, approvalMode: "always", legacySiteId: site._id }`.
- `atlasProjects` rows without a `siteId` (setups never completed) → `agents` with `status: "provisioning"`, `legacyProjectId`.
- `apiKeys` rows: copy into `identityTokens { agentId (via legacySiteId/ProjectId), tokenHash: keyHash, prefix, name, status: "active" }`. Legacy keys were SHA-hashed via `security.ts#hashApiKey` — reuse the exact same hash function for lookups so existing plaintext keys keep authenticating.
- Migration is idempotent: skips rows whose `legacySiteId`/`legacyProjectId` already exist in `agents`; safe to re-run.
- Writes a `migrations` collection record `{name, ranAt, stats}` and logs a summary (`migrated X sites, Y setups, Z keys, skipped N`).

## Implementation steps
1. Implement the script with a `--dry-run` flag (prints stats, writes nothing).
2. Add `"migrate": "tsx src/migrations/run.ts"` plus a tiny runner that executes all files in `src/migrations` in filename order, recording completion in the `migrations` collection.
3. Add `slugify` to a shared `apps/api/src/lib/slug.ts` (move the copy in `identity.ts` there too).
4. Integration test with `mongodb-memory-server`: seed 2 sites + 1 orphan setup + 3 apiKeys → run migration twice → assert 3 agents, 3 tokens, second run migrates 0.
5. Do NOT delete legacy collections or routes yet.

## Acceptance criteria
- Dry-run prints accurate counts without writing.
- Real run is idempotent, preserves ownership, and legacy API keys still authenticate through the new `identityTokens` lookup (verified in test by hashing a known plaintext key).

## How to test
```bash
npm --workspace @barkan/api run test -- migrations
# Against local dev DB (after seeding demo data):
npm run seed:demo
npm --workspace @barkan/api run migrate -- --dry-run
npm --workspace @barkan/api run migrate
mongosh barkan --eval 'db.agents.find({}, {name:1, slug:1, status:1}).toArray()'
npm --workspace @barkan/api run migrate   # second run: "migrated 0"
```
