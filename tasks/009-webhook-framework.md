model: fable 5

# Task 009 — Webhook ingestion framework: signatures, idempotency, replay

## Depends on
004, 008

## Context
The product will consume webhooks from four providers — Stripe (billing), Twilio (SMS, voice status), Resend (email delivery + inbound), ElevenLabs (post-call transcripts, personalization fetch). Each has a different signature scheme. `app.ts` already keeps the raw JSON body (`request.rawBody`) for Svix verification — generalize that. Getting this wrong means double-billing subscriptions or dropping inbound email, so this framework must be airtight before any capability task consumes it.

## Objective
One reusable webhook pipeline: raw-body capture, per-provider signature verification, exactly-once processing via `webhookEvents`, dead-letter visibility.

## Spec
- New `apps/api/src/webhooks/framework.ts`:
  - `registerWebhookRoute(app, { path, provider, verify, extractEventId, extractEventType, handle })`.
  - Flow: capture raw body → `verify(rawBody, headers, config)` (throw → 401, audit `webhook.signature_failed`) → upsert `webhookEvents` with `{provider, providerEventId}` unique; if already `processed`/`received` → 200 `{skipped:true}` (idempotent replay) → run `handle(parsedPayload, event)` → mark `processed` or `failed` with error text → always 200 to the provider on handled outcomes, 5xx only on unexpected crashes so providers retry.
- Verifiers in `apps/api/src/webhooks/verify.ts`:
  - `verifyStripeSignature` — `stripe.webhooks.constructEvent(rawBody, sig, secret)` (dependency added in task 031; until then implement HMAC-SHA256 of `t.payload` per Stripe spec with tolerance 300s — no SDK needed).
  - `verifySvixSignature` — Resend/Svix `svix-id`/`svix-timestamp`/`svix-signature` HMAC (port existing logic from `email.ts` if present).
  - `verifyTwilioSignature` — `X-Twilio-Signature`: HMAC-SHA1 of full URL + sorted POST params with auth token (Twilio sends `application/x-www-form-urlencoded` — the framework must support both content types; add a urlencoded parser preserving raw body).
  - `verifyElevenLabsSignature` — `ElevenLabs-Signature` header: `t=<ts>,v0=<hmac_sha256(ts + "." + body)>` with `ELEVENLABS_WORKSPACE_WEBHOOK_SECRET`, tolerance 30min.
- Mock mode: when the relevant `PROVIDER_MODE_*` is `mock` and no secret configured, accept a `x-mock-signature: allow` header instead (for local/CI tests) — never in live mode.
- Ops route `GET /api/v1/webhook-events?provider=&status=failed` (session auth, owner-agnostic admin listing scoped later; for now require session).

## Implementation steps
1. Add urlencoded content-type parser that stores raw string body alongside the existing JSON one.
2. Implement framework + four verifiers with exhaustive unit tests using fixture payloads and known-good signatures (generate fixtures with the same HMAC code inverted — plus one real captured sample per provider format documented in comments).
3. Concurrency test: two simultaneous deliveries of the same event id → exactly one `handle` execution (rely on the unique index + `findOneAndUpdate` insert semantics).
4. Register a placeholder route `POST /webhooks/ping/:provider` (behind mock mode) to exercise the pipeline end-to-end in dev.

## Acceptance criteria
- Tampered payload (one byte flipped) → 401 for all four verifiers.
- Replayed event id → 200 `{skipped:true}`, `handle` not re-run.
- Handler throw → `webhookEvents.status = "failed"` with error, response 500, retry then succeeds → `processed`.
- Framework works for JSON (Stripe/Resend/ElevenLabs) and form-encoded (Twilio) bodies.

## How to test
```bash
npm --workspace @barkan/api run test -- webhooks
# Dev pipeline smoke (mock mode):
curl -s -X POST localhost:4001/webhooks/ping/resend -H 'content-type: application/json' -H 'x-mock-signature: allow' -d '{"id":"evt_1","type":"ping"}'
curl -s -X POST localhost:4001/webhooks/ping/resend -H 'content-type: application/json' -H 'x-mock-signature: allow' -d '{"id":"evt_1","type":"ping"}'   # -> {"skipped":true}
```
