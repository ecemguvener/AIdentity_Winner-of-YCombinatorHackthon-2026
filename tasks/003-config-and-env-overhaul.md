model: gpt 5.5

# Task 003 — Config overhaul: provider modes, new env vars, fail-fast validation

## Depends on
002

## Context
`apps/api/src/config.ts` validates env with zod but only knows about ElevenLabs/OpenAI/Resend. The finished product needs Stripe, Twilio, explicit provider modes, and a clear separation between "capability runs live" and "capability runs mocked". Today mocks activate silently when keys are missing — that is exactly how the product ended up fake. Silent fallback must die.

## Objective
One authoritative, fail-fast config module with explicit per-capability provider modes and the full target env surface.

## Spec
Extend the zod `environmentSchema` in `apps/api/src/config.ts`:

```
# Provider modes — explicit, no silent fallback
PROVIDER_MODE_EMAIL  = "live" | "mock"   (default "mock")
PROVIDER_MODE_PHONE  = "live" | "mock"   (default "mock")

# Stripe (SaaS billing only — agent card capability is deferred, no Issuing vars)
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET            (optional strings)

# Twilio
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN               (optional strings)
TWILIO_NUMBER_COUNTRY (default "US"), TWILIO_ADDRESS_SID (optional, for countries requiring it)

# ElevenLabs — keep existing keys, add:
ELEVENLABS_WORKSPACE_WEBHOOK_SECRET (optional)      # post-call + personalization webhook HMAC

# Email — rename/clarify:
EMAIL_AGENT_DOMAIN (default "agents.barkan.dev")    # replaces EMAIL_FROM_DOMAIN (keep old name as alias)
EMAIL_PLATFORM_FROM (default "Barkan <no-reply@barkan.dev>")
RESEND_WEBHOOK_SECRET                               # replaces EMAIL_WEBHOOK_SECRET (keep alias)

# Misc
SENTRY_DSN (optional), API_RATE_LIMIT_MAX (default 300/min)
```

Cross-field validation via `.superRefine`:
- `PROVIDER_MODE_PHONE === "live"` requires `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`.
- `PROVIDER_MODE_EMAIL === "live"` requires `RESEND_API_KEY` + `EMAIL_AGENT_DOMAIN`.
- Violation → process exits at boot with a message naming the missing vars.

## Implementation steps
1. Extend the schema exactly as specced; export a typed `AppConfig`.
2. Add startup log line (no secrets): `capabilities: email=live phone=mock`.
3. Alias handling: if only legacy `EMAIL_FROM_DOMAIN`/`EMAIL_WEBHOOK_SECRET` are set, map them into the new names and log a deprecation warning.
4. Replace every scattered `config.RESEND_API_KEY ? live : mock` style branch with checks against `PROVIDER_MODE_*` (there are such branches in `email.ts` and `phone.ts` — change the *condition source* only; live/mock implementations themselves are replaced in later tasks).
5. Rewrite `.env.example` with all variables above, grouped and commented (where to get each key, which Stripe/Twilio/Resend dashboard page).
6. Update `config.test.ts`: mode defaults, superRefine failures, alias mapping.

## Acceptance criteria
- Boot with `PROVIDER_MODE_PHONE=live` and no Twilio keys → process exits non-zero, message lists the missing vars.
- Boot with defaults → all capabilities mock, startup line printed.
- All existing tests pass; new config tests cover the matrix.

## How to test
```bash
npm --workspace @barkan/api run test
PROVIDER_MODE_PHONE=live npm --workspace @barkan/api run dev   # -> exits with named missing vars
npm --workspace @barkan/api run dev                             # -> "capabilities: email=mock phone=mock"
```
