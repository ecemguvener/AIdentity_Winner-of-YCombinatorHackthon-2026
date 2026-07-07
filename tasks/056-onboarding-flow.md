model: gpt 5.5

# Task 056 — First-run onboarding: signup → working agent in 5 minutes

## Depends on
012, 014, 020, 029, 047

## Context
All the pieces exist; the seams show. A new user must reach the magic moment — *their agent doing something real* — without reading docs. Time-to-first-action is the growth metric.

## Objective
Guided first-run experience with an activation checklist and a built-in "first action" that exercises the loop.

## Spec
- **Post-signup flow**: after first login with zero agents → full-screen guided version of the creation wizard (012) with recommended defaults (email on; phone presented as locked-by-plan for free users with upgrade hint — entitlements 043 drives this; card tile stays "Coming soon").
- **Activation checklist** (dashboard home card until dismissed/complete, state on `users.onboarding`):
  1. Create your agent ✓ (auto after wizard)
  2. Connect a runtime — tabs: OpenClaw / Hermes / MCP / SDK with copy-paste snippets + `--pair` shortcut (047); auto-checks when the agent token is first used (poll `identityTokens.lastUsedAt`).
  3. Send your first email — "Ask your agent to email you" OR one-click "Send test email to my address" (owner-initiated, actor=owner) — checks on first outbound `sent`.
  4. Approve it — checks on first approval decision (seed step 3's send with `requireApproval: always` default so this fires).
  5. (paid) Add phone — deep-link to the capability enable flow.
- **Empty states everywhere**: audit each page (agents, approvals, email, phone, billing) for helpful zero-data guidance — one sweep, consistent voice, each with the single next action.
- **Demo mode banner**: when all providers are mock (ops status 044), show a dismissible banner "Sandbox mode — actions are simulated. See setup guide" linking operator docs — prevents the original sin of mistaking mock for real.
- Instrument: `onboardingEvents` appended per step completion (timestamped) — a `GET /api/v1/ops/activation` summary (counts per step, median time-to-first-action) for the founders.

## Implementation steps
1. Onboarding state on user doc + checklist card + step auto-detection (SSE/poll where natural).
2. Wizard first-run variant + snippets tabs (reuse 047's connect components).
3. Empty-state sweep (list every page in PR, before/after).
4. Activation metrics endpoint + tests; component tests for checklist transitions.

## Acceptance criteria
- Fresh-account drill (mock mode): signup → checklist steps 1-4 complete in < 5 min without leaving the app except the runtime snippet paste; timer proof via `ops/activation`.
- Checklist state survives refresh/re-login; dismiss works; reappears never.
- No page shows a bare empty table to a new user.

## How to test
```bash
npm --workspace @barkan/web run test -- onboarding
# Manual: fresh signup in incognito, run the drill, then:
curl -s localhost:4001/api/v1/ops/activation -H "cookie: $ADMIN_COOKIE" | jq .
```
