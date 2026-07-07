model: gpt 5.5

# Task 054 — Backups, data retention, account deletion (GDPR)

## Depends on
052

## Context
EU-based product (Paris) holding personal data: emails, call transcripts, SMS, billing metadata. Legal minimum: backups that restore, retention limits, full export, and real deletion.

## Objective
Automated backups with tested restore, retention policies, and self-serve export/delete.

## Spec
- **Backups**: `scripts/backup-mongo.sh` — `mongodump --archive --gzip` to `BACKUP_DIR` with timestamp, retain 7 daily + 4 weekly (prune logic), optional S3/B2 upload via rclone when `BACKUP_REMOTE` set; cron entry documented (03:00 daily). `scripts/restore-mongo.sh <archive> --target <db>` restores to a *separate* db name by default (safety). Monthly restore-verification note in runbook (053 alert if backup status doc stale > 26h — script writes completion marker to a `opsStatus` collection).
- **Retention** (sweeper job, daily, per-collection window env-tunable):
  - call transcripts > 180d → strip `transcript`, keep summary/duration (unless `policies.phone.storeTranscripts=false` already stripped)
  - email message bodies > 365d → strip bodies, keep envelope/subject
  - `webhookEvents` > 90d, `usageEvents` reported > 400d, expired `pairingRequests`/`approvals` payloads > 90d (keep decision metadata)
  - `auditLogs` kept 2y (trust product — document why)
- **Export**: `POST /api/v1/account/export` (session; rate-limit 1/day) → async job builds zip (JSON per collection scoped to owner: profile, agents, tokens metadata, audit, email envelopes+bodies, calls, sms, billing, usage) → stored 72h → notification email with download link (signed one-time URL route). Include `export-manifest.json` (counts + generation date).
- **Deletion**: `DELETE /api/v1/account` (session + password reconfirm + typed confirm) → immediate: revoke tokens, release phone numbers, pause email; then hard-delete owner-scoped documents + Stripe customer deletion + Twilio/Resend teardown; `users` row replaced by tombstone `{deletedAt, emailHash}` (30d, then purged) to prevent immediate re-registration abuse. Cancel active subscription (`stripe.subscriptions.cancel`). Written as a queued job with step checkpoints (resume on crash); audit trail to a platform-level `opsStatus` log since user audit dies with them.
- `docs/privacy-operations.md`: data inventory table (collection → contains → retention → deletion path), subprocessor list (Stripe, Twilio, ElevenLabs, Resend, OpenAI, Sentry, Mongo host).

## Implementation steps
1. Backup/restore scripts + completion markers + prune tests (pure function on filename lists).
2. Retention sweeper + tests with seeded old docs (strip vs delete per rules).
3. Export job + signed URL + tests (scoping: no foreign rows in zip — reuse IDOR fixtures).
4. Deletion job with provider teardown via existing deprovisioners + tests (mock providers; checkpoint resume test: kill after step 2, rerun completes).

## Acceptance criteria
- Backup → restore drill on dev data: restored db passes a row-count + spot-check script.
- Deleted account: all owner-scoped collections empty (walker test), providers called for teardown, login impossible, re-signup with same email blocked 30d then allowed (fake clock).
- Export zip opens, manifest counts match DB.

## How to test
```bash
bash scripts/backup-mongo.sh && bash scripts/restore-mongo.sh backups/<latest> --target barkan-restore-test
npm --workspace @barkan/api run test -- retention export account-deletion
# Manual: create throwaway account with one agent -> export -> delete -> verify.
```
