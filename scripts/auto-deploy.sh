#!/usr/bin/env bash
set -euo pipefail

# Auto-deploy watcher for claude-agent-infrastructure. Runs on the VPS HOST
# (cron/systemd timer) — deliberately NOT an agent-callable tool, and not
# running inside any container. Giving an agent the ability to trigger its
# own redeploy would mean mounting the Docker socket into its sandbox,
# which is close to host-root access for very little benefit (the deploy
# step itself needs no judgment). See docs/decisions.md.
#
# Logic: fetch, compare HEAD to the default branch, and if it moved:
# record the current commit as the rollback target, fast-forward, rebuild,
# wait for Docker's own HEALTHCHECK (Dockerfile) to report healthy, and
# roll back to the previous commit if it doesn't within the timeout.
# Posts a one-line Discord notification either way — reusing
# DISCORD_WEBHOOK_OPS from .env directly, since this script is intentionally
# standalone and has no access to the Node app's own DiscordOutbox.
#
# Quiet on the common case (nothing new to deploy): logs and notifies only
# when it actually did something, matching how retention already behaves.

cd "$(dirname "$0")/.."

HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-90}"
HEALTH_POLL_S="${HEALTH_POLL_S:-5}"

notify() {
  local text="$1"
  local webhook
  webhook=$(grep -E '^DISCORD_WEBHOOK_OPS=' .env 2>/dev/null | cut -d= -f2- || true)
  [ -n "$webhook" ] || return 0
  # $text is always one of this script's own fixed templates (only commit
  # SHAs and a small fixed set of status words get interpolated into it),
  # so plain double-quoting is safe here without a real JSON encoder.
  curl -fsS -X POST -H "Content-Type: application/json" -d "{\"content\": \"${text}\"}" "$webhook" >/dev/null || true
}

wait_for_health() {
  local elapsed=0
  local status="starting"
  local container
  container="$(docker compose ps -q supervisor)"
  while [ "$elapsed" -lt "$HEALTH_TIMEOUT_S" ]; do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || echo "starting")"
    if [ "$status" = "healthy" ] || [ "$status" = "unhealthy" ]; then
      echo "$status"
      return 0
    fi
    sleep "$HEALTH_POLL_S"
    elapsed=$((elapsed + HEALTH_POLL_S))
  done
  echo "$status"
}

git fetch origin --quiet

DEFAULT_BRANCH="$(git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@')"
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/$DEFAULT_BRANCH")"

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  exit 0
fi

echo "[auto-deploy] deploying ${REMOTE_SHA:0:7} (was ${LOCAL_SHA:0:7})"
PREVIOUS_SHA="$LOCAL_SHA"

git merge --ff-only "origin/$DEFAULT_BRANCH"
docker compose up --build -d

STATUS="$(wait_for_health)"

if [ "$STATUS" = "healthy" ]; then
  echo "[auto-deploy] ${REMOTE_SHA:0:7} is healthy"
  notify "✅ Auto-deployed \`${REMOTE_SHA:0:7}\` — healthy."
else
  echo "[auto-deploy] ${REMOTE_SHA:0:7} did not become healthy (status: $STATUS) — rolling back to ${PREVIOUS_SHA:0:7}"
  git reset --hard "$PREVIOUS_SHA"
  docker compose up --build -d
  notify "⚠️ Auto-deploy of \`${REMOTE_SHA:0:7}\` failed its health check (status: ${STATUS}) — rolled back to \`${PREVIOUS_SHA:0:7}\`."
fi
