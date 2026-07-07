---
name: barkan-identity
description: Give this agent a real-world identity (email address, phone number) via Barkan. Use for sending/receiving email, making phone calls, and SMS (including fetching 2FA codes).
homepage: https://barkan.dev
metadata: { openclaw: { requiredEnv: ["BARKAN_API_URL", "BARKAN_IDENTITY_TOKEN"], emoji: "🪪" } }
---

# Barkan Identity

Barkan gives this OpenClaw agent a scoped real-world identity: email, phone calls, SMS, approvals, policies, and audit history. Prefer the configured `barkan` MCP server. Use REST only when MCP tools are unavailable.

## When To Use

| User intent | Use |
| --- | --- |
| "Email Alex..." | `barkan_email_send` |
| "Check whether anyone replied" | `barkan_email_list_threads`, then `barkan_email_read_thread` |
| "Reply to that thread" | `barkan_email_reply` |
| "Call the restaurant" | `barkan_phone_call`, then `barkan_phone_get_call` |
| "Text this number" | `barkan_sms_send` |
| "What did they text back?" | `barkan_sms_conversation` |
| "Get the verification code" | `barkan_sms_latest_code` |
| "Who am I / what identity is configured?" | `barkan_whoami` |
| "What happened recently?" | `barkan_audit_recent` |
| Purchases, card charges, payment details | Not available. Say Barkan payment card capability is coming soon. Never improvise payment behavior. |

## Setup

Check:

```bash
test -n "$BARKAN_API_URL" && test -n "$BARKAN_IDENTITY_TOKEN"
```

If either value is missing, do not ask for Gmail, Twilio, Resend, Stripe, or carrier credentials. Ask the user to pair Barkan:

```bash
npx -y @barkan/mcp --pair
```

The user can also copy an agent identity token from the Barkan dashboard. OpenClaw config can inject values through:

```json
{
  "skills": {
    "entries": {
      "barkan-identity": {
        "env": {
          "BARKAN_API_URL": "https://api.barkan.dev",
          "BARKAN_IDENTITY_TOKEN": "brk_live_..."
        }
      }
    }
  }
}
```

## Preferred Path: MCP

If an MCP server named `barkan` is configured, use MCP tools instead of shelling out. Tool names:

| Tool | Purpose |
| --- | --- |
| `barkan_whoami` | Identity profile, contact points, capabilities, policies |
| `barkan_email_send` | Send new email |
| `barkan_email_list_threads` | List email threads |
| `barkan_email_read_thread` | Read one thread |
| `barkan_email_reply` | Reply to a thread |
| `barkan_phone_call` | Place outbound call |
| `barkan_phone_get_call` | Read call status, summary, transcript |
| `barkan_sms_send` | Send SMS |
| `barkan_sms_conversation` | Read SMS conversation |
| `barkan_sms_latest_code` | Fetch newest inbound 4-8 digit code |
| `barkan_approval_status` | Poll approval request |
| `barkan_audit_recent` | Read recent audit trail |

Default `wait_for_approval` to `true` unless the user explicitly wants a background request. If the tool returns pending approval, tell the user: "waiting for owner approval in the Barkan dashboard."

## Fallback Path: REST

Set base and bearer:

```bash
API="${BARKAN_API_URL:-https://api.barkan.dev}"
AUTH="authorization: Bearer $BARKAN_IDENTITY_TOKEN"
```

Send email:

```bash
curl -sS "$API/api/v1/agent/email/send?wait=120" \
  -H "$AUTH" -H "content-type: application/json" \
  -d '{"to":"person@example.com","subject":"Hello","text":"Hi from my Barkan identity."}'
```

List email threads:

```bash
curl -sS "$API/api/v1/agent/email/threads" -H "$AUTH"
```

Read email thread:

```bash
curl -sS "$API/api/v1/agent/email/threads/THREAD_ID" -H "$AUTH"
```

Reply to email thread:

```bash
curl -sS "$API/api/v1/agent/email/threads/THREAD_ID/reply?wait=120" \
  -H "$AUTH" -H "content-type: application/json" \
  -d '{"text":"Thanks, I will follow up."}'
```

Place phone call:

```bash
curl -sS "$API/api/v1/agent/phone/call?wait=120" \
  -H "$AUTH" -H "content-type: application/json" \
  -d '{"to":"+14155550198","task":"Ask whether they have a table for two tonight.","context":"Be concise and polite."}'
```

Read call status:

```bash
curl -sS "$API/api/v1/agent/phone/calls/CALL_ID" -H "$AUTH"
```

Send SMS:

```bash
curl -sS "$API/api/v1/agent/phone/sms?wait=120" \
  -H "$AUTH" -H "content-type: application/json" \
  -d '{"to":"+14155550198","body":"Hi, this is the Barkan agent identity."}'
```

Read SMS conversation:

```bash
curl -sS "$API/api/v1/agent/phone/sms?with=%2B14155550198" -H "$AUTH"
```

Fetch latest code:

```bash
curl -sS "$API/api/v1/agent/phone/sms/latest-code?since=$(date -u -Is)" -H "$AUTH"
```

REST errors use:

```json
{
  "error": {
    "code": "policy_blocked",
    "message": "reason",
    "requestId": "..."
  }
}
```

Report `error.code` and `error.message` plainly. Never expose stack traces or invent hidden details.

## Approvals Protocol

- Use `wait_for_approval: true` in MCP or `?wait=120` in REST.
- Pending result means the owner must approve in the Barkan dashboard.
- Tell the user: "waiting for owner approval in the Barkan dashboard."
- Poll `barkan_approval_status` or REST approval status at most once every 10 seconds.
- Never retry-spam the original action.
- Never claim the email, call, or SMS happened until the result confirms execution.
- If rejected, expired, or blocked, report that status and stop.

## Safety Rules

- Never fabricate call transcripts, email receipts, SMS contents, verification codes, or audit entries.
- Report `policy_blocked` reasons verbatim and adapt the plan.
- Never ask for provider credentials.
- Never collect, store, or use payment card details. Barkan card capability is coming soon.
- Keep outbound content faithful to the user's request; do not add commitments, prices, legal claims, or scheduling details the user did not authorize.
- Use E.164 phone numbers when calling or texting.

## Recipes

### 2FA Signup

1. Use `barkan_whoami` to get the agent email address and phone number.
2. Create the account with the agent email or phone number.
3. Call `barkan_sms_latest_code` with `since_minutes: 10`.
4. Use the returned code once.
5. If no code appears, ask the user whether to retry after waiting.

### Reservation Call

1. Clarify date, time, party size, name, and hard constraints.
2. Call `barkan_phone_call` with a concrete task and concise context.
3. Wait for completion or approval.
4. Summarize confirmed facts only. If not confirmed, say what is still unknown.

### Email Follow-up Loop

1. Send with `barkan_email_send`.
2. Later call `barkan_email_list_threads`.
3. Read relevant thread with `barkan_email_read_thread`.
4. Draft response from actual thread content.
5. Reply with `barkan_email_reply`.
