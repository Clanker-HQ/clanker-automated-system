FROM node:24-bookworm-slim

# git and ca-certificates were added when this container was first built;
# builder (docs/superpowers/specs/2026-08-28-builder-pipeline-design.md) is
# the first agent to actually run local git commands (clone/commit/push)
# and needs outbound HTTPS to github.com — both already satisfied here.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
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

CMD ["npx", "tsx", "src/index.ts"]
