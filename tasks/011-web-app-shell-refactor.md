model: gpt 5.5

# Task 011 — Web app shell refactor: split the 160KB App.tsx into routed modules

## Depends on
010 (API shapes referenced), but can start in parallel after 008

## Context
`apps/web/src/App.tsx` is a single ~160,000-character file containing auth screens, dashboard, identity onboarding, settings, chat, and panels. Upcoming tasks add inbox, call history, approvals, and billing UIs — impossible to do sanely in one file. `apps/web/src/api.ts` is a hand-rolled client.

## Objective
Route-based module structure with zero visual/behavioral regressions, and a typed API client layer ready for the v1 endpoints.

## Spec
```
apps/web/src/
  main.tsx                keeps entry
  app/AppShell.tsx        layout: sidebar nav, topbar, auth gate, toasts
  app/router.tsx          lightweight router (react-router-dom v7; add dependency)
  pages/AuthPage.tsx      login/signup (moved, not rewritten)
  pages/AgentsListPage.tsx
  pages/AgentDetailPage.tsx   (tabs: Overview | Email | Phone | Audit — panels arrive in later tasks; no Card tab: card capability is "Coming soon", shown only as a disabled teaser on the Overview tab)
  pages/ApprovalsPage.tsx     (placeholder for task 014)
  pages/SettingsPage.tsx
  pages/ChatPage.tsx          (dashboard chat, moved)
  api/client.ts           fetch wrapper: credentials include, JSON, error envelope from task 008 ({error:{code,...}}), typed helpers
  api/agents.ts           v1 agents endpoints (task 010)
  api/types.ts            shared response types
  components/             existing shadcn-style components stay
```
- Move code mechanically; do not redesign styling in this task. Keep `index.css` as is.
- Routes: `/` → agents list, `/agents/:agentId`, `/approvals`, `/settings`, `/chat`. Unknown → redirect `/`.
- The old sites-based screens keep working during the split by pointing at `api/agents.ts` mapped onto legacy responses where v1 data isn't wired yet — but prefer wiring v1 directly since task 010 is done.
- `App.test.tsx` split into per-page smoke tests (render without crash, auth gate redirects).

## Implementation steps
1. Add `react-router-dom`; build shell + router; migrate sections file by file, committing per page.
2. Build the typed client with a single `requestJson<T>` that throws a typed `ApiClientError { code, message, requestId }`.
3. Verify every user flow manually: signup, login, logout, create identity (legacy flow still ok until task 012), open detail, settings save, chat message.
4. Delete dead code from the old `App.tsx` once all pages moved; `App.tsx` becomes a re-export of `AppShell` or is removed with `main.tsx` updated.

## Acceptance criteria
- No single source file over 800 lines in `apps/web/src` (except `index.css`).
- `npm --workspace @barkan/web run build` clean; `run test` green; type-check green.
- Deep-linking works (`/agents/:id` refresh loads directly).

## How to test
```bash
npm --workspace @barkan/web run test
npm --workspace @barkan/web run build
pm2 restart dev-barkan-web --update-env
# Manual pass at http://localhost:4888 (or http://100.81.152.74:4888):
# signup -> create agent -> agent detail tabs render -> settings -> chat -> logout -> login
```
