model: gpt 5.5

# Task 002 — Rename workspaces and processes from `aidentity` to `barkan`

## Depends on
001

## Context
The product is Barkan, but the workspace still uses the old codename: root `package.json` is `aidentity-web`, workspaces are `@aidentity/api` and `@aidentity/web`, PM2 apps are `dev-aidentity-api`/`dev-aidentity-web`/`prod-aidentity-api`, env vars are `AIDENTITY_*`, scripts are `deploy-aidentity-web.sh` etc. `AGENTS.md` already documents the target names (`@barkan/api`, `@barkan/web`, `dev-barkan-api`, `dev-barkan-web`) — reality must catch up.

## Objective
Consistent `barkan` naming across packages, PM2 process names, scripts, env var prefixes, cookie name, and Mongo database name — with zero behavior change.

## Implementation steps
1. Root `package.json`: name `barkan`, rewrite scripts (`seed:demo`, `pm2:start-prod-api`, `deploy:barkan-web`) to reference `@barkan/*` and renamed shell scripts.
2. `apps/api/package.json` → `@barkan/api`; `apps/web/package.json` → `@barkan/web`. Update every `npm --workspace` reference in scripts, `ecosystem.config.cjs`, `scripts/*.sh`, `README.md`, `AGENTS.md`.
3. `ecosystem.config.cjs`: process names `dev-barkan-api`, `dev-barkan-web`, `prod-barkan-api`; env var prefix `BARKAN_*` (keep reading old `AIDENTITY_*` as fallback: `process.env.BARKAN_PUBLIC_HOST || process.env.AIDENTITY_PUBLIC_HOST || ...`).
4. Rename `scripts/deploy-aidentity-web.sh` → `scripts/deploy-barkan-web.sh`, `scripts/prepare-aidentity-web-dist.sh` → `scripts/prepare-barkan-web-dist.sh`, `scripts/restart-aidentity-dev.sh` → `scripts/restart-barkan-dev.sh`; fix internal references (the web build script in `apps/web/package.json` calls `prepare-aidentity-web-dist.sh`).
5. `apps/api/src/config.ts`: default `SESSION_COOKIE_NAME` → `barkan_session`, default `MONGODB_URI` database → `barkan` (keep the `-prod` suffix logic). The config must keep accepting an explicitly set legacy cookie name/URI from `.env` — only defaults change.
6. `.env.example`: update defaults (`MONGODB_URI=mongodb://127.0.0.1:27017/barkan`, `SESSION_COOKIE_NAME=barkan_session`).
7. Old PM2 processes: document in the task PR description that the operator must run `pm2 delete dev-aidentity-api dev-aidentity-web prod-aidentity-api` then `pm2 start ecosystem.config.cjs --only dev-barkan-api,dev-barkan-web && pm2 save`.
8. Update `AGENTS.md` and `README.md` anywhere the old names linger.

## Acceptance criteria
- `grep -rn "aidentity" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=tasks .` returns only: `.env` (do not edit), historical mentions in `_bmad*/`, and the explicit legacy fallbacks from steps 3/5.
- Build, tests, and dev servers work under the new names.

## How to test
```bash
npm install
npm run build && npm test
npm --workspace @barkan/api run test
npm --workspace @barkan/web run test
pm2 delete dev-aidentity-api dev-aidentity-web 2>/dev/null; pm2 start ecosystem.config.cjs --only dev-barkan-api,dev-barkan-web && pm2 save
curl -s http://localhost:4001/api/health
# Login flow still works with the new cookie name:
curl -si -X POST http://localhost:4001/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"demo@aidentity.test","password":"demo-password"}' | grep -i set-cookie
# -> barkan_session=...
```
