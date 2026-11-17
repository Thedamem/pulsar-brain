# Pulsar Brain — Home Assistant app image.
#
# The Supervisor builds this file with the app folder (addon/) as the build
# context, so every COPY path is relative to addon/.
#
# Stages:
#   backend  — TypeScript compiler, emits dist/src/index.js (tsconfig rootDir ".")
#   web      — Vite SPA, emits web/dist
#   runtime  — production dependencies + both build artifacts, no toolchain
#
# The container runs as root on purpose: the Supervisor mounts /data owned by
# root and the app writes config.json, master.key and SQLite files there. A
# non-root user would need the mount ownership changed outside the image.

# Docker Hub is blocked from some networks (for example, residential ISPs in Russia) while
# the Supervisor builds this image on the user's device. Pull Node from a public mirror by
# default; override with --build-arg NODE_IMAGE=node:22-bookworm-slim where Docker Hub works.
ARG NODE_IMAGE=mirror.gcr.io/library/node:22-bookworm-slim

# ─────────────────────────────────────────────────────────── backend ──
FROM ${NODE_IMAGE} AS backend

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─────────────────────────────────────────────────────────────── web ──
FROM ${NODE_IMAGE} AS web

WORKDIR /app

COPY web/package.json web/package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY web ./
# The SPA lives at addon/web in the repository and imports ../../../src/shared,
# which resolves to addon/src/shared there. In this stage the SPA is copied to
# /app, so the same relative import resolves to /src/shared; provide both paths.
COPY src/shared ./src/shared
COPY src/shared /src/shared
RUN npm run build

# ─────────────────────────────────────────────────────────── runtime ──
FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.source="https://github.com/Thedamem/pulsar-brain" \
      org.opencontainers.image.title="Pulsar Brain" \
      org.opencontainers.image.description="Voice assistant brain for Yandex Station speakers running pulsar firmware: STT, LLM, tools, MCP, scheduler and web UI behind a Home Assistant app" \
      org.opencontainers.image.licenses="LicenseRef-Proprietary"

WORKDIR /app

# The compiled server resolves ../../web/dist relative to dist/src/server
# (i.e. /app/dist/web/dist), so point it at the web stage artifact explicitly.
ENV NODE_ENV=production \
    PULSAR_BRAIN_DATA_DIR=/data \
    PULSAR_BRAIN_PORT=8097 \
    PULSAR_BRAIN_WEB_DIR=/app/web/dist

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --from=backend /app/dist ./dist
COPY --from=web /app/dist ./web/dist

EXPOSE 8097

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8097/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
