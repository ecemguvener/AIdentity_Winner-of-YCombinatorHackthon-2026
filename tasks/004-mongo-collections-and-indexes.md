model: fable 5

# Task 004 — MongoDB schema: all production collections, types, and indexes

## Depends on
003

## Context
`apps/api/src/db.ts` defines `users`, `sessions`, `sites`, `apiKeys`, `atlasProjects`, `interactionLogs`. Everything else the product needs (identities, audit, email, phone, payments, billing, approvals, webhooks) currently lives in in-memory `Map`s inside `identity.ts`, `email.ts`, `payments.ts` and evaporates on restart. This task defines the full persistent data model that every later task builds on. Get this right — later tasks reference these exact names.

## Objective
Extend `db.ts` with typed interfaces, collections, and indexes for the entire product. No route changes yet.

## Spec — new collections (all include `createdAt`; `updatedAt` where mutable)

```ts
agents            { _id, ownerUserId, name, slug, status: "provisioning"|"active"|"paused"|"revoked",
                    description?, runtime?: "openclaw"|"hermes"|"api"|"other",
                    capabilities: { email: boolean, phone: boolean },   // card capability deferred ("coming soon")
                    approvalMode: "always"|"policy"|"autonomous" }
identityTokens    { _id, agentId, ownerUserId, tokenHash, prefix, name, status: "active"|"revoked",
                    lastUsedAt?, expiresAt? }
auditLogs         { _id, agentId, ownerUserId, actor: "agent"|"owner"|"system",
                    action, status: "allowed"|"blocked"|"pending"|"error", detail,
                    resourceType?, resourceId?, metadata? }
approvals         { _id, agentId, ownerUserId, kind: "email.send"|"phone.call"|"sms.send",
                    status: "pending"|"approved"|"rejected"|"expired",
                    payloadSummary: string, payload: object, decisionNote?, decidedAt?, expiresAt }
emailAccounts     { _id, agentId, address (unique), displayName, status: "active"|"paused" }
emailThreads      { _id, agentId, subject, counterpartyEmail, lastMessageAt, messageCount }
emailMessages     { _id, agentId, threadId, direction: "inbound"|"outbound",
                    fromEmail, toEmail, cc?, subject, textBody, htmlBody?,
                    providerMessageId?, status: "queued"|"sent"|"delivered"|"bounced"|"received"|"failed",
                    attachments?: [{ filename, contentType, sizeBytes, providerAttachmentId? }] }
phoneNumbers      { _id, agentId, e164 (unique), country, twilioSid, elevenLabsPhoneNumberId?,
                    capabilitiesVoice: boolean, capabilitiesSms: boolean,
                    status: "provisioning"|"active"|"releasing"|"released", monthlyPriceCents? }
calls             { _id, agentId, phoneNumberId, direction: "inbound"|"outbound",
                    counterpartyE164, task?, status: "queued"|"ringing"|"in_progress"|"completed"|"failed"|"no_answer",
                    providerCallId?, elevenLabsConversationId?, durationSecs?, transcript?: [{role, message, timeInCallSecs}],
                    summary?, costCents? }
smsMessages       { _id, agentId, phoneNumberId, direction, counterpartyE164, body,
                    twilioMessageSid?, status: "queued"|"sent"|"delivered"|"received"|"failed" }
policies          { _id, agentId (unique), email: {...}, phone: {...} }  // shapes defined in tasks 019/028
webhookEvents    { _id, provider: "stripe"|"twilio"|"resend"|"elevenlabs", providerEventId (unique per provider),
                    eventType, payloadHash, status: "received"|"processed"|"failed"|"skipped", error?, processedAt? }
billingAccounts   { _id, ownerUserId (unique), stripeCustomerId, plan: "free"|"pro"|"scale",
                    subscriptionId?, subscriptionStatus?, currentPeriodEnd? }
usageEvents       { _id, ownerUserId, agentId, meter: "call_minutes"|"sms_messages"|"emails_sent"|"active_numbers",
                    quantity, stripeReported: boolean, periodKey }
```

## Indexes (create in `connectDatabase`, mirroring the existing pattern)
- `agents`: `{ownerUserId:1}`, `{slug:1, ownerUserId:1}` unique
- `identityTokens`: `{tokenHash:1}` unique, `{agentId:1}`
- `auditLogs`: `{agentId:1, createdAt:-1}`, `{ownerUserId:1, createdAt:-1}`
- `approvals`: `{ownerUserId:1, status:1, createdAt:-1}`, `{expiresAt:1}` TTL only if you also handle status flip in code (do NOT let TTL delete rows; instead a periodic job expires them — no TTL index here)
- `emailAccounts`: `{address:1}` unique; `emailThreads`: `{agentId:1, lastMessageAt:-1}`, `{agentId:1, counterpartyEmail:1}`; `emailMessages`: `{threadId:1, createdAt:1}`, `{agentId:1, createdAt:-1}`, `{providerMessageId:1}` sparse
- `phoneNumbers`: `{e164:1}` unique, `{agentId:1}`; `calls`: `{agentId:1, createdAt:-1}`, `{elevenLabsConversationId:1}` sparse; `smsMessages`: `{agentId:1, createdAt:-1}`, `{twilioMessageSid:1}` sparse unique
- `webhookEvents`: `{provider:1, providerEventId:1}` unique
- `usageEvents`: `{ownerUserId:1, periodKey:1, meter:1}`

## Implementation steps
1. Add all interfaces + `Collections` entries + index creation in `apps/api/src/db.ts`. Keep legacy collections untouched (migration is task 005).
2. Add `apps/api/src/db.test.ts` using `mongodb-memory-server` (add as devDependency): boots, creates indexes, asserts uniqueness constraints fire (duplicate `identityTokens.tokenHash` insert rejects, etc.).
3. Document each collection with a one-line comment.

## Acceptance criteria
- `connectDatabase` creates every collection's indexes idempotently (run twice in test — no error).
- Type exports compile under strict TS; no `any`.

## How to test
```bash
npm --workspace @barkan/api i -D mongodb-memory-server
npm --workspace @barkan/api run test -- db.test.ts
npm --workspace @barkan/api run build
```
