model: gpt 5.5

# Task 047 — `@barkan/mcp` stdio package + agent linking flow

## Depends on
046

## Context
Some runtimes prefer spawning a local stdio MCP server (`command` + `args` config). Ship a thin npm package that bridges stdio ↔ our hosted Streamable HTTP endpoint. Also: linking an existing dashboard-created agent to a runtime currently means manually copying the token — add a proper device-code-style pairing so the runtime can fetch its token securely.

## Objective
`npx @barkan/mcp` works in any stdio MCP config; pairing flow links a runtime to an agent in one command.

## Spec
- New workspace `packages/mcp` (`@barkan/mcp`, publishable, bin `barkan-mcp`):
  - Reads `BARKAN_API_URL` (default `https://api.barkan.dev`… use `PUBLIC_API_URL` semantics; overridable) + `BARKAN_IDENTITY_TOKEN`.
  - stdio transport ↔ HTTP client to `/mcp` forwarding JSON-RPC both ways (use SDK `Client` with StreamableHTTP transport + `Server` with stdio transport back-to-back proxy; forward tool lists/calls transparently).
  - `--pair` mode: `npx @barkan/mcp --pair` → calls `POST /api/v1/pairing/start` → prints code + URL `PUBLIC_APP_URL/pair?code=XXXX-XXXX` → polls `POST /api/v1/pairing/poll {code}` (5s interval, 10min timeout) → on owner confirmation receives `{ identityToken, agentId, apiUrl }` → writes `~/.barkan/credentials.json` (0600) and prints the env lines. Subsequent runs read that file when env vars absent.
- API additions (this task):
  - `pairingRequests` collection `{ code (8 chars, unique, TTL 10min via sweeper), status: pending|claimed|confirmed|expired, agentId?, tokenIssuedAt? }`.
  - `POST /api/v1/pairing/start` (unauthenticated, rate-limited 5/hr/IP) → `{ code }`.
  - `POST /api/v1/pairing/poll { code }` → `{ status }` or `{ status: "confirmed", identityToken, agentId }` — token minted at confirm time (task 006 issuance), returned exactly once, then scrubbed from the doc.
  - Owner confirm: `POST /api/v1/pairing/:code/confirm { agentId }` (session auth) + web page `/pair` — enter/prefill code, pick agent from dropdown, confirm.
- Web `/pair` page + agent detail "Connect" tab update: show both remote MCP config and stdio config snippets with real values (from task 012's placeholders):
  ```json
  { "mcpServers": { "barkan": { "command": "npx", "args": ["-y", "@barkan/mcp"],
      "env": { "BARKAN_API_URL": "...", "BARKAN_IDENTITY_TOKEN": "..." } } } }
  ```

## Implementation steps
1. Package scaffold (tsup or plain tsc build, `bin` entry, README) + proxy implementation + integration test spawning the bin against a local API (vitest + child_process, mock provider mode).
2. Pairing collection/routes/sweeper + tests (expiry, single-use token reveal, wrong-code 404, rate limit).
3. `/pair` page + connect-tab snippets + component tests.
4. Root workspace already includes `packages/*` — verify build/test pipelines pick the new package (`npm run build`, `npm test` at root).

## Acceptance criteria
- `BARKAN_IDENTITY_TOKEN=... npx ./packages/mcp` (local link) exposes identical tools to direct HTTP (diff `tools/list` output — test asserts equality).
- Pairing drill: `--pair` on a laptop + confirm in dashboard → credentials file written, `barkan_whoami` works, token visible in agent's token list named "Paired runtime".
- Poll after confirm returns the token exactly once (second poll → `already_claimed` error).

## How to test
```bash
npm --workspace @barkan/mcp run build && npm --workspace @barkan/mcp run test
node packages/mcp/dist/cli.js --pair --api-url http://localhost:4001   # follow printed URL, confirm in UI
npx @modelcontextprotocol/inspector --transport stdio --command "node packages/mcp/dist/cli.js"
```
