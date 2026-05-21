# Lean image for the Omni Code Launcher **server** (control plane).
#
# This is NOT a sandbox image — it deliberately does not bundle devtools,
# code-server, VNC, postgres-server, etc. (those live in the devbox sandbox
# image, sandbox-image/). It contains just: Node + the built server bundle +
# its runtime deps, plus the `omni-code` CLI so the server can drive agents.
#
# Build:
#   docker build -t <acr>.azurecr.io/omni-launcher:latest .
# Private omni-code index needs a token:
#   docker build --build-arg OMNI_PIP_INDEX="https://<token>@pypi.fury.io/ericmichael/" .
# Verify the Node runtime without the private index:
#   docker build --build-arg INSTALL_OMNI_CODE=false -t omni-launcher:local .

# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage — full deps, native rebuild for the Node ABI, bundle the server.
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS build
WORKDIR /app

# Toolchain for node-pty's native build.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install deps with the workspace manifests present, but skip the Electron-
# oriented postinstall (electron-rebuild against Electron's ABI + the sandbox
# binary download — neither applies to the server). We rebuild node-pty for the
# Node ABI explicitly below.
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts
RUN npm rebuild node-pty

# Source + build the server bundle and browser SPA (build:packages runs first).
# Raise the V8 heap — the browser SPA build (large bundle + sourcemaps) otherwise
# aborts with "heap out of memory" (exit 134) on the default limit.
COPY . .
RUN NODE_OPTIONS="--max-old-space-size=6144" npm run build:server

# Shed dev dependencies; the rebuilt node-pty (a prod dep) is kept.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Runtime stage — slim; same Node major (ABI-compatible node-pty), prod deps.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

# TLS roots (outbound to Azure ARM / login) + git (workspace ops).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# The `omni-code` CLI (the agent runtime the server drives), published on the
# (public) Gemfury index. Set INSTALL_OMNI_CODE=false for a Node-only image.
#
# The `sandbox-aci` extra (azure-identity / azure-mgmt-containerinstance /
# websockets) is injected separately: `omni-code` → `omniagents[all]`, and
# `[all]` does NOT include `sandbox-aci`, so without this the agent's
# `client.type: aci` would fail at sandbox-create. (Fold sandbox-aci into
# omniagents' `[all]` extra in a future release to drop this inject.)
ARG INSTALL_OMNI_CODE=true
ARG OMNI_PIP_INDEX="https://pypi.fury.io/ericmichael/"
# Pin exact versions: keeps the cloud image reproducible AND busts this RUN
# layer's cache when bumped (an unpinned `pipx install` would otherwise reuse a
# stale cached install on rebuilds). Bump in lockstep with the published pkgs.
ARG OMNI_CODE_VERSION=0.6.1
ARG OMNIAGENTS_VERSION=0.7.1
# Some omni-code deps (e.g. pygit2) lack wheels for this platform and compile
# from source, so a C toolchain + the relevant -dev headers are needed at
# install time. Runtime shared libs (libgit2, libffi, …) are pulled in by the
# -dev packages and kept so the compiled extensions load.
RUN if [ "$INSTALL_OMNI_CODE" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends \
           python3 python3-venv python3-dev pipx \
           build-essential pkg-config \
           libffi-dev libssl-dev libgit2-dev libxml2-dev libxslt1-dev libsqlcipher-dev \
      && rm -rf /var/lib/apt/lists/* \
      && PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin \
         pipx install "omni-code==${OMNI_CODE_VERSION}" --pip-args="--extra-index-url ${OMNI_PIP_INDEX}" \
      && PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin \
         pipx inject omni-code "omniagents[sandbox-aci]==${OMNIAGENTS_VERSION}" --pip-args="--extra-index-url ${OMNI_PIP_INDEX}"; \
    fi

COPY --from=build /app/out ./out
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/assets ./assets

EXPOSE 3001
CMD ["node", "out/server/index.mjs"]
