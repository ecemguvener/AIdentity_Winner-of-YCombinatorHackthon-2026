# OpenClaw Integration

Barkan ships an OpenClaw AgentSkill at `openclaw-skills/barkan-identity`. Build it from the canonical shared source before publishing:

```bash
node scripts/build-skills.mjs
```

## Publish To ClawHub

From the repo root:

```bash
node scripts/validate-skills.mjs
cd openclaw-skills/barkan-identity
clawhub publish
```

Before publishing:

- Verify `SKILL.md` frontmatter has `name`, `description`, `homepage`, and `metadata.openclaw`.
- Pin the published version in release notes.
- Run one local install drill before the public publish.

## Install

Local directory install:

```bash
openclaw skills install ./openclaw-skills/barkan-identity
```

ClawHub install:

```bash
openclaw skills install barkan-identity
```

Users can also install from the ClawHub UI by searching for `barkan-identity`.

## Skill Environment

Inject Barkan credentials through OpenClaw skill config:

```json
{
  "skills": {
    "entries": {
      "barkan-identity": {
        "version": "0.1.0",
        "env": {
          "BARKAN_API_URL": "https://aidentity.space",
          "BARKAN_IDENTITY_TOKEN": "brk_live_..."
        }
      }
    }
  }
}
```

Create credentials with dashboard token copy or pairing:

```bash
npx -y @barkan/mcp --pair
```

## MCP Alternative

If OpenClaw has MCP enabled, configure Barkan directly and let the skill prefer MCP tools:

```bash
openclaw mcp add barkan \
  --transport streamable-http \
  --url https://aidentity.space/mcp \
  --header "Authorization=Bearer ${BARKAN_IDENTITY_TOKEN}"

openclaw config set env.vars.BARKAN_API_URL https://aidentity.space
openclaw config set env.vars.BARKAN_IDENTITY_TOKEN "${BARKAN_IDENTITY_TOKEN}"
openclaw mcp reload
openclaw mcp probe barkan
```

If you edit `openclaw.json` directly, use OpenClaw's native `mcp.servers` and `env.vars` shape:

```json
{
  "mcp": {
    "servers": {
      "barkan": {
        "enabled": true,
        "transport": "streamable-http",
        "url": "https://aidentity.space/mcp",
        "headers": {
          "Authorization": "Bearer ${BARKAN_IDENTITY_TOKEN}"
        }
      }
    }
  },
  "env": {
    "vars": {
      "BARKAN_API_URL": "https://aidentity.space",
      "BARKAN_IDENTITY_TOKEN": "brk_live_..."
    }
  }
}
```

For stdio-only runtimes:

```json
{
  "mcp": {
    "servers": {
      "barkan": {
        "enabled": true,
        "command": "npx",
        "args": ["-y", "@barkan/mcp"],
        "env": {
          "BARKAN_API_URL": "https://aidentity.space",
          "BARKAN_IDENTITY_TOKEN": "brk_live_..."
        }
      }
    }
  }
}
```

## Verification Script

Ask OpenClaw:

```text
What is your Barkan identity?
```

Expected: the agent uses `barkan_whoami` or REST fallback and summarizes name, email, phone, capabilities, approval mode, and current policy limits.

Then ask:

```text
Send an email from your Barkan address to me introducing yourself.
```

Expected:

1. OpenClaw requests email send through Barkan.
2. If policy requires approval, it says it is waiting in the Barkan dashboard.
3. Owner approves in Barkan.
4. OpenClaw reports the confirmed send result.
5. Barkan audit contains the email action.

The canonical skill source is shared with the Hermes variant; see [Hermes integration](./hermes.md).
