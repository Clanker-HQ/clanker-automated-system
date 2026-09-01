#!/usr/bin/env bash
set -euo pipefail

# Deploys the products declared in deploys.yaml. Runs on the VPS HOST, called
# by auto-deploy.sh once the supervisor's own deploy has settled — and, like
# that script, deliberately NOT an agent-callable tool: triggering a deploy
# from inside a container means mounting the Docker socket, which is close to
# host-root. See docs/decisions.md ("Auto-deploy runs host-side, not
# agent-side").
#
# THE HEALTH GATE IS THE EXTERNAL PROBE BELOW, NEVER THE PRODUCT'S OWN
# HEALTHCHECK. A product's Dockerfile is written by the same agent that wrote
# the app, so `HEALTHCHECK CMD exit 0` would pass forever and a rollback
# triggered by it would be no rollback at all. Design §5.
#
# Reads caddy/deployments.tsv, which the supervisor renders from deploys.yaml
# at boot, so this script parses no YAML and starts no interpreter.

cd "$(dirname "$0")/.."

PRODUCTS_DIR="${PRODUCTS_DIR:-$PWD/../products}"
STATE_DIR="${STATE_DIR:-$PWD/.deploy-state}"
PRODUCT_ENV_FILE="${PRODUCT_ENV_FILE:-$PWD/../products.env}"
TSV="${TSV:-$PWD/caddy/deployments.tsv}"
PROBE_TIMEOUT_S="${PROBE_TIMEOUT_S:-90}"
PROBE_POLL_S="${PROBE_POLL_S:-5}"
PRODUCT_MEMORY="${PRODUCT_MEMORY:-512m}"

# No file means the supervisor has not booted since this feature shipped, or
# nothing is declared. Either way there is nothing to do and nothing to say.
[ -s "$TSV" ] || exit 0

mkdir -p "$PRODUCTS_DIR" "$STATE_DIR"

# Copied verbatim from scripts/auto-deploy.sh rather than sourced: that script
# is a standalone entry point and this one is too, and a shared helper file
# would be a third thing to keep in sync. The --data-binary "@file" form is
# there for the same reason it is there — passing UTF-8 through argv to curl is
# not reliable on every platform.
notify() {
  local text="$1"
  local webhook
  webhook=$(grep -E '^DISCORD_WEBHOOK_OPS=' .env 2>/dev/null | cut -d= -f2- || true)
  [ -n "$webhook" ] || return 0
  local payload
  payload="$(mktemp)"
  printf '{"content": "%s"}' "$text" > "$payload"
  curl -fsS -X POST -H "Content-Type: application/json" --data-binary "@${payload}" "$webhook" >/dev/null || true
  rm -f "$payload"
}

# A 2xx or 3xx at the real public URL, over the internet, through Caddy, with
# TLS verified — exactly the request a customer would make. Echoes the last
# status seen so the caller can report it.
probe() {
  local url="$1" elapsed=0 code=000
  while [ "$elapsed" -lt "$PROBE_TIMEOUT_S" ]; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)"
    case "$code" in
      2??|3??) echo "$code"; return 0 ;;
    esac
    sleep "$PROBE_POLL_S"
    elapsed=$((elapsed + PROBE_POLL_S))
  done
  echo "$code"
  return 1
}

# The memory cap and the env allowlist are applied HERE, in an override file
# this script owns, for the same reason the health gate is external: the
# product's own compose file is agent-authored, so a limit written there
# constrains nothing. Each product receives ONLY the variables its deploys.yaml
# entry declared — one product must never see another product's key.
write_overrides() {
  local slug="$1" dir="$2" names="$3"

  : > "$dir/.deploy-env"
  chmod 600 "$dir/.deploy-env"
  if [ -n "$names" ]; then
    local name
    IFS=',' read -ra requested <<< "$names"
    for name in "${requested[@]}"; do
      grep -E "^${name}=" "$PRODUCT_ENV_FILE" >> "$dir/.deploy-env" 2>/dev/null || true
    done
  fi

  cat > "$dir/.deploy-override.yml" <<EOF
services:
  $slug:
    mem_limit: $PRODUCT_MEMORY
    restart: unless-stopped
    env_file:
      - .deploy-env
EOF
}

compose_for() {
  local dir="$1" candidate
  for candidate in docker-compose.yml compose.yml; do
    if [ -f "$dir/$candidate" ]; then echo "$candidate"; return 0; fi
  done
  return 1
}

