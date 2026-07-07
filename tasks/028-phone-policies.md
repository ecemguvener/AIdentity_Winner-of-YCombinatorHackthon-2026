model: gpt 5.5

# Task 028 — Phone & SMS policies + approval gating

## Depends on
013, 019 (policy module + executor registry), 025, 027

## Context
Email established the policy pattern (task 019): policy doc section, enforcement in the service, approval executors, owner routes, UI card. Replicate for voice + SMS with phone-specific rules.

## Spec
- `policies.phone` shape:
  ```ts
  { requireApprovalOutboundCall: "always"|"new_recipients"|"never",   // default "always"
    requireApprovalSms: "always"|"new_recipients"|"never",            // default "new_recipients"
    allowedCountries: string[],          // ISO like "US","FR"; empty = all; enforced via E.164 prefix table
    blockedCallers: string[],            // inbound blocklist (already read by task 024)
    inboundEnabled: boolean,             // default true (task 024)
    inboundInstructions: string,         // injected into personalization (task 024)
    dailyCallLimit: number,              // default 20
    dailySmsLimit: number,               // default 50
    quietHours: { start: "22:00", end: "08:00", timezone: "Europe/Paris" } | null,  // outbound blocked in window
    storeTranscripts: boolean }          // task 026
  ```
- Enforcement:
  - `placeOutboundCall`: country allowlist → quiet hours (evaluate in policy timezone) → daily cap (count today's outbound `calls`) → approval per mode (`kind: "phone.call"`, summary "Call +336… about: <task>"). Executor registered so async-approved calls dial after approval.
  - `sendAgentSms`: country allowlist → daily cap → approval (`kind: "sms.send"`).
  - Violations: 403 `policy_blocked` + audit (`phone.blocked` / `sms.blocked`).
- Owner routes: `GET/PUT /api/v1/agents/:agentId/policies/phone`; audit `policy.updated`.
- E.164 → ISO country prefix mapping: implement `lib/phone-country.ts` with a static prefix table covering NANP + EU + common codes (longest-prefix match; unknown → policy decision `allowUnknownCountry: false` default deny when allowlist set).
- Web: policy editor card in the agent Phone tab (mirrors 019's email card): approval radios, country multi-select, quiet hours with timezone picker, limits, transcript toggle, inbound instructions textarea.

## Implementation steps
1. Policy schema + defaults + prefix table with tests ("+33…" → FR, "+1415…" → US, "+44…" → GB, unknown "+999" branch).
2. Enforcement wiring in both services + executor registrations; integration tests per branch incl. quiet-hours boundary (21:59 ok, 22:00 blocked, cross-midnight window).
3. Owner routes + UI card + component test.

## Acceptance criteria
- Call to a non-allowlisted country → 403 with reason naming the country; audit row.
- Quiet hours respect the policy's timezone, not server timezone (test with `Europe/Paris` vs `America/Los_Angeles` fixtures).
- Wait-mode call approval → dial happens after owner approves (integration test with fake providers).

## How to test
```bash
npm --workspace @barkan/api run test -- phone-policy
curl -s -X PUT localhost:4001/api/v1/agents/<id>/policies/phone -H "cookie: $COOKIE" -H 'content-type: application/json' \
  -d '{"allowedCountries":["FR"],"quietHours":{"start":"22:00","end":"08:00","timezone":"Europe/Paris"}}'
curl -s -X POST localhost:4001/api/v1/agent/phone/call -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"to":"+14155550123","task":"test"}'
# -> 403 policy_blocked "country US not allowed"
```
