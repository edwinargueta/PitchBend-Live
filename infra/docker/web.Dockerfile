# KeyShift web image (ARCHITECTURE.md §9 task 4, ADR 0001).
#
# Build context is the REPO ROOT, filtered by the allowlist in
# infra/docker/web.Dockerfile.dockerignore:
#   docker build -f infra/docker/web.Dockerfile --target dev  -t keyshift-web:dev .
#   docker build -f infra/docker/web.Dockerfile --target prod -t keyshift-web:prod .
#
# Targets:
#   dev    Vite dev server on 0.0.0.0:5173; all dev deps + source baked in so CI
#          can lint/test without a bind mount. Used by docker-compose.dev.yml.
#   build  runs `pnpm build` (tsc -b && vite build) -> /app/dist
#   prod   (last stage = default) nginx-unprivileged serving dist/ on 8080.
#
# No secrets: this image is public on GHCR. Nothing here takes a secret as a
# build arg, and .env files are excluded from the build context.

# ---- deps: exact pnpm + node_modules from the frozen lockfile -------------
FROM node:24.21.0-trixie-slim AS deps

# Corepack installs the exact pnpm pinned in package.json "packageManager"
# (version + sha512) into a shared location, so the non-root user can run it
# without downloading anything at runtime. pnpm 12 fetches its native binary
# on first run, so run it once here (as root) before making the cache
# world-readable.
ENV COREPACK_HOME=/usr/local/share/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm

WORKDIR /app
RUN chown node:node /app
COPY --chown=node:node apps/web/package.json apps/web/pnpm-lock.yaml ./
RUN corepack install && pnpm --version && chmod -R a+rX "$COREPACK_HOME"

# Install as the non-root user so node_modules is writable at dev time
# (Vite's dep cache, tsc build info, `pnpm add` via Compose).
# The store dir is explicit: otherwise pnpm relocates it whenever node_modules
# is on another filesystem (e.g. a Compose volume) and later `pnpm add` fails
# with ERR_PNPM_UNEXPECTED_STORE. It shares this layer with node_modules
# (hard links), so it costs almost no image size.
USER node
ENV PNPM_CONFIG_STORE_DIR=/home/node/.local/share/pnpm/store
RUN pnpm install --frozen-lockfile

# ---- dev: Vite dev server (Compose bind-mounts apps/web over /app) --------
FROM deps AS dev
COPY --chown=node:node apps/web/ ./
EXPOSE 5173
# Same as `pnpm run dev`, but the .bin shim execs node, so Vite itself is
# PID 1 and exits cleanly on SIGTERM. Via pnpm, `docker stop` hangs 10 s and
# ends in SIGKILL. Host/port come from vite.config.ts.
CMD ["/app/node_modules/.bin/vite"]

# ---- build: production bundle ----------------------------------------------
FROM dev AS build
RUN pnpm run build

# ---- prod: static files + /media via nginx (uid 101, port 8080) -----------
FROM nginxinc/nginx-unprivileged:1.30.5-alpine3.24 AS prod

# Git commit for image metadata; CI passes --build-arg GIT_SHA=<sha>. (Not a
# secret. Never pass secrets as build args.)
ARG GIT_SHA=unknown

# Also overrides labels inherited from the nginx base image (url, version,
# revision, maintainer) that would otherwise point at nginx's repo.
LABEL org.opencontainers.image.title="keyshift-web" \
      org.opencontainers.image.description="KeyShift SPA and /media static server" \
      org.opencontainers.image.source="https://github.com/edwinargueta/PitchBend-Live" \
      org.opencontainers.image.url="https://github.com/edwinargueta/PitchBend-Live" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.version="${GIT_SHA}" \
      maintainer="https://github.com/edwinargueta/PitchBend-Live"

# Drop the stock welcome/50x pages; config and site files are root-owned
# (read-only to the nginx user).
USER root
RUN rm -rf /usr/share/nginx/html/*
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=0:0 /app/dist/ /usr/share/nginx/html/
USER 101

EXPOSE 8080
