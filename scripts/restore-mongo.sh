#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <archive> --target <db-name>" >&2
  exit 2
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

ARCHIVE="${1:-}"
[[ -n "$ARCHIVE" ]] || usage
shift

TARGET_DB=""
while (($#)); do
  case "$1" in
    --target)
      TARGET_DB="${2:-}"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[[ -n "$TARGET_DB" ]] || usage
if [[ "$TARGET_DB" =~ prod$ || "$TARGET_DB" == "barkan" ]]; then
  echo "refusing to restore into production/default db '$TARGET_DB'" >&2
  exit 1
fi

MONGODB_URI="${MONGODB_URI:-mongodb://127.0.0.1:27017/barkan}"
SOURCE_DB="${SOURCE_DB:-$(node -e 'const uri=process.argv[1]; const path=new URL(uri).pathname.replace(/^\\//,""); console.log(path || "barkan")' "$MONGODB_URI")}"

mongorestore --uri="$MONGODB_URI" --archive="$ARCHIVE" --gzip --drop --nsFrom="$SOURCE_DB.*" --nsTo="$TARGET_DB.*"
echo "restored $ARCHIVE into $TARGET_DB"
