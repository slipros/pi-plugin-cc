#!/bin/sh
# Entrypoint of the all-in-one `agent` image: optionally starts a rootless
# docker daemon for this run, then hands over to pi.
#
# The daemon is opt-in (PI_DIND=1) because one image now serves every preset.
# Runs that never touch containers — review, exploration, frontend work — should
# not pay ~3 s of startup, ~200 MB of RSS and a per-run image volume for a
# daemon nobody talks to. The profile that needs it (`agent`) sets PI_DIND=1
# along with the seccomp profile and /dev/net/tun it requires; `agent-lite`
# leaves it unset and this script degenerates into `exec pi`.
set -eu

if [ "${PI_DIND:-0}" != "1" ]; then
  exec pi "$@"
fi

# Derived from the actual uid, never hardcoded: the container runs as whatever
# uid the caller has, and the image was built to match it. A fixed value here
# would point at a runtime directory this uid does not own.
: "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
export XDG_RUNTIME_DIR

# Same principle as the dockerd-not-up handling further down in this file: a
# task that never touches containers should not die because dind's own setup
# did. Normally the image is built with RUNTIME_UID/GID matching the caller
# (agent.Dockerfile pre-creates /run/user/<uid> for exactly that uid), so this
# succeeds silently. It only fails on a uid mismatch — image built for one
# uid, container run as another — where /run/user itself is root-owned and
# this uid cannot mkdir under it. That is a dind precondition, not a pi
# precondition: warn and fall through to a plain run instead of taking the
# whole container down with it.
if ! mkdir -p "$XDG_RUNTIME_DIR" 2>/dev/null || ! chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null; then
  echo "pi sandbox: cannot prepare $XDG_RUNTIME_DIR (uid mismatch between image and run?); continuing without dind." >&2
  exec pi "$@"
fi
export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/docker.sock"

# Хранилище образов у каждого прогона своё (иначе два демона дерутся за lock
# containerd и рой сводится к одному агенту), поэтому слои тянутся заново на
# каждом старте. Зеркало-кеш на хосте делает это дёшево: первый прогон греет
# его, остальные тянут по локальной сети. Недоступное зеркало не ломает прогон —
# docker сам сходит в апстрим.
if [ -n "${PI_REGISTRY_MIRROR:-}" ]; then
  mkdir -p "$HOME/.config/docker"
  mirror_host=${PI_REGISTRY_MIRROR#*://}
  cat > "$HOME/.config/docker/daemon.json" <<JSON
{
  "registry-mirrors": ["${PI_REGISTRY_MIRROR}"],
  "insecure-registries": ["${mirror_host}"],
  "max-concurrent-downloads": 10
}
JSON
fi

DOCKERD_LOG=/tmp/dockerd-rootless.log
dockerd-rootless.sh >"$DOCKERD_LOG" 2>&1 &

# Waited for here rather than by whoever runs the first test: testcontainers
# reads DOCKER_HOST at call time and fails outright if nothing answers yet.
waited=0
while [ ! -S "${XDG_RUNTIME_DIR}/docker.sock" ]; do
  waited=$((waited + 1))
  if [ "$waited" -gt 600 ]; then
    # Not fatal: the run still has a working agent, and a task that never
    # touches containers should not die because the daemon did. But the log
    # lives in this container and dies with it, so its tail is echoed to stderr —
    # the run's own output — or the failure surfaces later as an unexplained
    # test error with nothing to diagnose it.
    echo "pi sandbox: rootless dockerd did not come up in 60s. Last log lines:" >&2
    tail -n 15 "$DOCKERD_LOG" >&2 2>/dev/null || true
    break
  fi
  sleep 0.1
done

exec pi "$@"
