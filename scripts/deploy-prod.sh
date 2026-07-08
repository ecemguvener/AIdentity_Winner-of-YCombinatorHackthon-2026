#!/usr/bin/env bash
set -euo pipefail

target="production"
skip_e2e="0"
skip_migrations="0"
rollback="0"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      target="${2:-}"
      shift 2
      ;;
    --skip-e2e)
      skip_e2e="1"
      shift
      ;;
    --skip-migrations)
      skip_migrations="1"
      shift
      ;;
    --rollback)
      rollback="1"
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ "$target" != "production" ] && [ "$target" != "staging" ]; then
  echo "--target must be production or staging" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
deploy_root="${BARKAN_DEPLOY_ROOT:-/srv/barkan}"
if [ "$target" = "staging" ]; then
  deploy_root="${BARKAN_STAGING_DEPLOY_ROOT:-/srv/barkan-staging}"
fi
releases_dir="$deploy_root/releases"
current_link="$deploy_root/current"
env_file="${BARKAN_ENV_FILE:-$repo_root/.env.$target}"
pm2_app="${BARKAN_PM2_APP:-prod-barkan-api}"
health_url="${BARKAN_HEALTH_URL:-https://aidentity.space/api/health}"
if [ "$target" = "staging" ]; then
  pm2_app="${BARKAN_STAGING_PM2_APP:-staging-barkan-api}"
  health_url="${BARKAN_STAGING_HEALTH_URL:-https://aidentity.space/api/health}"
fi

log() {
  printf '[deploy:%s] %s\n' "$target" "$*"
}

run() {
  log "$*"
  "$@"
}

read_env() {
  local key="$1"
  grep -E "^${key}=" "$env_file" | tail -n 1 | cut -d= -f2- | sed -E 's/^["'\'']?(.*?)["'\'']?$/\1/'
}

load_env_file() {
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    if [ -z "$line" ] || [[ "$line" == \#* ]] || [[ "$line" != *=* ]]; then
      continue
    fi
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "$key=$value"
  done < "$env_file"
}

smoke() {
  local retries="${BARKAN_HEALTH_RETRIES:-30}"
  for attempt in $(seq 1 "$retries"); do
    if curl -fsS --max-time 3 "$health_url" >/dev/null; then
      return
    fi
    sleep 1
  done
  echo "health check failed: $health_url" >&2
  exit 1
}

prune_releases() {
  find "$releases_dir" -mindepth 1 -maxdepth 1 -type d | sort -r | tail -n +4 | xargs -r rm -rf
}

reload_pm2() {
  if pm2 describe "$pm2_app" >/dev/null 2>&1; then
    run pm2 reload "$current_link/ecosystem.config.cjs" --only "$pm2_app" --update-env
  else
    run pm2 start "$current_link/ecosystem.config.cjs" --only "$pm2_app"
  fi
  run pm2 save
}

rollback_release() {
  local current_real previous
  current_real="$(readlink -f "$current_link" 2>/dev/null || true)"
  previous="$(find "$releases_dir" -mindepth 1 -maxdepth 1 -type d | sort -r | while read -r candidate; do
    if [ "$(readlink -f "$candidate")" != "$current_real" ]; then
      printf '%s\n' "$candidate"
      break
    fi
  done)"
  if [ -z "$previous" ]; then
    echo "no previous release found" >&2
    exit 1
  fi
  run ln -sfn "$previous" "$current_link"
  reload_pm2
  smoke
  log "rolled back to $(basename "$previous")"
}

if [ "$rollback" = "1" ]; then
  rollback_release
  exit 0
fi

if [ ! -f "$env_file" ]; then
  echo "missing env file: $env_file" >&2
  exit 1
fi

run node "$repo_root/scripts/check-env.mjs" --env "$target" --file "$env_file"
export VITE_API_URL="${VITE_API_URL:-$(read_env PUBLIC_API_URL)}"
export VITE_API_PORT="${VITE_API_PORT:-}"
export PUBLIC_API_URL="${PUBLIC_API_URL:-$(read_env PUBLIC_API_URL)}"
export PUBLIC_APP_URL="${PUBLIC_APP_URL:-$(read_env PUBLIC_APP_URL)}"

run npm --prefix "$repo_root" run build
if [ "$skip_migrations" != "1" ]; then
  load_env_file
  run npm --prefix "$repo_root" run migrate
fi
if [ "$skip_e2e" != "1" ]; then
  run npm --prefix "$repo_root" run e2e
fi

release_name="$(date -u +%Y%m%d%H%M%S)"
release_dir="$releases_dir/$release_name"
run mkdir -p "$release_dir"
run rsync -a --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "test-results" \
  --exclude "playwright-report" \
  --exclude ".env*" \
  "$repo_root"/ "$release_dir"/
run cp "$env_file" "$release_dir/.env"
run npm --prefix "$release_dir" ci --omit=dev
run ln -sfn "$release_dir" "$current_link"
reload_pm2
smoke
prune_releases

log "release $(basename "$release_dir") live"
