model: gpt 5.5

# Task 057 — Demo seed: realistic showcase data on the new data model

## Depends on
All Phase 2-5 schema work (uses final collections)

## Context
`apps/api/src/seed-demo.ts` seeds the legacy shapes (sites, fake activity). Demos, screenshots (055), and local dev need a rich, *coherent* dataset on the real model — one that tells the product story in every panel without pretending mocked things are live.

## Objective
Rewritten `npm run seed:demo` producing a complete demo account against current collections, idempotently.

## Spec
- Same credentials (`demo@aidentity.test` / `demo-password` — rename to `demo@barkan.dev`, keep env overrides), `plan: "pro"` billing account (no real Stripe objects: `stripeCustomerId: "cus_demo"` clearly fake-prefixed; mock provider mode assumed).
- Three agents telling stories:
  1. **Maya — Executive assistant** (email+phone): 6 email threads (scheduling back-and-forth incl. inbound replies with summaries), 8 calls (mixed directions, transcripts, one no-answer), SMS thread with a 2FA code message, policies: quiet hours Paris, approval on new recipients.
  2. **Scout — Recruiting outreach** (email only): outreach threads, one bounce, daily-cap policy, 2 pending approvals (new recipients) — makes the bell + approvals page demo instantly.
  3. **Sentinelle — Support line** (phone only): inbound-heavy call history with transcripts and summaries, one blocked caller in audit, inbound instructions policy set — shows the inbound story.
- Usage events partially consumed vs pro quotas (email 340/500, call minutes 74/120, SMS 41/200) so billing bars look real.
- Audit: ~70 entries across email/phone/sms/approval/policy actions spanning 14 days (deterministic seeded RNG — same output every run).
- Idempotent: wipes and recreates only the demo user's data (guard: refuses on production `NODE_ENV` or non-`-prod` check inverted — refuse when db name ends in `-prod`).

## Implementation steps
1. Rewrite the script using service-layer factories where cheap, direct inserts where services would hit providers.
2. Deterministic RNG helper; date spread relative to now.
3. `seed-demo.test.ts`: runs twice on memory Mongo → stable counts, no dupes; production guard test.
4. Screenshot pass for 055's image slots after seeding (coordinate in PR).

## Acceptance criteria
- Login to demo account: every page (agents, approvals, email, phone, billing, audit) is visibly populated and coherent (usage bars match seeded events).
- Re-running the seed converges (no growth).
- Guard refuses against a `-prod` database.

## How to test
```bash
npm run seed:demo && npm run seed:demo
mongosh barkan --eval 'db.agents.countDocuments({}), db.usageEvents.countDocuments({})'
# Login and walk all tabs; verify usage bars match seeded events.
```
