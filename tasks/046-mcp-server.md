model: fable 5

# Task 046 — MCP server: Barkan capabilities as Model Context Protocol tools

## Depends on
021, 030 (frozen contracts), 013

## Context
Research decision: MCP is the primary integration surface — OpenClaw ships stdio + HTTP MCP transport support (`mcpServers` config), and Hermes has native MCP support. One hosted MCP endpoint means any MCP-capable agent runtime can use Barkan without custom code. Use the official `@modelcontextprotocol/sdk` (Streamable HTTP transport) mounted inside the existing Fastify API — one deployment, shared auth.

## Objective
`POST/GET /mcp` Streamable HTTP endpoint exposing every agent capability as typed MCP tools, authenticated with the identity token.

## Spec
- Dependency: `@modelcontextprotocol/sdk`. New `apps/api/src/mcp/` module:
  - `server.ts` — builds an `McpServer` (name `barkan`, version from package.json) per authenticated session; register with Fastify at `/mcp` (bridge Fastify req/res to the SDK's Streamable HTTP transport; stateless mode — no session persistence needed since our tools are atomic).
  - Auth: `Authorization: Bearer <identity token>` on every HTTP request → task 006 `authenticateAgentRequest`; 401 JSON-RPC error otherwise. The resolved agent scopes every tool call.
- Tools (names stable — skills depend on them; input schemas via zod → JSON Schema):
  ```
  barkan_whoami            () -> agent profile, contact points, capability + policy summary
  barkan_email_send        (to, subject, body, wait_for_approval?) 
  barkan_email_list_threads(cursor?)
  barkan_email_read_thread (thread_id)
  barkan_email_reply       (thread_id, body, wait_for_approval?)
  barkan_phone_call        (to, task, context?, recipient_name?, wait_for_approval?)
  barkan_phone_get_call    (call_id) -> status/summary/transcript
  barkan_sms_send          (to, body, wait_for_approval?)
  barkan_sms_conversation  (with, cursor?)
  barkan_sms_latest_code   (from?, since_minutes?)
  barkan_approval_status   (approval_id)
  barkan_audit_recent      (limit?)
  ```
  - Tools call the **service layer directly** (email-service, phone-service, sms-service) — not HTTP-to-self. Same policy/approval/audit paths as REST (verify by audit entries).
  - `wait_for_approval` (default true, capped 120s) maps to the task-013 wait contract; on timeout return a structured "pending" result with `approval_id` and instructions to poll `barkan_approval_status` — LLM-friendly text + `structuredContent`.
  - Errors → MCP tool errors with the task-008 code + human message (never raw stacks). Policy blocks come back as *results* (not protocol errors) so the model can read the reason and adapt.
- Resources (read-only MCP resources): `barkan://identity`, `barkan://policies`, `barkan://audit/recent` — cheap context for runtimes that prefetch resources.
- Rate limiting: reuse per-token bucket (task 008) on `/mcp`.
- Docs `docs/integrations/mcp.md`: endpoint URL, auth header, tool table, OpenClaw `mcpServers` config snippet + Hermes MCP config snippet (both remote HTTP; stdio bridge is task 047).

## Implementation steps
1. SDK wiring + Fastify bridge + auth (unit: 401 without token; tools/list requires auth).
2. Implement tools in a table-driven registry (schema, handler, capability guard — tool hidden from `tools/list` when the agent lacks the capability; test both visibility and invocation guard).
3. Contract tests using the SDK's client over an in-memory/HTTP transport against the Fastify app: every tool happy path (mock providers), approval wait flow, policy block surface, pagination cursors.
4. Manual verification with MCP Inspector.

## Acceptance criteria
- `npx @modelcontextprotocol/inspector` connects to `http://localhost:4001/mcp` with a bearer token: lists exactly the capability-scoped tools, `barkan_whoami` and an email send round-trip work.
- Tool-call audit entries indistinguishable in completeness from REST calls.
- Full vitest MCP suite green with zero live provider calls.

## How to test
```bash
npm --workspace @barkan/api run test -- mcp
npx @modelcontextprotocol/inspector --transport http --server-url http://localhost:4001/mcp --header "Authorization: Bearer $TOKEN"
# In inspector: tools/list -> call barkan_whoami -> call barkan_email_send {to, subject, body}
```
