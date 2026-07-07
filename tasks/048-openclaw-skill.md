model: fable 5

# Task 048 — OpenClaw skill: rewrite for the real product + ClawHub publish

## Depends on
046, 047

## Context
`openclaw-skills/identity-layer/SKILL.md` describes the fake hackathon API (simulated calls, `IDENTITY_LAYER_API_URL`, self-approval booleans) and lacks the required AgentSkills frontmatter. Research findings on OpenClaw skills: SKILL.md needs YAML frontmatter (`name`, `description` minimum); env/API keys inject via `skills.entries.<name>.env` / `.apiKey` config; skills follow the AgentSkills spec; distribution via ClawHub; OpenClaw also supports MCP via `mcpServers` — the skill should teach the agent to *prefer the MCP tools when configured* and fall back to REST via curl.

## Objective
A production-quality `barkan-identity` OpenClaw skill teaching correct, safe usage of every capability, plus publish + install docs.

## Spec
- Rename dir → `openclaw-skills/barkan-identity/`. `SKILL.md` frontmatter:
  ```yaml
  ---
  name: barkan-identity
  description: Give this agent a real-world identity (email address, phone number) via Barkan. Use for sending/receiving email, making phone calls, and SMS (including fetching 2FA codes).
  homepage: https://barkan.dev
  metadata: { openclaw: { requiredEnv: ["BARKAN_API_URL", "BARKAN_IDENTITY_TOKEN"], emoji: "🪪" } }
  ---
  ```
- Body sections (rewrite fully — no legacy endpoints):
  1. **When to use** — decision table mapping user intents ("email X", "call the restaurant", "get the verification code") to tools. Purchases/payments: not available — the skill must say the card capability is coming soon and never improvise payment behavior.
  2. **Setup** — check env; if missing, instruct running `npx @barkan/mcp --pair` (047) or dashboard token copy; never ask the user for provider credentials.
  3. **Preferred path: MCP** — if `barkan` MCP server configured, use `barkan_*` tools; tool table mirroring 046.
  4. **Fallback path: REST** — curl templates for the frozen v1 contracts (email send/threads, phone call/status, SMS send/latest-code), bearer header, error envelope explanation.
  5. **Approvals protocol** — `wait_for_approval` semantics; on `approval_required`/pending: tell the user "waiting for owner approval in the Barkan dashboard", poll status, never retry-spam (max 1 poll/10s), never claim an action happened before status confirms.
  6. **Safety rules** — never fabricate transcripts/receipts; report `policy_blocked` reasons verbatim; never collect or use payment card details (capability doesn't exist yet).
  7. **Recipes** — 2FA signup flow (create account with agent email → `barkan_sms_latest_code` → finish), reservation call, email follow-up loop.
- `client.js` deleted (dead), replaced by nothing — the skill is instructions-only (MCP/curl do the work).
- Validation: add `scripts/validate-skills.mjs` (frontmatter parse per AgentSkills spec, required keys, no legacy endpoint strings like `/api/tools/phone/call` legacy shapes, no `IDENTITY_LAYER_` strings) wired into root `npm test`.
- Publish: `docs/integrations/openclaw.md` — ClawHub publish steps (`clawhub publish` per current docs), version pinning, install instructions for users (`openclaw skills install barkan-identity` or ClawHub UI), `skills.entries.barkan-identity.env` config example injecting both env vars, plus the `mcpServers` alternative. Include an end-to-end verification conversation script ("Ask your OpenClaw: 'What is your Barkan identity?' → expect whoami summary").

## Implementation steps
1. Rewrite SKILL.md per spec (keep under ~500 lines; link docs for depth — skill bodies compete for prompt budget, per OpenClaw docs the description drives gating so make it precise).
2. Validator script + root wiring + test fixtures (bad frontmatter fails).
3. Docs page with tested config snippets.
4. Live drill against a real OpenClaw install (document in PR): pair, ask the agent to send an email to your inbox, approve in dashboard, confirm receipt + audit rows.

## Acceptance criteria
- `node scripts/validate-skills.mjs` passes; grep of skill for legacy terms (`identity_live_`, `IDENTITY_LAYER`, `simulated`, `calendar_book`) → zero.
- Live drill transcript in PR: OpenClaw completes email + SMS-code recipe through Barkan with approvals.
- Skill works via both MCP and REST fallback paths (drill once each).

## How to test
```bash
node scripts/validate-skills.mjs
# OpenClaw live drill (operator):
#   openclaw skills install ./openclaw-skills/barkan-identity  (local dir install)
#   set skills.entries.barkan-identity.env in openclaw config
#   chat: "Send an email from your Barkan address to <you>@gmail.com introducing yourself"
#   approve in Barkan dashboard bell -> verify inbox + /agents/<id> audit tab
```
