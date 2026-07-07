# Barkan MCP Integration

Barkan exposes an MCP Streamable HTTP server at:

```text
POST /mcp
GET /mcp
```

Every request must include an agent identity token:

```text
Authorization: Bearer brk_live_...
```

The server is stateless and is backed by the official `@modelcontextprotocol/sdk`. Tool access is scoped to the authenticated agent identity. Email tools appear only when email is enabled; phone and SMS tools appear only when phone is enabled.

## Tools

- `barkan_whoami`
- `barkan_email_send(to, subject, body, wait_for_approval?)`
- `barkan_email_list_threads(cursor?)`
- `barkan_email_read_thread(thread_id)`
- `barkan_email_reply(thread_id, body, wait_for_approval?)`
- `barkan_phone_call(to, task, context?, recipient_name?, wait_for_approval?)`
- `barkan_phone_get_call(call_id)`
- `barkan_sms_send(to, body, wait_for_approval?)`
- `barkan_sms_conversation(with, cursor?)`
- `barkan_sms_latest_code(from?, since_minutes?)`
- `barkan_approval_status(approval_id)`
- `barkan_audit_recent(limit?)`

`wait_for_approval` defaults to `true`. Barkan waits up to 120 seconds for owner approval; on timeout, the tool returns a structured pending approval result with `approval_id`.

Policy blocks return normal tool results:

```json
{
  "ok": false,
  "code": "policy_blocked",
  "message": "blocked by policy"
}
```

Protocol errors are reserved for invalid input, missing resources, provider failures, and auth failures.

## Resources

- `barkan://identity`
- `barkan://policies`
- `barkan://audit/recent`

## TypeScript Client Example

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-agent", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL("https://api.example.com/mcp"), {
  requestInit: {
    headers: { authorization: `Bearer ${process.env.BARKAN_IDENTITY_TOKEN}` }
  }
});

await client.connect(transport);
const whoami = await client.callTool({ name: "barkan_whoami", arguments: {} });
const email = await client.callTool({
  name: "barkan_email_send",
  arguments: {
    to: "person@example.com",
    subject: "Hello",
    body: "Hi from my agent."
  }
});
```

## OpenClaw Config

```json
{
  "mcpServers": {
    "barkan": {
      "transport": "http",
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${BARKAN_IDENTITY_TOKEN}"
      }
    }
  }
}
```

## Hermes Config

```json
{
  "mcp": {
    "servers": {
      "barkan": {
        "transport": "streamable-http",
        "url": "https://api.example.com/mcp",
        "headers": {
          "Authorization": "Bearer ${BARKAN_IDENTITY_TOKEN}"
        }
      }
    }
  }
}
```

For stdio-only runtimes, use the npm bridge:

```bash
npx -y @barkan/mcp
```

Set `BARKAN_API_URL` and `BARKAN_IDENTITY_TOKEN`, or pair interactively:

```bash
npx -y @barkan/mcp --pair
```

Pairing prints a code and dashboard URL. After owner confirmation, the bridge stores credentials in `~/.barkan/credentials.json`.
