model: fable 5

# Task 018 — Inbound email: receive real mail for every agent address

## Depends on
015, 017

## Context
Receiving is what makes the identity real — people and services reply to the agent. Resend delivers `email.received` webhooks for any address at the receiving domain; the webhook carries **metadata only** (from, to, subject, `email_id`, attachment metadata) — the body must be fetched via Resend's Received-emails API, attachments via the Attachments API. Legacy `email.ts#ingestInboundReply` did in-memory matching.

## Objective
Full inbound pipeline: webhook → fetch content → route to agent → thread → store → notify owner + surface to the agent.

## Spec
- Extend `/webhooks/resend` (task 015) to handle `email.received`:
  1. Framework dedupes by event id (task 009).
  2. Fetch full content by `data.email_id` through a `ResendInboundClient` (injectable): text, html, headers (`message-id`, `in-reply-to`, `references`).
  3. Recipient resolution: for each of `to` + `cc` + `received_for`, lowercase and look up `emailAccounts`; first active match wins; no match → mark event `skipped` (audit `email.receive.unrouted`, keep for ops).
  4. Thread matching order: `in-reply-to`/`references` ↔ `emailMessages.providerMessageId` → else `{agentId, counterpartyEmail: from}` open thread → else new thread.
  5. Insert `emailMessages { direction: "inbound", status: "received", attachments: metadata }`; bump thread `lastMessageAt/messageCount`.
  6. Post-ingest hooks: audit `email.receive`; OpenAI summary + suggested reply (port `summarizeReply` from legacy code, `OPENAI_EMAIL_MODEL`, heuristic fallback) stored on the message `{summary, suggestedReply}`; SSE event `email.received` to the owner dashboard (reuse task 013 bus, add event type); usage hook.
- Agent-facing read APIs (bearer):
  - `GET /api/v1/agent/email/threads?cursor=` — id, counterparty, subject, lastMessageAt, unread count
  - `GET /api/v1/agent/email/threads/:threadId` — messages chronological (bodies included, attachments as metadata + `GET .../attachments/:id` proxy streaming from Resend with auth)
  - `POST /api/v1/agent/email/threads/:threadId/reply { text }` — thread-preserving send via task 017 service with `In-Reply-To`/`References` headers set from the last inbound message
- Attachment safety: proxy route enforces 25MB cap and content-type passthrough; no execution, `content-disposition: attachment`.
- Delete remaining in-memory inbound maps and `EmailReplyNotification` store from legacy `email.ts`; the whole file should now be dead → remove it, moving still-used drafting helpers into `email-service.ts`/`email-ai.ts`.

## Implementation steps
1. Inbound client + webhook handler with fixtures (Resend sample payload from docs; body-fetch mocked).
2. Thread-matching unit tests: reply chain via message-id headers, fallback counterparty match, brand-new sender, multi-recipient (to + cc), unrouted.
3. Read APIs + reply route + tests (ownership: token A cannot read agent B threads).
4. Live E2E: tunnel + real reply from a personal inbox.

## Acceptance criteria
- Real-world flow proven: agent sends (017) → human replies from Gmail → within seconds thread shows the inbound message; reply from the agent lands back in Gmail **in the same Gmail conversation** (headers correct).
- Unknown-address mail is skipped with audit, not 500.
- `email.ts` legacy file removed; no in-memory email state anywhere (`grep -n "new Map" apps/api/src/email*` → nothing).

## How to test
```bash
npm --workspace @barkan/api run test -- inbound-email
# Live E2E (domain + webhook + tunnel configured):
curl -s -X POST localhost:4001/api/v1/agent/email/send -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"to":"you@gmail.com","subject":"Ping","text":"Reply to me"}'
# Reply from Gmail, then:
curl -s localhost:4001/api/v1/agent/email/threads -H "authorization: Bearer $TOKEN" | jq '.threads[0]'
curl -s localhost:4001/api/v1/agent/email/threads/<threadId> -H "authorization: Bearer $TOKEN" | jq '.messages[-1].direction'   # -> "inbound"
```
