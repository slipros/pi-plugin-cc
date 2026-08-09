# Sandbox image for pi runs started by the pi plugin for Claude Code.
#
# The whole pi process runs in here: built-in tools, `!` commands and extensions
# all execute inside the container, and only the workspace is bind mounted back
# to the host. Build it with `pi-companion.mjs sandbox build`.

ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ARG PI_VERSION=latest

# The LSP adapter is baked in rather than fetched per run: the agent directory
# is a volume, so an `npm:` extension would be downloaded again on every fresh
# one, and a sandbox with no network could not load it at all. The language
# server itself is not installed here — a profile bind mounts the host's
# (gopls, rust-analyzer), which are static binaries and run as they are.
ARG PI_LSP_ADAPTER_VERSION=0.1.3

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git less make ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}"

RUN npm install -g --ignore-scripts "pi-lsp-adapter@${PI_LSP_ADAPTER_VERSION}"

ENV PI_LSP_ADAPTER=/usr/local/lib/node_modules/pi-lsp-adapter/src/index.ts

# The container runs under the calling user's uid so that files written through
# the workspace bind mount stay owned by them. That uid has no passwd entry
# here, so both HOME and the agent directory have to be writable by anyone.
#
# The cache directories are created here on purpose: a named volume takes its
# ownership from the image path it covers, and a path that does not exist yet is
# created by the daemon as root — which a non-root container then cannot write.
#
# `/home/pi/.pi/agent/lsp` is created for the same reason and one more: the LSP
# adapter resolves its paths from the home directory, not from
# PI_CODING_AGENT_DIR, and it writes a pid registry, logs and a workspace cache
# there while running. Existing here means a profile can bind mount its config
# and lockfile into that directory without the daemon creating it as root.
RUN mkdir -p /home/pi/.cache /home/pi/go/pkg/mod /pi-agent /home/pi/.pi/agent/lsp \
  && chmod -R 1777 /home/pi /pi-agent

ENV HOME=/home/pi \
    PI_CODING_AGENT_DIR=/pi-agent \
    PI_SKIP_VERSION_CHECK=1

WORKDIR /workspace
ENTRYPOINT ["pi"]
