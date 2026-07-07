# @barkan/mcp

Stdio MCP bridge for Barkan agent identities.

```bash
BARKAN_API_URL=https://api.barkan.dev \
BARKAN_IDENTITY_TOKEN=brk_live_... \
npx -y @barkan/mcp
```

Pair a runtime to an existing dashboard agent:

```bash
npx -y @barkan/mcp --pair
```

Pairing stores credentials in `~/.barkan/credentials.json` with `0600` permissions. Environment variables override that file.
