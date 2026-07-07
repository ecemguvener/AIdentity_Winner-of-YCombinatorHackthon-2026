model: fable 5

# Task 052 — Security pass: the audit before real identities go live

## Depends on
All capability phases (2-5); run before launch tasks.

## Context
Barkan holds bearer tokens that can make calls and send email/SMS as a real identity. A leaked token or IDOR is existential. This task is a systematic hardening sweep with tests that lock each fix in place.

## Objective
Close the known gap list below, add the missing protections, and produce `docs/security.md` describing the threat model and controls.

## Spec — checklist (each item = code/config + a test or documented verification)
1. **Session hardening**: cookie `httpOnly`, `sameSite=lax`, `secure` in production (verify current `auth.ts` behavior), session rotation on login, absolute lifetime 30d + idle timeout 7d, logout revokes server-side.
2. **Login brute force**: per-account lockout (10 fails/15min → 423 with unlock-by-email) on top of task 008's IP limit.
3. **Password policy**: min 10 chars at signup/change; `POST /api/auth/me/password` requires current password (verify); bcrypt cost ≥ 12.
4. **IDOR sweep**: automated test iterating EVERY `/api/v1/*` route from the Fastify route table with a second user's session/token — asserts 401/403/404, never 2xx with foreign data. This test is the crown jewel of the task; wire into CI.
5. **Token hygiene**: identity tokens only in `Authorization` headers (reject `?token=` query usage), constant-time hash compare, `lastUsedAt` + IP recorded, dashboard shows last-used (already in 012 — verify), unused-90-days tokens flagged in UI.
6. **Webhook endpoints**: confirm all four providers verify signatures in live mode (grep for `x-mock-signature` acceptance paths — must be gated on mock mode; test that live mode rejects it).
7. **Headers**: `@fastify/helmet` (CSP for the API's `/docs` page only, HSTS in production, nosniff, frame-deny); web dist served with equivalent headers (update `scripts/deploy-barkan-web.sh` nginx/static config accordingly — inspect what it deploys to and document).
8. **Input limits**: body limit already 8MB — reduce to 1MB except attachment-proxy routes; string length caps in all zod schemas (sweep for unbounded `z.string()`).
9. **SSRF**: outbound webhooks/fetches never take user-controlled URLs today — assert with grep sweep + comment guards where URLs are built.
10. **Secrets**: `.env` not in git (verify history! if ever committed, note rotation requirement in report), startup redacts config logging, `SESSION_SECRET` min length enforced (config), document rotation procedure for every provider key in `docs/security.md`.
11. **Mongo injection**: sweep for user input passed into query operators (`$where`, dynamic keys); zod-validate all ids as ObjectId/hex.
12. **Dependency audit**: `npm audit --omit=dev` clean or documented exceptions; add `npm run audit` to CI.
13. **No card data anywhere**: the card capability is deferred — assert no PAN-like fields, no card collection paths, no payment card copy outside "Coming soon" markers (`grep -rni "cardNumber\|pan\b\|cvc" apps/` → nothing).

## Implementation steps
1. Work the checklist top to bottom; each fix lands with its regression test.
2. Write the IDOR route-walker test harness (auto-discovers routes, parameterizes fixtures for path params).
3. `docs/security.md`: threat model (token theft, prompt-injected agent abusing tools, webhook forgery, IDOR, provider key leak), control mapping to checklist items, incident basics (revoke-all endpoint below).
4. Add owner panic button: `POST /api/v1/agents/:agentId/freeze-all` — one call pauses agent, revokes tokens, pauses email/phone; UI danger-zone button. Test it.

## Acceptance criteria
- IDOR walker green across every route; CI-wired.
- Panic freeze verified: all capability calls fail within 1s of freeze (integration test).
- `docs/security.md` complete; checklist table included with per-item status.

## How to test
```bash
npm --workspace @barkan/api run test -- security idor
npm audit --omit=dev
# Manual: freeze drill
curl -s -X POST localhost:4001/api/v1/agents/<id>/freeze-all -H "cookie: $COOKIE"
curl -s -X POST localhost:4001/api/v1/agent/email/send -H "authorization: Bearer $TOKEN" -d '{...}'   # -> 401
```
