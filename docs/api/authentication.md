# API Authentication

Live reference: `/docs`. Machine-readable spec: `/api/v1/openapi.json` or `docs/api/openapi.json`.

## Agent Bearer Tokens

Agent-facing routes under `/api/v1/agent/*` use identity tokens:

```http
Authorization: Bearer brk_test_...
```

Owners receive the first token when creating an agent with `POST /api/v1/agents`. Additional tokens can be created with `POST /api/v1/agents/:agentId/tokens`; each agent can have up to 5 active tokens. Revoke a token with `DELETE /api/v1/agents/:agentId/tokens/:tokenId`.

Legacy rotation remains available at `POST /api/identity/tokens/rotate` for bearer-token clients.

## Owner Sessions

Owner dashboard routes under `/api/v1/agents`, `/api/v1/billing`, `/api/v1/approvals`, and `/api/v1/ops/*` use the HTTP-only session cookie issued by signup/login.

## Rate Limits

Agent-token routes are rate limited separately from owner auth routes. Rate limit failures return the shared error envelope with code `rate_limited` and retry metadata when available.

## Errors

All JSON API failures use the shared envelope:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "invalid request",
    "requestId": "request-id"
  },
  "message": "invalid request",
  "legacyError": "invalid request"
}
```
