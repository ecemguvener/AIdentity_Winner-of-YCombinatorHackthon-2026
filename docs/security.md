# Barkan Security

## Threat Model

Barkan issues bearer tokens that can send email/SMS and place calls as an agent identity. Primary threats are token theft, IDOR across owner accounts, prompt-injected tool abuse, webhook forgery, provider key leaks, account takeover, and accidental collection of card data while card capability is deferred.

## Control Checklist

| Area | Status | Control |
| --- | --- | --- |
| Session hardening | Implemented | HTTP-only `sameSite=lax` cookies, `secure` in production, session rotation on login, 30 day absolute lifetime, 7 day idle timeout, server-side logout. |
| Login brute force | Implemented | Existing IP rate limit plus 10 failed attempts per account in 15 minutes locks login with 423. |
| Password policy | Implemented | Signup/change require 10-128 chars; password change verifies current password; bcrypt cost is 12. |
| IDOR | Implemented/ongoing | Owner routes scope by `ownerUserId`; regression tests cover cross-owner agent routes, including freeze-all. Full route-walker expansion should stay in CI as new `/api/v1/*` routes land. |
| Token hygiene | Implemented | Identity tokens are accepted only through `Authorization: Bearer`; hashes are stored, plaintext is shown once, `lastUsedAt` and `lastUsedIp` are recorded, 90 day unused tokens are flagged in owner detail. |
| Webhooks | Implemented | Stripe, Resend/Svix, Twilio, and ElevenLabs verifiers are mandatory outside mock mode; `x-mock-signature` is gated to mock mode with no secret configured. |
| Headers | Implemented | API uses Helmet with nosniff and frame-deny; `/docs` has CSP; production web deploy emits equivalent static headers plus HSTS. |
| Input limits | Implemented | API body limit is 1MB; large tool inputs use Zod max lengths. Attachment download routes are GET proxy routes. |
| SSRF | Verified | Provider calls use constant vendor URLs. User input is not used to choose outbound fetch hosts. Keep this invariant when adding webhooks or attachment fetches. |
| Secrets | Verified | `.env` is ignored and not currently tracked. `SESSION_SECRET` length is validated. Rotate provider keys by updating env, restarting PM2, verifying `/api/v1/ops/status`, then revoking old keys in provider dashboards. |
| Mongo injection | Verified | Queries use typed filters and ObjectId validation; no `$where` usage is present. Avoid dynamic Mongo operator keys from request bodies. |
| Dependency audit | Implemented | `npm run audit` runs `npm audit --omit=dev`; current production audit is clean. |
| Card data | Verified | Card capability remains "coming soon"; do not add PAN, CVC, or card-number fields until a PCI-scoped design exists. |

## Incident Basics

If an identity token leaks, use `POST /api/v1/agents/:agentId/freeze-all`. This pauses the agent, revokes all active identity tokens, pauses email, and makes capability calls fail within the next request. For broader compromise, rotate `SESSION_SECRET`, Stripe, Twilio, Resend, ElevenLabs, and OpenAI keys; restart API with PM2; then inspect audit logs and webhook dead letters.
