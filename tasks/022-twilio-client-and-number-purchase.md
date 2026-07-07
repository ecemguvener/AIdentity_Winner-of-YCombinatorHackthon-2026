model: fable 5

# Task 022 — Twilio integration: search, buy, configure, release phone numbers

## Depends on
003, 009, 010

## Context
Agents currently get a fake `+1 415 555 XXXX` string. Real design: each phone-capable agent owns a real Twilio number (voice + SMS). Research notes: numbers are searched via `AvailablePhoneNumbers` and bought via `IncomingPhoneNumbers.create`; every number needs `smsUrl` (task 027) and voice configuration (delegated to ElevenLabs import in task 023); `TWILIO_NUMBER_COUNTRY` defaults to `US` because many EU countries (incl. FR) require a regulatory bundle — support `TWILIO_ADDRESS_SID`/`TWILIO_BUNDLE_SID` passthrough for those, documented but not required for US.

## Objective
A hardened Twilio provider module owning the number lifecycle, plus the `phoneNumbers` persistence — no route/UI changes yet.

## Spec
- Add `twilio` SDK. New `apps/api/src/providers/twilio-numbers.ts` (client injected for tests):
  - `searchNumbers(config, { country, areaCode?, contains? }) -> candidates[]` — local numbers with `voiceEnabled: true, smsEnabled: true`, max 10.
  - `purchaseNumber(config, { e164, friendlyName, agentId }) -> { twilioSid, e164, capabilities, monthlyPriceCents }` — `incomingPhoneNumbers.create({ phoneNumber, friendlyName: "barkan:"+agentId, smsUrl: PUBLIC_API_URL/webhooks/twilio/sms, smsMethod: "POST", statusCallback: PUBLIC_API_URL/webhooks/twilio/status })`, passing `addressSid`/`bundleSid` when configured.
  - `releaseNumber(config, twilioSid)` — `incomingPhoneNumbers(sid).remove()`, idempotent on 404.
  - `MockTwilioNumbers` for `PROVIDER_MODE_PHONE=mock`: deterministic fake numbers `+1500555XXXX`, in-memory sid registry — mock provider, but the *rows still persist* to Mongo like live.
- Persistence flow (used by task 023's provisioner): insert `phoneNumbers` row `status: "provisioning"` before purchase (reservation), update with sids after, `status: "active"` after ElevenLabs link (023). On purchase failure → row `status: "released"` + error detail in audit.
- Cost guard: refuse purchase when the account already has a number for the agent (unique `agentId` active row) — one number per agent v1.
- Ops utility `npm --workspace @barkan/api run twilio:audit` — script listing Twilio numbers vs `phoneNumbers` rows, flagging orphans both ways (dangling paid numbers = money leak).

## Implementation steps
1. SDK + provider module + mock; unit tests with injected fake client (search filter mapping, purchase param shape incl. webhook URLs, release idempotency).
2. Persistence helpers `apps/api/src/phone-numbers.ts` (`reserveNumberRow`, `activateNumberRow`, `markReleased`, `findActiveByAgent`, `findByE164`).
3. Orphan-audit script with table output.
4. Live smoke behind env guard (`TWILIO_LIVE_TEST=1` + real creds, uses a number search only — no purchase in CI; document a manual purchase/release drill).

## Acceptance criteria
- Full mock lifecycle test: reserve → purchase → active → release with correct row states + audit entries.
- Purchase params include both webhook URLs derived from `PUBLIC_API_URL` (asserted).
- Double-provision guard returns 409-style `ApiError`.
- `twilio:audit` correctly reports one seeded orphan in each direction (test with fake client).

## How to test
```bash
npm --workspace @barkan/api run test -- twilio-numbers phone-numbers
# Live search smoke (no purchase):
TWILIO_LIVE_TEST=1 npm --workspace @barkan/api run test -- twilio-live-search
# Manual purchase drill (real account, ~$1.15/mo — release right after):
node -e 'require("tsx/cjs"); /* use a scratch script calling purchaseNumber + releaseNumber */'
npm --workspace @barkan/api run twilio:audit
```
