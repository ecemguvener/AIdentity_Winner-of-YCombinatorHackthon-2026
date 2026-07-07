model: fable 5

# Task 023 — Phone provisioner: Twilio number → ElevenLabs voice agent link

## Depends on
022

## Context
Research decision: voice AI runs on **ElevenLabs Agents** with **one shared conversational agent** (`ELEVENLABS_AGENT_ID`) for the whole platform. Each purchased Twilio number is imported into ElevenLabs via `POST /v1/convai/phone-numbers` (provider `twilio`, account sid + auth token) → returns `phone_number_id`; the number is then assigned to the shared agent so inbound calls are answered. Per-agent behavior comes from dynamic variables (task 024/025) — NOT from separate ElevenLabs agents.

## Objective
Real phone capability provisioner in the registry (replaces the task-010 stub): one call chain from "enable phone" to a live, answerable number.

## Spec
- `apps/api/src/providers/elevenlabs-phone.ts` (fetch-based like existing `phone.ts`, injectable):
  - `importTwilioNumber(config, { e164, label }) -> { phoneNumberId }` — POST `/v1/convai/phone-numbers` `{ provider: "twilio", phone_number, label, sid: TWILIO_ACCOUNT_SID, token: TWILIO_AUTH_TOKEN }`.
  - `assignAgentToNumber(config, phoneNumberId)` — PATCH `/v1/convai/phone-numbers/{id}` `{ agent_id: ELEVENLABS_AGENT_ID }`.
  - `removeNumber(config, phoneNumberId)` — DELETE, idempotent on 404.
  - Mock implementation for `PROVIDER_MODE_PHONE=mock` (`mock_pn_<rand>`).
- Phone provisioner (`registerProvisioner("phone", ...)`):
  - `provision(agent)`: reserve row → search (prefer `TWILIO_NUMBER_COUNTRY`) → purchase (022) → import to ElevenLabs → assign shared agent → row `status: "active"` with `elevenLabsPhoneNumberId` → audit `phone.provisioned` → provisioning state detail = E.164. Each step updates `provisioning.phone.detail` ("Buying number…", "Linking voice agent…") for the task-012 progress UI. Failure at any step: compensate (release Twilio number if bought; remove ElevenLabs import if created), row `released`, state `failed` with reason.
  - `deprovision(agent)`: remove ElevenLabs number, release Twilio number, row `released`, audit. Called from capability disable and agent delete.
  - `status(agent)`: from the row.
- Document (in `docs/phone-setup.md`): creating the shared ElevenLabs agent (system prompt template with the dynamic variables from task 024, voice `ELEVENLABS_VOICE_ID`, enable overrides for first message/system prompt in the agent's Security tab), where to find `ELEVENLABS_AGENT_ID`, webhook secret setup (workspace settings), Twilio credential scoping.

## Implementation steps
1. Provider module + mock + unit tests (request shapes, error surfaces: 402 quota, 422 bad number).
2. Provisioner with compensation logic; integration tests with fake providers: happy path row states, failure-at-import triggers Twilio release (assert fake release called), failure-at-purchase leaves no orphan.
3. Wire agent deletion (task 010 hook) → deprovision.
4. Live drill (manual, documented): enable phone on a test agent with `PROVIDER_MODE_PHONE=live`, call the number from your cell — the shared agent answers (generic greeting until task 024 personalizes it). Release after.

## Acceptance criteria
- Mock-mode: enable → `provisioning` → `active` with E.164 visible in dashboard within one poll cycle; disable → `released` and (in live) number actually gone from both Twilio and ElevenLabs.
- Compensation proven by tests — no path leaves a paid number unreferenced.
- Live drill answered by AI voice (attach call recording note or transcript reference in PR).

## How to test
```bash
npm --workspace @barkan/api run test -- phone-provisioner elevenlabs-phone
# Mock manual:
curl -s -X POST localhost:4001/api/v1/agents/<id>/capabilities/phone/enable -H "cookie: $COOKIE"
watch -n2 'curl -s localhost:4001/api/v1/agents/<id> -H "cookie: $COOKIE" | jq .provisioning.phone'
# Live drill: PROVIDER_MODE_PHONE=live + creds; call the E.164 from your phone.
```
