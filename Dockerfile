FROM node:24-bookworm-slim

# git and ca-certificates were added when this container was first built;
# builder is the first agent to actually run local git commands
# (clone/commit/push) and needs outbound HTTPS to github.com — both already
# satisfied here. curl backs the HEALTHCHECK below, consulted by
# scripts/auto-deploy.sh (host-side, not agent-side — see docs/decisions.md)
# to decide whether a deploy needs rolling back.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
ENV APP_ROOT=/app
ENV DATA_DIR=/app/data

# Liveness only (does the process have its HTTP server up), not a deep
# correctness check — the webhook receiver accepts any request on any path
# regardless of status code, so this just confirms something is listening.
# No -f: a 401 (unsigned request) is a live server responding correctly,
# not a failure; only a connection error should fail this check.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -sS -o /dev/null "http://localhost:${WEBHOOK_PORT:-8787}/" || exit 1

CMD ["npx", "tsx", "src/index.ts"]
