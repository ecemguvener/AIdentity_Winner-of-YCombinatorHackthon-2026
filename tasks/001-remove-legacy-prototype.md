model: gpt 5.5

# Task 001 — Remove the legacy hackathon prototype from the repo root

## Depends on
Nothing. First task.

## Context
The repo root still contains a dead pre-hackathon Express prototype that confuses every tool and agent working on the codebase. The real product is the npm workspace under `apps/api` (Fastify + MongoDB) and `apps/web` (React + Vite). Dead artifacts at root:

- `app.js`, `index.html`, `styles.css` — old static site + Express app
- `src/` — old prototype (`src/providers/mockProvider.js`, `src/providers/stripeProvider.js`, `src/routes/`, `src/db/`, `src/engine/`, `src/store/`, `src/agent/`, `src/services/`, `src/util/`, `src/toolManifest.js`, `src/index.js`)
- `data/` — old JSON storage
- `public/` — old widget assets
- `scripts/demo.js`, `scripts/example-topup.js` — scripts for the old prototype
- `api.log`, `dev.log` — stray empty logs

## Objective
A clean monorepo: only `apps/*`, `packages/*` (empty for now), `scripts/` (only scripts referenced by `package.json` / `ecosystem.config.cjs`), `openclaw-skills/`, docs, and config remain.

## Implementation steps
1. For each artifact listed above, run a global search (`grep -r "src/providers" --include="*.{ts,js,json,sh,cjs}"` etc.) to confirm nothing under `apps/`, `scripts/dev.sh`, `scripts/deploy-aidentity-web.sh`, `scripts/prepare-aidentity-web-dist.sh`, `scripts/restart-aidentity-dev.sh`, `scripts/start-dev-apps.sh`, or `ecosystem.config.cjs` imports or executes it.
2. `git rm` the confirmed-dead files/folders: `app.js`, `index.html`, `styles.css`, `src/`, `data/`, `public/`, `scripts/demo.js`, `scripts/example-topup.js`, `api.log`, `dev.log`.
3. Add `*.log` to `.gitignore` if not already covered.
4. Update `README.md` "Project Structure" section to reflect the cleaned tree.
5. Do NOT touch `.env`, `_bmad/`, `.agents/`, `docs/`, `openclaw-skills/`.

## Acceptance criteria
- Repo root contains no Express prototype, no `data/`, no `public/` widget assets.
- `npm install && npm run build && npm test` all pass from the repo root.
- `npm run dev` still boots both apps (check `scripts/dev.sh` still references only existing paths).
- `git log` shows one commit with only deletions + the README/.gitignore edits.

## How to test
```bash
npm install
npm run build
npm test
bash scripts/dev.sh &   # or: pm2 restart dev-barkan-api dev-barkan-web --update-env
curl -s http://localhost:4001/api/health   # -> {"ok":true}
curl -s -o /dev/null -w "%{http_code}" http://localhost:4888   # -> 200
grep -rn "styles.css\|toolManifest\|mockProvider" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.sh" --include="*.cjs" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=tasks
# expect: no matches
```
