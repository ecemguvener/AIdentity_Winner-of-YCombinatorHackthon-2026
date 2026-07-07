model: fable 5

# Task 027 — SMS: send and receive on the agent's number

## Depends on
022, 023

## Context
Task 022 already points every purchased number's `smsUrl` at `POST /webhooks/twilio/sms`. Twilio delivers inbound SMS as form-encoded webhooks (signature scheme implemented in task 009) and sends outbound via `client.messages.create`. SMS matters: verification codes and quick confirmations are how an agent identity proves liveness to the real world.

## Objective
Bidirectional SMS per agent with conversation storage and status tracking.

## Spec
- Provider `apps/api/src/providers/twilio-sms.ts`: `sendSms({ from, to, body, statusCallback }) -> { twilioMessageSid }` + mock (`PROVIDER_MODE_PHONE=mock`).
- Service `apps/api/src/sms-service.ts`:
  - `sendAgentSms(collections, config, { agent, to, body, idempotencyKey? })` — agent's active number required; body ≤ 1600 chars; insert `smsMessages` (`queued`) → provider → sid, `status: "sent"`; audit `sms.send`; usage hook `sms_messages`.
  - Inbound webhook `POST /webhooks/twilio/sms` (form-encoded, Twilio signature): match `phoneNumbers` by `To` → insert `smsMessages { direction: "inbound", counterpartyE164: From, body: Body, twilioMessageSid: MessageSid, status: "received" }`; audit `sms.receive`; SSE `sms.received`; respond empty TwiML `<Response/>` (content-type `text/xml`). Unknown `To` → still 200 TwiML, audit unrouted.
  - Status webhook `POST /webhooks/twilio/status` updates outbound rows by `MessageSid` (`delivered`/`failed`/`undelivered` + `ErrorCode` into audit on failure).
- Bearer routes: `POST /api/v1/agent/phone/sms { to, body }`, `GET /api/v1/agent/phone/sms?with=<E164>&cursor=` (conversation view: merged inbound/outbound with that counterparty, chronological).
- Verification-code convenience: `GET /api/v1/agent/phone/sms/latest-code?from=&since=` — scans recent inbound for 4-8 digit codes (regex `\b\d{4,8}\b`, most recent wins) → `{ code, receivedAt, from }` or 404. This single endpoint lets agents complete SMS-2FA signups — a killer feature; document it prominently.
- Twilio magic test numbers documented for live-ish testing (`+15005550006` etc. work with test credentials for send; real inbound needs a real number).

## Implementation steps
1. Provider + service + routes + webhooks with tests (signature reject, unknown To, duplicate MessageSid unique-index skip, TwiML content type, code extraction: "Your code is 482913" → `482913`, multiple codes → newest message wins).
2. SSE event wiring + audit.
3. Live drill: text the agent's number from your phone → appears via API; agent replies → arrives on your phone; delivery status flips `delivered`.

## Acceptance criteria
- Full loop proven live (screenshot/log in PR): human SMS → agent API shows it; agent SMS → human phone.
- `latest-code` returns the right code with mixed inbound noise (test with 3 fixture messages).
- All webhook routes tolerate Twilio retries (idempotent by MessageSid).

## How to test
```bash
npm --workspace @barkan/api run test -- sms
curl -s -X POST localhost:4001/api/v1/agent/phone/sms -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"to":"+336XXXXXXXX","body":"Hi, Maya here — confirming our meeting."}' | jq .
# Text back from your phone (tunnel configured), then:
curl -s "localhost:4001/api/v1/agent/phone/sms?with=%2B336XXXXXXXX" -H "authorization: Bearer $TOKEN" | jq '.messages[-1]'
curl -s "localhost:4001/api/v1/agent/phone/sms/latest-code" -H "authorization: Bearer $TOKEN" | jq .
```
