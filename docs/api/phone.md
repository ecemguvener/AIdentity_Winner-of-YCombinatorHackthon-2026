# Agent Phone API

Live reference: `/docs`. Machine-readable spec: `/api/v1/openapi.json` or `docs/api/openapi.json`.

All routes require `Authorization: Bearer <identity token>` and return the shared API error envelope on failure.

## Number

`GET /api/v1/agent/phone/number`

```json
{
  "e164": "+15005550001",
  "country": "US",
  "capabilities": { "voice": true, "sms": true },
  "status": "active"
}
```

Returns `409 policy_blocked` when phone is not provisioned.

## Calls

`POST /api/v1/agent/phone/call?wait=90`

```json
{ "to": "+33612345678", "task": "Confirm booking", "context": "Optional", "recipientName": "Alex" }
```

Immediate success:

```json
{ "call_id": "66...", "status": "queued", "from": "+15005550001", "to": "+33612345678" }
```

Approval branch with `mode=async` or wait timeout:

```json
{ "ok": false, "status": "approval_required", "decision": "pending", "approval_id": "66..." }
```

`GET /api/v1/agent/phone/calls?cursor=<callId>`

`GET /api/v1/agent/phone/calls/:callId`

Call objects include `direction`, `counterparty_e164`, `task`, `status`, `duration_secs`, `summary`, `transcript`, `cost_cents`, and timestamps.

## SMS

`POST /api/v1/agent/phone/sms?wait=90`

```json
{ "to": "+33612345678", "body": "Hello", "idempotencyKey": "optional-key" }
```

Returns:

```json
{
  "message": {
    "id": "66...",
    "direction": "outbound",
    "counterparty_e164": "+33612345678",
    "body": "Hello",
    "status": "sent",
    "twilio_message_sid": "SMmock00000001",
    "created_at": "2026-07-07T10:00:00.000Z",
    "updated_at": "2026-07-07T10:00:00.000Z"
  }
}
```

`GET /api/v1/agent/phone/sms?with=+33612345678&cursor=<smsId>`

Returns chronological messages for that counterparty.

`GET /api/v1/agent/phone/sms/latest-code?from=+33612345678&since=2026-07-07T10:00:00.000Z`

Returns the newest 4-8 digit inbound code:

```json
{ "code": "482913", "receivedAt": "2026-07-07T10:02:00.000Z", "from": "+33612345678" }
```

Returns `404 not_found` when no recent code matches.

## Policy Errors

Phone and SMS policy violations return `403 policy_blocked`, including country allowlist failures, daily caps, quiet hours, and missing owner approval.
