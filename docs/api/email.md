# Email Agent API Contract

Bearer auth: `Authorization: Bearer <identity_token>`.

All errors use:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "invalid request",
    "requestId": "<request-id>"
  },
  "message": "invalid request"
}
```

## Endpoints

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/api/v1/agent/email/address` | none | `{ address, displayName, status }` |
| `POST` | `/api/v1/agent/email/send?wait=<seconds>\|mode=async` | `{ to, subject, text, html?, cc?, idempotencyKey? }` | send result or approval pending |
| `GET` | `/api/v1/agent/email/threads?cursor=<thread_id>` | none | paged thread list |
| `GET` | `/api/v1/agent/email/threads/:threadId` | none | thread plus messages |
| `POST` | `/api/v1/agent/email/threads/:threadId/reply?wait=<seconds>\|mode=async` | `{ text, idempotencyKey? }` | send result or approval pending |
| `GET` | `/api/v1/agent/email/threads/:threadId/attachments/:attachmentId` | none | attachment bytes |
| `GET` | `/api/v1/agent/approvals/:id` | none | approval status and payload |

## Examples

### Address

```json
{
  "address": "address@agents.barkan.dev",
  "displayName": "Address 1",
  "status": "active"
}
```

### Send

```json
{
  "ok": true,
  "message_id": "<object-id>",
  "thread_id": "<object-id>",
  "provider_message_id": "<provider-message-id>",
  "from": "send@agents.barkan.dev",
  "to": "alice@example.com",
  "subject": "Hello",
  "status": "sent"
}
```

### Threads

```json
{
  "threads": [
    {
      "id": "<object-id>",
      "counterparty": "thread@example.com",
      "subject": "Thread",
      "lastMessageAt": "<iso-date>",
      "unreadCount": 0
    }
  ],
  "nextCursor": null
}
```

### Thread Detail

```json
{
  "thread": {
    "id": "<object-id>",
    "counterparty": "detail@example.com",
    "subject": "Detail",
    "lastMessageAt": "<iso-date>",
    "messageCount": 1
  },
  "messages": [
    {
      "id": "<object-id>",
      "thread_id": "<object-id>",
      "direction": "outbound",
      "from_email": "thread-detail@agents.barkan.dev",
      "to_email": "detail@example.com",
      "cc": [],
      "subject": "Detail",
      "body": "Body",
      "html": null,
      "provider_message_id": "<provider-message-id>",
      "status": "sent",
      "parsed_by": null,
      "summary": null,
      "suggested_reply": null,
      "attachments": [],
      "created_at": "<iso-date>"
    }
  ]
}
```

### Approval Pending

```json
{
  "ok": false,
  "status": "approval_required",
  "decision": "pending",
  "approval_id": "<object-id>",
  "approval": {
    "id": "<object-id>",
    "status": "pending",
    "payloadSummary": "Send email to async-contract@example.com: Async",
    "executionResult": null,
    "executionError": null
  }
}
```

### Approval Lookup

```json
{
  "approval": {
    "id": "<object-id>",
    "agentId": "<object-id>",
    "ownerUserId": "<object-id>",
    "kind": "email.send",
    "status": "pending",
    "payloadSummary": "Send email to approval-get@example.com: Needs approval",
    "payload": {
      "to": "approval-get@example.com",
      "cc": [],
      "subject": "Needs approval",
      "text": "Please approve"
    },
    "decisionNote": null,
    "executionResult": null,
    "executionError": null,
    "decidedAt": null,
    "expiresAt": "<iso-date>",
    "createdAt": "<iso-date>",
    "updatedAt": "<iso-date>"
  }
}
```

## Error Codes

| Code | HTTP | Meaning |
| --- | ---: | --- |
| `unauthorized` | 401 | Missing, invalid, or revoked identity token. |
| `policy_blocked` | 403 | Email policy blocked the send. Message carries the reason. |
| `approval_required` | 403 or 202 | Approval was rejected/expired, or async/wait mode returned a pending approval. |
| `validation_failed` | 400 or 409 | Malformed payload, bad id, or non-actionable state. |
| `provider_error` | 502 | Email provider rejected or failed the send. |
| `rate_limited` | 429 | Agent-token route rate limit exceeded. |

## Contract Source

`apps/api/src/email-contract.test.ts` is the frozen contract. Inline snapshots in that file define response shapes used by future OpenAPI, MCP, and SDK work.
