# Sandbox image for pi runs started by the pi plugin for Claude Code.
#
# The whole pi process runs in here: built-in tools, `!` commands and extensions
# all execute inside the container, and only the workspace is bind mounted back
# to the host. Build it with `pi-companion.mjs sandbox build`.

ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ARG PI_VERSION=latest

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git less ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}"

# The container runs under the calling user's uid so that files written through
# the workspace bind mount stay owned by them. That uid has no passwd entry
# here, so both HOME and the agent directory have to be writable by anyone;
# a named volume mounted at /pi-agent inherits these permissions.
RUN mkdir -p /home/pi /pi-agent && chmod 1777 /home/pi /pi-agent

ENV HOME=/home/pi \
    PI_CODING_AGENT_DIR=/pi-agent \
    PI_SKIP_VERSION_CHECK=1

WORKDIR /workspace
ENTRYPOINT ["pi"]