# Once, before the loop: the Caddyfile the supervisor rendered at boot already
# contains a site block for every declared hostname, so one reload makes every
# route live. Each one 502s only until its container is up, which is exactly
# what the probe below waits for.
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
  || echo "[deploy-products] caddy reload failed or caddy is not running yet"

failures=0

# Read on fd 3, not stdin: git and docker below both read stdin, and would
# otherwise swallow the rest of this file.
while IFS=$'\t' read -r slug repo hostname port envnames <&3; do
  [ -n "$slug" ] || continue

  dir="$PRODUCTS_DIR/$slug"
  good_file="$STATE_DIR/$slug.sha"

  [ -d "$dir/.git" ] || git clone --quiet "https://github.com/$repo.git" "$dir"

  git -C "$dir" fetch origin --quiet
  # Queried from the remote rather than refs/remotes/origin/HEAD, for the
  # reason auto-deploy.sh documents: that ref is only set up by `git clone` and
  # is absent on a repo assembled any other way.
  default_branch="$(git -C "$dir" ls-remote --symref origin HEAD | awk '/^ref:/ {sub("refs/heads/", "", $2); print $2}')"
  target_sha="$(git -C "$dir" rev-parse "origin/$default_branch")"
  current_sha="$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo none)"
  last_good="$(cat "$good_file" 2>/dev/null || echo none)"

  # Nothing new, and it deployed cleanly last time. Stay quiet — same posture
  # as auto-deploy.sh on a tick with nothing to do.
  if [ "$target_sha" = "$current_sha" ] && [ "$last_good" = "$target_sha" ]; then
    continue
  fi

  # Checked out BEFORE compose_for so the compose-file check (and everything
  # after it) looks at the commit actually being deployed, not whatever was
  # left checked out from the previous pass.
  git -C "$dir" checkout --quiet "$target_sha"

  if ! compose_file="$(compose_for "$dir")"; then
    echo "[deploy-products] $slug: no docker-compose.yml or compose.yml at ${target_sha:0:7}"
    notify "⚠️ \`$slug\` has no compose file at \`${target_sha:0:7}\` — not deployed."
    failures=$((failures + 1))
    continue
  fi

  echo "[deploy-products] $slug: deploying ${target_sha:0:7} (was ${current_sha:0:7})"
  write_overrides "$slug" "$dir" "$envnames"

  if ! (cd "$dir" && docker compose -p "$slug" -f "$compose_file" -f .deploy-override.yml up --build -d); then
    echo "[deploy-products] $slug: build/start failed for ${target_sha:0:7}"
    notify "⚠️ \`$slug\`: \`${target_sha:0:7}\` failed to build or start — not serving."
    failures=$((failures + 1))
    continue
  fi

  if code="$(probe "https://$hostname/")"; then
    echo "$target_sha" > "$good_file"
    echo "[deploy-products] $slug: ${target_sha:0:7} is serving (HTTP $code)"
    notify "✅ \`$slug\` deployed \`${target_sha:0:7}\` — serving at https://$hostname/ (HTTP $code)."
  else
    failures=$((failures + 1))
    if [ "$last_good" = "none" ]; then
      # Nothing to roll back to. Leaving a broken service reachable is worse
      # than leaving nothing reachable: a 502 that persists is at least honest.
      echo "[deploy-products] $slug: first deploy never served (HTTP $code) — stopping it"
      (cd "$dir" && docker compose -p "$slug" -f "$compose_file" -f .deploy-override.yml down) || true
      notify "⚠️ \`$slug\`: first deploy of \`${target_sha:0:7}\` never served (HTTP ${code}) — stopped. No previous version to roll back to."
    else
      echo "[deploy-products] $slug: ${target_sha:0:7} failed its probe (HTTP $code) — rolling back to ${last_good:0:7}"
      git -C "$dir" checkout --quiet "$last_good"
      write_overrides "$slug" "$dir" "$envnames"
      (cd "$dir" && docker compose -p "$slug" -f "$compose_file" -f .deploy-override.yml up --build -d) || true
      notify "⚠️ \`$slug\`: \`${target_sha:0:7}\` failed its health probe (HTTP ${code}) — rolled back to \`${last_good:0:7}\`."
    fi
  fi
done 3< "$TSV"

# Every deployment is attempted before this matters: one product failing must
# never stop another from deploying.
[ "$failures" -eq 0 ] || exit 1
