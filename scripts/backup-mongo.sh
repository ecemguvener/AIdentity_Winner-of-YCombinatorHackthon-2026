#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
MONGODB_URI="${MONGODB_URI:-mongodb://127.0.0.1:27017/barkan}"
TIMESTAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
ARCHIVE="$BACKUP_DIR/barkan-$TIMESTAMP.archive.gz"

mkdir -p "$BACKUP_DIR"
mongodump --uri="$MONGODB_URI" --archive="$ARCHIVE" --gzip

if command -v mongosh >/dev/null 2>&1; then
  mongosh "$MONGODB_URI" --quiet --eval '
    db.opsStatus.updateOne(
      { key: "backup.mongo" },
      {
        $set: {
          kind: "backup",
          status: "ok",
          message: "mongodump completed",
          data: { archive: "'"$ARCHIVE"'" },
          completedAt: new Date(),
          updatedAt: new Date()
        },
        $setOnInsert: { _id: ObjectId(), createdAt: new Date() }
      },
      { upsert: true }
    )
  ' >/dev/null
fi

mapfile -t archives < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'barkan-*.archive.gz' | sort -r)
if ((${#archives[@]} > 11)); then
  printf '%s\n' "${archives[@]:11}" | xargs -r rm -f
fi

if [[ -n "${BACKUP_REMOTE:-}" ]]; then
  rclone copy "$ARCHIVE" "$BACKUP_REMOTE"
fi

echo "$ARCHIVE"
