# OpenClaw Identity Layer Integration

Use the identity layer as the permissioned automation layer in front of real-world tools.
OpenClaw stays the agent brain. The identity layer owns identity, permissions, execution, audit logs, and revocation.

## 1. Initialize the identity layer

Call this before OpenClaw performs real-world actions:

```bash
curl -sS http://localhost:4001/api/identity/init \
  -H 'content-type: application/json' \
  -d '{
    "agent_name": "Maya",
    "agent_runtime": "openclaw",
    "use_case": "customer_discovery",
    "tools": ["email", "phone", "calendar"],
    "permissions": {
      "email.send": true,
      "phone.call": true,
      "calendar.create": true,
      "requires_human_approval": true
    }
  }'
```

The response returns:

```json
{
  "agent_id": "agent_maya_...",
  "identity_token": "identity_live_...",
  "email": "maya-1234@agents.barkan.dev",
  "phone": "+1 415 555 1234",
  "calendar_url": "http://localhost:4001/calendar/agent_maya_...",
  "openclaw_env": {
    "IDENTITY_LAYER_API_URL": "http://localhost:4001",
    "AGENT_IDENTITY_TOKEN": "identity_live_..."
  }
}
```

## 2. Attach the token to OpenClaw

Give OpenClaw these environment variables or config values:

```bash
IDENTITY_LAYER_API_URL=http://localhost:4001
AGENT_IDENTITY_TOKEN=identity_live_...
```

OpenClaw should never receive raw Gmail, Twilio, calendar, or payment keys.
It only receives the identity token.

## 2a. Add the identity skill to OpenClaw

This repo includes a portable skill folder:

```text
openclaw-skills/identity-layer/
  SKILL.md
  client.js
```

Add that folder to your OpenClaw skills directory, or copy the instructions from
`SKILL.md` into the OpenClaw agent. The skill tells OpenClaw:

1. initialize identity before real-world actions,
2. store `AGENT_IDENTITY_TOKEN`,
3. call identity-layer email, phone, audit, and revoke endpoints,
4. never use raw provider credentials.

## 3. Call identity-layer tools from OpenClaw

Every real-world action goes through the identity layer with the identity token:

```bash
curl -sS http://localhost:4001/api/v1/agent/email/send \
  -H "authorization: Bearer $AGENT_IDENTITY_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "to": "demo@example.com",
    "subject": "Customer discovery call",
    "text": "Hi, can we ask two questions about your workflow?",
    "approved": true
  }'
```

Phone calls are demo-simulated but permissioned and audited:

```bash
curl -sS http://localhost:4001/api/v1/agent/phone/call \
  -H "authorization: Bearer $AGENT_IDENTITY_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "to": "+14155550198",
    "script": "Ask for a quick validation interview.",
    "approved": true
  }'
```

## 4. Read the audit log

```bash
curl -sS http://localhost:4001/api/identity/agent_maya_.../audit-log \
  -H "authorization: Bearer $AGENT_IDENTITY_TOKEN"
```

## 5. Revoke the identity

```bash
curl -sS http://localhost:4001/api/identity/revoke \
  -X POST \
  -H "authorization: Bearer $AGENT_IDENTITY_TOKEN"
```

After revocation, tool calls using that token are blocked.

## Demo Script

1. Initialize identity for an OpenClaw agent.
2. Copy the returned token into OpenClaw.
3. Ask OpenClaw to validate a startup idea.
4. OpenClaw calls the identity-layer email, phone, and calendar tools.
5. Show the audit log and kill switch.

Pitch line:

> This is the permissioned automation layer for AI agents. OpenClaw thinks; the identity layer gives it safe real-world powers.
