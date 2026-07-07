model: fable 5

# Task 025 — Outbound calls: agent-initiated real phone calls

## Depends on
023, 024

## Context
`apps/api/src/phone.ts` already places real ElevenLabs outbound calls (`POST /v1/convai/twilio/outbound-call`) but from ONE globally configured number (`ELEVENLABS_AGENT_PHONE_NUMBER_ID`), with mock fallback, and `identity.ts`'s `/api/tools/phone/call` returns a canned fake transcript. Now every agent has its own number (023) and calls must persist (`calls` collection).

## Objective
Rewrite outbound calling per-agent: real calls from the agent's own number, persisted lifecycle, no fake transcripts anywhere.

## Spec
- Rework `phone.ts` → `apps/api/src/phone-service.ts`:
  - `placeOutboundCall(collections, config, { agent, toNumber, task, context?, recipientName? }) -> { callId, status }`:
    1. Resolve agent's active `phoneNumbers` row (none → 409 `policy_blocked` "phone capability not provisioned").
    2. Insert `calls` row (`direction: "outbound"`, `status: "queued"`, task).
    3. Call ElevenLabs outbound API with the agent's `elevenLabsPhoneNumberId` + `dynamic_variables` (same set as 024 + `task`, `recipient_name`, `call_opening` built from the existing `buildPersonalAssistantCallBrief` logic — keep it, it's good) + `barkan_call_id`.
    4. Update row with `elevenLabsConversationId`, `status: "ringing"`. Completion/transcript arrives via post-call webhook (task 026) — **delete the polling `waitForPhoneCallCompletion` path** once 026 lands; this task keeps a bounded poll (max 3min) as interim and marks it `// INTERIM until task 026`.
  - Mock mode: no network; row goes `queued → completed` after 2s timer with transcript `[{role:"agent", message:"[mock] Called <to> about: <task>"}]` — clearly labeled mock, only under `PROVIDER_MODE_PHONE=mock`.
- Bearer routes: rewrite `POST /api/tools/phone/call` (compat: accepts `{to, script|task}`) and add `POST /api/v1/agent/phone/call { to, task, context?, recipientName? }` → both through the service. Response: `{ call_id, status, from, to }` — no transcript at initiation (it doesn't exist yet; agents fetch it later).
- `GET /api/v1/agent/phone/calls?cursor=` and `GET /api/v1/agent/phone/calls/:callId` (status, duration, transcript when available, summary).
- Delete the canned-transcript block in `identity.ts` (`/api/tools/phone/call` handler) — it is the biggest lie in the demo.
- `dashboard-chat.ts` `place_phone_call` tool → service; call events (started/completed) keep flowing to the chat stream, completion now driven by DB status (poll rows, or subscribe to the 026 event bus).

## Implementation steps
1. Service + routes + mock timer; migrate call-brief helpers; unit tests (no number 409, request shape to ElevenLabs, mock lifecycle).
2. Excise fake transcripts from `identity.ts`; update its tests.
3. Rewire dashboard chat tool; keep its SSE call events working (existing `dashboard-chat.test.ts` must stay green after rewiring).
4. Live drill: agent calls your cell; you answer; conversation happens; row shows `in_progress` (webhook task will finalize).

## Acceptance criteria
- Outbound call placed from the agent's own E.164 (caller ID on your phone matches the agent's number — verify in live drill).
- `calls` rows track queued → ringing → in_progress; zero canned transcripts in code (`grep -rn "Prospect:" apps/api/src` → nothing).
- Dashboard chat can still place a call end-to-end (mock and live).

## How to test
```bash
npm --workspace @barkan/api run test -- phone-service
curl -s -X POST localhost:4001/api/v1/agent/phone/call -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"to":"+33612345678","task":"Confirm dinner reservation for two at 8pm"}' | jq .
curl -s localhost:4001/api/v1/agent/phone/calls -H "authorization: Bearer $TOKEN" | jq '.calls[0].status'
```
