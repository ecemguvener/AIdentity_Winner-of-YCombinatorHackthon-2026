model: gpt 5.5

# Task 029 — Phone tab UI: number, calls, transcripts, SMS

## Depends on
011, 025, 026, 027, 028

## Context
`apps/web/src/components/PhonePanel.tsx` shows the mock phone UI. Real data now exists: `phoneNumbers`, `calls` (with transcripts/summaries), `smsMessages`. Owner-scoped mirrors needed like task 020 did for email.

## Spec
- Owner API routes (this task): `GET /api/v1/agents/:agentId/phone` (number + status), `GET .../phone/calls?cursor=`, `GET .../phone/calls/:callId`, `GET .../phone/sms?with=&cursor=`, `POST .../phone/call` + `POST .../phone/sms` (owner-initiated as the agent, `actor: "owner"` audit), policy routes exist (028).
- **Phone tab** (replace `PhonePanel.tsx`):
  - Header: agent's number formatted intl + copy, country flag, status pill; "Test call me" button (owner enters own number → outbound call drill).
  - **Calls section**: table (direction arrow, counterparty, task/summary snippet, duration, status, time) → drawer detail: full summary, transcript viewer (chat-style turns with timestamps), cost. Live update via SSE `call.started`/`call.completed`.
  - **Messages section**: conversation list by counterparty → thread view (SMS bubbles) + composer; live via `sms.received`.
  - Policy editor card (from 028).
  - Empty/provisioning states: if capability enabled but provisioning → progress row; if disabled → CTA enabling it (wired to capability endpoint).
- Delete all mock call/transcript rendering from the old panel.

## Implementation steps
1. Owner routes + ownership tests.
2. Rebuild tab: `api/phone.ts` client, calls table + transcript drawer, SMS threads, test-call modal.
3. Component tests: transcript drawer renders turns, SSE call.completed updates row status in place, SMS composer optimistic append + failure rollback.

## Acceptance criteria
- Live inbound call (phone drill) appears in the calls table within 3s of hangup with transcript.
- SMS conversation mirrors your phone thread exactly (order, direction).
- No "Simulated"/mock copy remains in the Phone tab.

## How to test
```bash
npm --workspace @barkan/web run test -- phone
# Manual with live drills from tasks 025-027: watch the tab while calling/texting the agent's number.
```
