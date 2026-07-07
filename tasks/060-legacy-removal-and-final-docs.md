model: gpt 5.5

# Task 060 — Final sweep: remove legacy routes, reconcile all docs

## Depends on
Everything (the closing task)

## Context
During the rebuild, legacy compatibility was deliberately preserved: `/api/sites*` adapters (010), `/api/site-setups*`, `/api/tools/*` compat routes, `atlasProjects`/`sites`/`apiKeys` collections, deprecated env aliases (003), and docs that describe the old world. Ship the cleanup only now that nothing depends on the old shapes (web migrated in 012, skills/MCP/SDK on v1).

## Objective
One coherent codebase and documentation set with zero legacy surface.

## Spec
- **Route removal**: delete `sites.ts` adapters, `/api/site-setups*`, legacy `/api/tools/email/*`, `/api/tools/phone/call`, `/api/tools/calendar/book` (calendar was demo-ware; if kept as a roadmap item, it returns properly in a future phase — confirm no skill/doc references remain; `/api/tools/payments/*` was already deleted in 031). Verify via access logs on staging for 7 days prior (add a temporary counter metric on legacy routes in 053's registry to confirm zero traffic; document findings).
- **Data cleanup migration**: `2026-XX-drop-legacy-collections.ts` — verifies every `sites`/`atlasProjects`/`apiKeys` row has a migrated counterpart (005's markers), archives collections to a `legacy_archive_<date>` bson dump via backup script, then drops. Refuses when unmigrated rows found.
- **Config**: remove deprecated aliases (`EMAIL_FROM_DOMAIN`, `EMAIL_WEBHOOK_SECRET`, `AIDENTITY_*` fallbacks) — boot now errors on them with pointer to new names.
- **Docs reconciliation** (the AGENTS.md self-update rule, applied fully):
  - `AGENTS.md`: rewrite Architecture / Key Files / route list / build-run to final reality (v1 routes, MCP, packages, infra), remove "legacy sites/site-setups" language.
  - `README.md`: final product description, quickstart, architecture diagram, test matrix (unit / contract / integration / e2e), links to docs site.
  - `docs/` index page; ensure every doc written across tasks is linked and current (email/phone setup, integrations ×3, security, privacy, operations, runbook).
  - `.env.example` final pass — every var, grouped, no dead vars (diff against config schema mechanically: extend `check-env.mjs` with `--example-sync` mode used in CI).
- **Dead-code sweep**: `npx knip` (or `ts-prune`) run; remove unreferenced exports/files; `grep -rn "TODO\|INTERIM\|LEGACY" apps packages` — resolve or ticket each hit (list in PR).
- Bump versions: `@barkan/api`/`@barkan/web` → 1.0.0; tag `v1.0.0` after merge.

## Implementation steps
1. Traffic-counter verification window (coordinate timing; can overlap prior tasks).
2. Route + code removal, test updates (delete legacy contract assertions from 010's adapter tests).
3. Archive-and-drop migration with dry-run.
4. Docs rewrite pass; example-sync CI check.
5. Sweep + version bump.

## Acceptance criteria
- `grep -rni "site-setup\|atlasProject\|publicSiteKey\|/api/sites\|/api/tools/" apps packages docs --exclude-dir=node_modules` → zero hits (tasks/ folder exempt).
- Full test pyramid green: root `npm test`, `e2e:integration`, `npm run e2e`.
- Fresh-clone drill: `git clone` → README quickstart only → working local stack in mock mode (time it; must be < 15 min including installs).
- `AGENTS.md` accurately describes the shipped system (reviewer walks it against the code).

## How to test
```bash
npm test && npm run e2e:integration && npm run e2e
node scripts/check-env.mjs --example-sync
npm --workspace @barkan/api run migrate -- --dry-run   # drop-legacy migration preview
# Fresh clone drill in /tmp per README quickstart.
```
