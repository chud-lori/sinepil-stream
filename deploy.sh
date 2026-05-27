#!/usr/bin/env bash
# SinepilStream — deploy script
# Usage: bash deploy.sh
# Pulls latest code, rebuilds the Docker image, and restarts the container.

set -euo pipefail
cd "$(dirname "$0")"

APP="sinepilstream"
PORT="${PORT:-3500}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GREEN}>>>${NC} $*"; }
warn() { echo -e "${YELLOW}>>>${NC} $*"; }
die()  { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found"

info "Pulling latest code…"
git pull origin main

info "Building new image…"
docker compose build --no-cache

info "Restarting container…"
docker compose up -d --force-recreate

# Canary scrape — verify the new container can actually resolve a player.
# Catches upstream rotations (CDN URL, obfuscation, host) at deploy time
# instead of in production. Skipped when MAINTENANCE_MODE=1 because the
# maintenance middleware returns 503 for /api/* (expected).
CANARY_SLUG="${CANARY_SLUG:-180-2026}"
MAINT="$(grep -E '^\s*-\s*MAINTENANCE_MODE=' docker-compose.yml | grep -oE '=[01]' | tr -d '=')"
if [ "${MAINT:-0}" = "1" ]; then
  warn "MAINTENANCE_MODE=1 — skipping canary scrape."
else
  info "Waiting for app to accept requests…"
  for i in $(seq 1 30); do
    curl -fsS -o /dev/null --max-time 2 "http://localhost:${PORT}/api/home" && break
    sleep 1
    [ "$i" = "30" ] && die "App didn't respond on :${PORT} within 30s. Check 'docker compose logs'."
  done

  # Flush the SQLite response cache — entries from the previous container are
  # otherwise served verbatim for up to 30 min, masking shape-changing fixes
  # (e.g. token-resolution URL format changes) until they age out. Safe by
  # construction: response_cache is a dedicated cache table; user data (sync
  # pair codes, watch history, catalog) lives in separate tables.
  info "Flushing response cache…"
  docker compose exec -T "${APP}" node -e \
    "require('better-sqlite3')('/app/data/movies.db').exec(\"DELETE FROM response_cache\"); console.log('[cache] flushed')" \
    || warn "Cache flush failed — continuing; entries will expire naturally within 30 min."

  info "Canary scrape: GET /api/movie/${CANARY_SLUG}…"
  resp="$(curl -fsS --max-time 40 "http://localhost:${PORT}/api/movie/${CANARY_SLUG}" || true)"
  if echo "$resp" | grep -q '"finalUrl":"http'; then
    info "Canary OK — at least one player resolved."
  else
    echo "$resp" | head -c 500 >&2
    echo >&2
    die "Canary FAILED — no resolved player URLs. Upstream may have rotated. Check 'docker compose logs sinepilstream' and consider flipping MAINTENANCE_MODE=1."
  fi
fi

info "Done."
docker compose ps
