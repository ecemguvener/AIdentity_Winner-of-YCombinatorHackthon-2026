# Phone Setup

Barkan provisions each phone capability as:

1. Reserve a database row for the agent.
2. Search and purchase a Twilio voice+SMS number.
3. Import that Twilio number into ElevenLabs Conversational AI.
4. Assign the shared ElevenLabs agent to the imported number.
5. Mark the row active and expose the E.164 number in the dashboard.

Disable and agent delete both remove the ElevenLabs number link, release the Twilio number, and mark the local row released.

## Environment

Set phone live mode only after Twilio and ElevenLabs are configured:

```bash
PROVIDER_MODE_PHONE=live
PUBLIC_API_URL=https://api.example.com

TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_NUMBER_COUNTRY=US
TWILIO_ADDRESS_SID=AD...
TWILIO_BUNDLE_SID=BU...

ELEVENLABS_API_KEY=...
ELEVENLABS_AGENT_ID=...
ELEVENLABS_VOICE_ID=...
ELEVENLABS_WORKSPACE_WEBHOOK_SECRET=...
CALL_COST_CENTS_PER_MINUTE=15
```

`TWILIO_ADDRESS_SID` and `TWILIO_BUNDLE_SID` are passed through during purchase when your country or account requires regulatory compliance.

## ElevenLabs Agent

Create one shared Conversational AI agent in ElevenLabs. Copy its ID into `ELEVENLABS_AGENT_ID`. Copy the selected voice ID into `ELEVENLABS_VOICE_ID`.

Recommended system prompt template:

```text
You are {{agent_identity_name}}, a real-world AI agent making a phone call on behalf of the Barkan user.

Owner: {{owner_name}}
Role: {{agent_role}}
Inbound guidance: {{inbound_guidance}}
Barkan call id: {{barkan_call_id}}

Recipient: {{recipient_name}}
Task: {{task}}
Opening: {{call_opening}}
Guidance: {{call_guidance}}
Context: {{context}}
Source URL: {{source_url}}

For inbound calls, answer using the provided first message and follow inbound guidance.
For outbound calls, complete only the requested task.
Be concise, identify yourself as an AI agent when appropriate, and do not invent authority or personal details.
```

In the ElevenLabs Security tab, allow runtime overrides for the first message and system prompt.

Inbound personalization uses:

- `agent_identity_name`
- `owner_name`
- `agent_role`
- `inbound_guidance`
- `barkan_call_id`

Outbound calls use:

- `agent_identity_name`
- `owner_name`
- `agent_role`
- `inbound_guidance`
- `barkan_call_id`
- `recipient_name`
- `task`
- `call_opening`
- `call_guidance`
- `context`
- `source_url`

Configure the ElevenLabs workspace webhook secret in Barkan as `ELEVENLABS_WORKSPACE_WEBHOOK_SECRET` before enabling live webhook verification. In ElevenLabs workspace settings, set the Twilio personalization webhook URL to:

```text
https://api.example.com/webhooks/elevenlabs/personalization
```

Set the post-call webhook URL to:

```text
https://api.example.com/webhooks/elevenlabs/post-call
```

Post-call webhooks finalize call status, transcript, summary, duration, and usage cost. `CALL_COST_CENTS_PER_MINUTE` controls the local cost estimate before billing integration.

## Twilio Scope

Use a Twilio credential pair limited to the account or subaccount that owns Barkan-managed numbers. Keep `PUBLIC_API_URL` externally reachable because purchase config attaches:

- `POST /webhooks/twilio/sms`
- `POST /webhooks/twilio/status`

Inbound SMS webhooks return empty TwiML (`<Response/>`) after storing messages for active Barkan phone numbers. Delivery status webhooks update outbound SMS rows to `sent`, `delivered`, `failed`, or `undelivered`.

Agents use bearer-token phone SMS APIs:

- `POST /api/v1/agent/phone/sms` with `{ "to": "+15551234567", "body": "Hello" }`
- `GET /api/v1/agent/phone/sms?with=+15551234567`
- `GET /api/v1/agent/phone/sms/latest-code?from=+15551234567&since=2026-07-07T10:00:00.000Z`

`latest-code` scans recent inbound SMS bodies for 4-8 digit verification codes and returns the newest match.

Owners use session-authenticated dashboard routes:

- `GET /api/v1/agents/:agentId/phone`
- `GET /api/v1/agents/:agentId/phone/calls`
- `GET /api/v1/agents/:agentId/phone/calls/:callId`
- `POST /api/v1/agents/:agentId/phone/call`
- `GET /api/v1/agents/:agentId/phone/sms`
- `POST /api/v1/agents/:agentId/phone/sms`

Owner-managed phone policy lives at `GET/PUT /api/v1/agents/:agentId/policies/phone`. It controls:

- Approval gates for outbound calls and SMS: `always`, `new_recipients`, or `never`.
- Country allowlists using E.164 prefix detection (`US`, `FR`, `GB`, common EU and global codes); unknown countries are denied when an allowlist is set.
- Daily call/SMS caps.
- Quiet hours evaluated in the configured policy timezone.
- Inbound enablement, caller blocklist, inbound instructions, and transcript storage.

Useful Twilio test numbers:

- `+15005550006`: valid test recipient
- `+15005550001`: invalid phone number
- `+15005550007`: carrier violation

Run the audit before and after live drills:

```bash
npm --workspace @barkan/api run twilio:audit
```

## Live Drill

1. Set `PROVIDER_MODE_PHONE=live` and required env vars.
2. Restart API with the new env.
3. Create or open an agent with phone disabled.
4. Enable phone in the dashboard.
5. Poll agent detail until provisioning reports `active` and shows an E.164 number.
6. Confirm the number exists in Twilio and is imported in ElevenLabs.
7. Configure ElevenLabs personalization webhook to the API URL above.
8. Call the number from a real phone and confirm the greeting says the agent name and owner attribution.
9. Disable phone.
10. Confirm Twilio number release, ElevenLabs number removal, local row `released`, and audit entries:
   - `phone.provisioned`
   - `phone.call.inbound`
   - `phone.released`
