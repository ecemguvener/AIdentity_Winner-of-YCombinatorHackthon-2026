# Privacy Operations

## Data Inventory

| Collection | Contains | Retention | Deletion path |
| --- | --- | --- | --- |
| `users` | Owner email, profile, password hash, notification settings | Active account lifetime; deleted-account tombstone `{deletedAt,emailHash}` for 30 days | `DELETE /api/v1/account` tombstones, retention purges after hold |
| `sessions` | HTTP-only session hashes | 30 day absolute, 7 day idle | Logout/account deletion deletes |
| `agents`, `identityTokens` | Agent profile, capability flags, token metadata/hashes | Active account lifetime | Account deletion revokes then hard-deletes |
| `auditLogs` | Trust/security trail of owner/agent actions | 2 years | Retention sweep deletes after 730 days |
| `emailAccounts`, `emailThreads`, `emailMessages` | Agent email address, counterparties, subjects, bodies | Bodies stripped after 365 days; envelopes retained for account lifetime | Account deletion hard-deletes |
| `phoneNumbers`, `calls`, `smsMessages` | Phone number metadata, call/SMS history, transcripts | Call transcripts stripped after 180 days; summaries/duration retained | Account deletion releases phone number then hard-deletes |
| `approvals`, `pairingRequests` | Pending decisions and pairing secrets | Expired payload/secrets stripped after 90 days | Account deletion hard-deletes |
| `billingAccounts`, `usageEvents`, `usageReports` | Stripe customer/subscription metadata and metered usage | Reported usage deleted after 400 days | Account deletion cancels/deletes Stripe customer then hard-deletes local rows |
| `webhookEvents` | Provider delivery ids/status/errors | 90 days | Retention sweep deletes |
| `accountExports` | Export job status, one-time token hash, archive path | Download links expire after 72 hours | Account deletion and export expiry cleanup |
| `opsStatus` | Platform backup/retention/deletion markers | Operational lifetime | Manual pruning after incident/audit needs expire |

## Owner Rights

- Export: `POST /api/v1/account/export` builds a ZIP with JSON files and `export-manifest.json`; the signed download URL expires after 72 hours and can be used once.
- Deletion: `DELETE /api/v1/account` requires password reconfirmation and `confirm: "DELETE"`. It revokes tokens, pauses email, releases phone numbers, cancels Stripe subscription/customer when configured, hard-deletes owner-scoped rows, then leaves a 30 day tombstone hash to slow immediate re-registration abuse.
- Retention: `runRetentionSweep` is scheduled daily outside tests and records `opsStatus.retention.daily`.

## Subprocessors

| Provider | Purpose |
| --- | --- |
| Stripe | SaaS billing, invoices, subscriptions, customer metadata |
| Twilio | Phone numbers, SMS, call routing |
| ElevenLabs | Voice-agent phone calls and call webhooks |
| Resend | Agent email send/receive and platform notifications |
| OpenAI | Dashboard chat and email drafting/summarization when configured |
| Sentry | Error tracking with request/user/agent context, scrubbed of PII |
| Mongo host | Primary application database and backups |
