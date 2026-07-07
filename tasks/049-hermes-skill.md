model: gpt 5.5

# Task 049 — Hermes agent integration: skill + MCP config

## Depends on
046, 047, 048

## Context
Hermes (Nous Research) supports the open AgentSkills standard (agentskills.io — same SKILL.md format OpenClaw follows) and native MCP servers. Integration = the barkan-identity skill adapted for Hermes conventions + documented MCP wiring. Most of the skill body from task 048 is runtime-agnostic — share it, don't fork it.

## Objective
First-class Hermes support: installable skill, MCP config, verified live drill.

## Spec
- Restructure skills to share content:
  ```
  skills/barkan-identity/SKILL.md      # canonical, runtime-agnostic (moved from openclaw-skills/)
  skills/barkan-identity/references/   # recipes split out (2fa.md, calls.md, email.md) per AgentSkills progressive-disclosure conventions
  ```
  `openclaw-skills/` becomes a symlink-free copy produced by `scripts/build-skills.mjs` (adds any OpenClaw-specific frontmatter like `metadata.openclaw`), and a `hermes/` variant with Hermes-appropriate frontmatter. Keep runtime deltas in tiny header templates, body identical — the build script composes them. Update task 048's validator to run on all built outputs.
- Runtime-specific bits for Hermes:
  - Env: Hermes skills read env from its config; document `BARKAN_API_URL`/`BARKAN_IDENTITY_TOKEN` setup + `--pair` flow.
  - MCP: `docs/integrations/hermes.md` — Hermes MCP config block pointing at hosted `/mcp` (per Hermes "Use MCP with Hermes" guide conventions: server name `barkan`, HTTP transport, auth header), plus stdio alternative via `@barkan/mcp`.
  - Messaging-gateway note: Hermes lives in Telegram/Discord/etc. — approval waits may exceed chat patience; recommend `wait_for_approval: false` + status polling in the Hermes variant guidance.
- Publish prep: metadata for agentskills.io Skills Hub listing (name, description, tags) in `skills/barkan-identity/skill.json` if the spec requires a manifest — follow current agentskills.io submission docs; otherwise document the submission steps in the docs page.

## Implementation steps
1. Restructure + build script + validator update (both outputs validated).
2. Hermes docs page with config snippets.
3. Live drill with a local Hermes install (`pipx install hermes-agent` or per current docs): register MCP server, ask Hermes to send an email + fetch an SMS code through Barkan; capture transcript for PR.
4. Root `npm test` runs skill build + validation.

## Acceptance criteria
- One canonical skill source; built OpenClaw + Hermes variants differ only in frontmatter/header (assert with a diff test).
- Hermes live drill completes email + `latest-code` recipes with approvals; transcript in PR.
- Docs pages for both runtimes cross-link the pairing flow and MCP endpoint.

## How to test
```bash
node scripts/build-skills.mjs && node scripts/validate-skills.mjs
diff <(tail -n +10 openclaw-skills/barkan-identity/SKILL.md) <(tail -n +10 hermes-skills/barkan-identity/SKILL.md)  # body identical
# Hermes drill: add MCP server per docs/integrations/hermes.md, then in Hermes chat:
#   "Introduce yourself by email to <you>@gmail.com using your Barkan identity"
```
