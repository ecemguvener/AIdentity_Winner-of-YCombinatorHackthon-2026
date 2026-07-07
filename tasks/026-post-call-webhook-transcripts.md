model: fable 5

# Task 026 — Post-call webhook: transcripts, duration, summaries, metering

## Depends on
024, 025

## Context
ElevenLabs sends workspace **post-call webhooks** (`post_call_transcription` event) after each conversation ends, HMAC-signed (`ElevenLabs-Signature`, scheme already implemented in task 009's verifier), containing conversation id, status, transcript turns, analysis (summary), and metadata (duration, call_sid). This replaces the interim polling from task 025.

## Objective
Finalize every call (inbound + outbound) from the webhook: transcript, duration, cost, summary, owner notification, usage metering.

## Spec
- `POST /webhooks/elevenlabs/post-call` (framework 009):
  1. Match `calls` row by `elevenLabsConversationId`, else by `dynamic_variables.barkan_call_id` from the payload, else by `metadata.call_sid` → unmatched: event `skipped` + audit.
  2. Update row: `status: "completed"|"failed"|"no_answer"` (map provider statuses), `durationSecs`, `transcript` (map turns → `{role, message, timeInCallSecs}`), `summary` (use provider analysis summary when present, else OpenAI summarization fallback of the transcript, else first agent line), `costCents` (duration-based estimate: env `CALL_COST_CENTS_PER_MINUTE`, default 15, ceil per started minute).
  3. Audit `phone.call.outbound`/`inbound` completion with duration + summary snippet.
  4. Usage event `call_minutes` (ceil minutes) — hook no-ops until task 042.
  5. SSE `call.completed` to owner; if the transcript suggests a follow-up commitment (heuristic: summary contains "will call back"/"scheduled") add a dashboard notification — keep simple keyword heuristic, mark clearly.
  6. Delete task 025's interim polling path and the old `waitForPhoneCallCompletion`.
- Transcript privacy: transcripts stored under the agent's row are owner-visible and agent-readable via `GET /api/v1/agent/phone/calls/:callId`; add `policies.phone.storeTranscripts` (default true; false → store only summary + duration, discard turns).
- Docs: `docs/phone-setup.md` gains the workspace webhook configuration steps (URL, secret → `ELEVENLABS_WORKSPACE_WEBHOOK_SECRET`).

## Implementation steps
1. Build a realistic payload fixture from the ElevenLabs docs shape (conversation id, status, transcript array, analysis.transcript_summary, metadata.call_duration_secs, phone_call metadata) — keep it in `apps/api/src/webhooks/__fixtures__/`.
2. Handler + status mapping + matching-order tests (conversation id, barkan_call_id fallback, call_sid fallback, unmatched skip).
3. `storeTranscripts=false` branch test; cost computation edge cases (0s, 59s, 61s).
4. Live E2E: outbound drill from task 025 → hang up → row flips `completed` with real transcript within ~1min.

## Acceptance criteria
- Both directions finalize exclusively via webhook (no polling code remains; `grep -rn waitForPhoneCallCompletion apps/api/src` → nothing).
- Duplicate webhook delivery (same event id) processes once (framework guarantee — assert with test).
- Live transcript visible via agent API and (after 029) the dashboard.

## How to test
```bash
npm --workspace @barkan/api run test -- post-call
# Simulated finalize:
curl -s -X POST localhost:4001/webhooks/elevenlabs/post-call -H 'content-type: application/json' -H 'x-mock-signature: allow' \
  -d @apps/api/src/webhooks/__fixtures__/post-call-completed.json
curl -s localhost:4001/api/v1/agent/phone/calls/<callId> -H "authorization: Bearer $TOKEN" | jq '{status, durationSecs, summary, turns: (.transcript|length)}'
```
