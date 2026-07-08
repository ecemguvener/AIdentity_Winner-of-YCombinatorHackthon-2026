# Hermes Integration

Barkan supports Hermes through the shared `barkan-identity` AgentSkill and MCP.

Hermes skills follow the AgentSkills format and live in the Hermes skills directory. Install the built variant from this repo:

```bash
node scripts/build-skills.mjs
cp -R hermes-skills/barkan-identity ~/.hermes/skills/barkan-identity
```

## Credentials

Pair a runtime:

```bash
npx -y @barkan/mcp --pair
```

Then configure Hermes to provide:

```bash
BARKAN_API_URL=https://aidentity.space
BARKAN_IDENTITY_TOKEN=brk_live_...
```

## Hosted MCP

Configure Hermes with the hosted Streamable HTTP server:

```json
{
  "mcpServers": {
    "barkan": {
      "transport": "http",
      "url": "https://aidentity.space/mcp",
      "headers": {
        "Authorization": "Bearer ${BARKAN_IDENTITY_TOKEN}"
      }
    }
  }
}
```

## Stdio MCP

For local stdio MCP:

```json
{
  "mcpServers": {
    "barkan": {
      "command": "npx",
      "args": ["-y", "@barkan/mcp"],
      "env": {
        "BARKAN_API_URL": "https://aidentity.space",
        "BARKAN_IDENTITY_TOKEN": "brk_live_..."
      }
    }
  }
}
```

## Messaging Gateway Guidance

Hermes often runs behind Telegram, Discord, or another chat gateway. Owner approval can take longer than a chat reply window. When Barkan returns `approval_required`, tell the user the action is waiting in Barkan and will execute automatically when approved. Do not poll or retry the original action.

## Verification Script

Ask Hermes:

```text
Introduce yourself by email to me using your Barkan identity.
```

Expected:

1. Hermes uses the `barkan` MCP server or REST fallback.
2. Barkan creates an approval if policy requires it.
3. Hermes reports the pending approval id and does not poll or retry.
4. After approval, Barkan sends automatically. Hermes only reports the confirmed message id if the user later asks for status.

Then ask:

```text
Fetch the latest SMS verification code from your Barkan phone number.
```

Expected: Hermes calls `barkan_sms_latest_code`, returns the actual code if present, or reports that no recent code was found.

## Skills Hub

The canonical source is `skills/barkan-identity`. The repo includes `skill.json` listing metadata (`name`, `description`, `homepage`, `tags`) for Skills Hub style listings. If the target registry does not require a manifest, submit the folder containing `SKILL.md` and `references/`.
