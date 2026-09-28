# syntax=docker/dockerfile:1

# ============================================================================
# care1960-prognocis-writeback — production container image
#
# Single-shot CLI batch job: reads an attested clinical record, matches the
# exact PrognoCIS patient/encounter, and writes HPI/ROS/PE narratives through
# headless Chromium via Chrome DevTools Protocol. No web server.
#
# Stage 1 (build):  installs the exact locked dependencies, installs Playwright
#                   Chromium + OS libraries, copies source/tests/fixtures, and
#                   runs the full project check (node --check + node --test)
#                   as a build gate.
# Stage 2 (runtime): minimal production image — runtime deps only, Chromium
#                   binaries + OS libraries, no package managers, non-root
#                   user. No tests, no fixtures, no example configs, no
#                   secrets, no EXPOSE.
#
# Secrets (.env), active config (config/writeback.json), and PHI-bearing
# runtime state (.runtime/) are excluded by .dockerignore and are expected to
# be supplied at run time as mounted files/volumes — never baked into layers.
# ============================================================================

# --- Stage 1: dependency install + test gate --------------------------------
FROM node:22-bookworm-slim AS build

# Browsers land in a fixed, predictable location; skip the npm-postinstall
# download and let the explicit install below do it (deterministic, one copy).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Deterministic deps from the lockfile; the npm cache is removed in the same
# layer so it never persists in the image.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --cache /tmp/npm-cache \
    && rm -rf /tmp/npm-cache

# Playwright Chromium (browser binaries + OS libraries) pinned to the exact
# version the lockfile resolved.
RUN ./node_modules/.bin/playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Source, tests, test fixtures, and the synthetic example configs the tests
# read. .dockerignore already keeps .env, config/writeback.json, and .runtime/
# out of the build context.
COPY src/ src/
COPY test/ test/
COPY test-support/ test-support/
COPY config/care1960-response.example.json config/
COPY config/writeback.example.json config/

# Build gate: syntax check + full test suite against the installed Chromium.
RUN npm run check

# --- Stage 2: production runtime --------------------------------------------
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    TZ=America/Chicago \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Timezone data so TZ=America/Chicago resolves correctly.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

# Runtime dependencies only: dotenv and playwright are both runtime deps.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --cache /tmp/npm-cache \
    && rm -rf /tmp/npm-cache

# Chromium binaries are copied from Stage 1 — byte-for-byte the same build the
# test gate ran on — instead of being downloaded a second time (one download,
# one verified browser). The OS libraries Chromium needs are still installed
# here: install-deps installs exactly the same apt package set that
# `install --with-deps` would, without downloading any browser.
COPY --from=build /ms-playwright /ms-playwright
RUN ./node_modules/.bin/playwright install-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Tested application code only — no tests, fixtures, or example configs.
COPY --from=build /app/src src/

# Container startup: resolves and launches the Playwright-installed headless
# Chromium with CDP on 127.0.0.1:9223, waits for CDP readiness, then runs the
# Node CLI and propagates its exit code.
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Run as the unprivileged base-image user; the app writes .runtime/ below
# WORKDIR and Chromium needs a writable cache path.
# /app/.runtime must exist node:node in the image: Docker initializes a fresh
# named volume at /app/.runtime (docker compose) by copying this path's
# ownership, so the non-root user stays able to write persistent browser state.
# The npm/npx/corepack binaries are removed from the final image: the runtime
# executes only node, the entrypoint, and Chromium — no package manager is ever
# invoked — so this shrinks the image and reduces attack surface.
RUN mkdir -p /app/.runtime \
    && chown -R node:node /app /ms-playwright \
    && rm -rf /usr/local/lib/node_modules/npm \
              /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm \
              /usr/local/bin/npx \
              /usr/local/bin/corepack
USER node

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Default command: probe (read-only). Chromium/CDP startup is handled by the
# entrypoint; runtime .env and config/writeback.json are supplied as mounted
# files.
CMD ["node", "src/cli.mjs"]