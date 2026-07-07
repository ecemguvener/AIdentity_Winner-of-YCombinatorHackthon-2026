model: fable 5

# Task 024 — Inbound calls: per-number personalization + call records

## Depends on
023

## Context
With numbers assigned to the shared ElevenLabs agent, inbound calls connect — but the agent doesn't know *who it is*. ElevenLabs "Twilio personalization" solves this: on each inbound call it POSTs `{ caller_id, agent_id, called_number, call_sid }` to a configured webhook and expects conversation initiation data back (`dynamic_variables` + optional `conversation_config_override`) within a tight timeout. This is how one shared voice agent becomes every Barkan agent.

## Objective
Personalization webhook + inbound call persistence, so each agent answers as itself with owner-defined behavior.

## Spec
- `POST /webhooks/elevenlabs/personalization` (framework 009, HMAC verify with `ELEVENLABS_WORKSPACE_WEBHOOK_SECRET`; this endpoint is synchronous — target <300ms, so resolve from indexed lookups only):
  1. Look up `phoneNumbers` by `called_number` (E.164 normalize) → agent → policies.phone + owner display name.
  2. Insert `calls` row `{ direction: "inbound", counterpartyE164: caller_id, providerCallId: call_sid, status: "in_progress" }`.
  3. Respond:
     ```json
     { "type": "conversation_initiation_client_data",
       "dynamic_variables": {
         "agent_identity_name": "<agent.name>",
         "owner_name": "<owner displayName or 'my owner'>",
         "agent_role": "<agent.description or 'personal assistant'>",
         "inbound_guidance": "<policies.phone.inboundInstructions or default>",
         "barkan_call_id": "<calls._id>"
       },
       "conversation_config_override": { "agent": { "first_message": "Hi, this is <name>, <owner>'s assistant. How can I help?" } }
     }
     ```
  4. Unknown number → respond with a neutral decline persona ("This number is not in service") + audit `phone.call.inbound` blocked.
- Policy hooks (full policy task is 028; here implement only): `policies.phone.inboundEnabled` (false → decline persona), `blockedCallers` E.164 list.
- Audit `phone.call.inbound` allowed/blocked with caller id.
- Update the shared-agent system prompt template in `docs/phone-setup.md` to reference all dynamic variables ({{agent_identity_name}}, {{owner_name}}, {{inbound_guidance}}...) and document enabling the personalization webhook + overrides in the ElevenLabs dashboard (Security tab: enable overrides for first_message; Settings: personalization webhook URL).
- SSE `call.started` event to the owner dashboard.

## Implementation steps
1. Route via webhook framework (note: this endpoint returns a *body the provider consumes*, not just 200 — extend the framework to support `respond(payload)` handlers; dedupe by `call_sid`).
2. E.164 normalization helper shared with 022 (`lib/phone.ts`).
3. Tests: known number happy path (snapshot response), unknown number persona, blocked caller, inboundEnabled=false, malformed payload 401/400, duplicate call_sid dedupe.
4. Live drill: call the number; the agent must answer with the personalized first message and hold a sensible conversation as "Maya".

## Acceptance criteria
- Personalization response p50 latency <300ms in a local benchmark (100 sequential requests against memory Mongo — write the micro-benchmark in the test).
- Call rows created for every inbound call with correct agent attribution.
- Live drill: caller hears the agent's own name and owner attribution.

## How to test
```bash
npm --workspace @barkan/api run test -- personalization
# Simulated:
curl -s -X POST localhost:4001/webhooks/elevenlabs/personalization -H 'content-type: application/json' \
  -H 'x-mock-signature: allow' -d '{"caller_id":"+33612345678","agent_id":"el_agent","called_number":"<agent E164>","call_sid":"CA123"}' | jq .dynamic_variables
# Live: configure webhook URL (tunnel) in ElevenLabs workspace, call the number.
```
