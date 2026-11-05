# One sandbox image for every pi preset: Go, Rust, the Node/Vue/Vite frontend
# toolchain, and a rootless docker daemon — plus the language servers for all
# three stacks.
#
# Why one image instead of a per-stack tree (`go`, `go-dind`, a future `node`,
# a future `rust`): the presets are agents, not build jobs. A Go task turns out
# to need a docker-compose stack; a frontend task turns out to need the Go API
# it talks to; a review has to run both test suites. Every split image is a run
# that dies on "command not found" halfway through, and the fix is always the
# same — rebuild with the missing tool. The cost of merging is disk (~4 GB) and
# a longer cold build, both paid once on the host; the cost of splitting is paid
# by every run that guessed wrong.
#
# The rootless daemon is the one part that is *not* free at runtime, so it is
# opt-in: the `agent` profile sets PI_DIND=1, `agent-lite` does not (see
# agent-entrypoint.sh). Layer order is cheapest-to-invalidate last: Go, then
# Rust, then docker, then the npm globals that move most often — they sit just
# above the entrypoint, so editing that list rebuilds three cheap layers instead
# of the eight it used to invalidate (uv, docker-ce, setcap, the uid setup).
#
# Build: `pia sandbox build agent` (base image first: `pia sandbox build`).
FROM pi-plugin-sandbox:latest

USER root

# ---------------------------------------------------------------------------
# Shared OS packages
# ---------------------------------------------------------------------------
# fd-find is here for a security reason, not convenience. pi looks for `fd` in
# its own tools directory before PATH (tools-manager.js: "Check our tools
# directory first"), and that directory lives in a docker volume shared by every
# run. An agent that writes /pi-agent/bin/fd owns the next run — any run, over
# any repository. Shipping the binary in the image lets that directory be
# mounted read-only, so the lookup falls through to PATH instead.
#
# gcc/libc6-dev serve two stacks at once: `go test -race` links the race runtime
# through cgo, and Rust needs a linker for every `cargo build`. pkg-config and
# libssl-dev cover the common native-dependency crates (reqwest, openssl-sys).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     gcc libc6-dev pkg-config libssl-dev jq fd-find unzip xz-utils \
  && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Go
# ---------------------------------------------------------------------------
# What stays on the host and is mounted by the profile: `~/go/bin` — locally
# built tools that cannot be installed from a registry (custom-gcl with
# gid.team rules, mockery, protoc plugins, tea). They are Go binaries, i.e.
# static, so they run as they are.
#
# What is neither in the image nor mounted as a tool: the module cache. The
# profile bind mounts the host download cache read-only and points GOPROXY at
# it, so already-fetched modules (private gid.team ones included) resolve
# instantly without copying them in or letting the container write to them.
ARG GO_VERSION=1.26.7
# sha256 официального тарбола — из https://go.dev/dl/?mode=json&include=all,
# запись go1.26.7/linux-arm64. При обновлении GO_VERSION менять оба значения
# разом, иначе сборка падает на sha256sum -c ниже (а не тихо ставит не то).
#
# Арх — arm64: образ собирается на Apple Silicon, базовый слой тоже arm64.
# amd64-тулчейн внутри arm64-контейнера ЗАПУСКАЕТСЯ (binfmt отдаёт его qemu) и
# потому выглядит рабочим, но `go install` с CGO_ENABLED=1 зовёт НАТИВНЫЙ gcc с
# флагом -m64 и падает на «unrecognized command-line option '-m64'» — экраном
# ниже причины. Все остальные тулы в этом файле тянутся по той же причине в
# aarch64-вариантах; при переносе образа на x86-хост менять их разом.
ARG GO_SHA256=5a4ec883379d51ee9ce1040d5e87f8d35e20387574dd8c947feb01eabc3c1b37
# Pinned, not latest: gopls keys its on-disk cache by build hash, so every
# version change starts the index from scratch.
ARG GOPLS_VERSION=v0.23.0
# Тоже закреплено, а не @latest: неотслеживаемый latest незаметно меняет состав
# уже собранного образа при пересборке слоя, и агент получает инструмент, для
# которого ничего не проверялось. Отдельная сверка суммы здесь не нужна:
# go install сам сверяет модуль с суммой из GOSUMDB (sum.golang.org) перед
# установкой — то же свойство, которым уже пользуется gopls строкой выше.
ARG YQ_VERSION=v4.53.6

RUN set -eu; \
  curl -fsSLo /tmp/go.tar.gz "https://go.dev/dl/go${GO_VERSION}.linux-arm64.tar.gz"; \
  echo "${GO_SHA256}  /tmp/go.tar.gz" | sha256sum -c -; \
  tar -C /usr/local -xzf /tmp/go.tar.gz; \
  rm /tmp/go.tar.gz; \
  /usr/local/go/bin/go version

ENV PATH=/usr/local/go/bin:${PATH} \
    CGO_ENABLED=1

# HOME здесь уже /home/pi (из базового образа), поэтому go пишет кэш сборки
# именно туда — и оставленные root-ом файлы потом не даются на запись агенту
# (см. финальный слой). Чистится в том же слое, иначе вес остаётся в образе.
RUN GOBIN=/usr/local/bin GOPATH=/tmp/gopath go install "golang.org/x/tools/gopls@${GOPLS_VERSION}" \
  && rm -rf /tmp/gopath /root/.cache /home/pi/.cache/go-build \
  && gopls version

# yq: точечная правка YAML (OpenAPI-спеки) без перечитывания файла целиком.
# Ставится тем же go install, что и gopls: apt-пакет с этим именем — другой
# инструмент (python-yq поверх jq), с несовместимым синтаксисом.
RUN GOBIN=/usr/local/bin GOPATH=/tmp/gopath go install "github.com/mikefarah/yq/v4@${YQ_VERSION}" \
  && rm -rf /tmp/gopath /root/.cache /home/pi/.cache/go-build \
  && yq --version

# protoc ships as a zip of a static binary plus the well-known types
# (google/protobuf/*.proto), which imports resolve against. Pinned to the host's
# version: generated code must not differ depending on where it was generated,
# and protoc stamps its own version into every .pb.go header.
#
# The include tree is also linked to ~/.local/include, where it lives on the
# host: the genproto Makefile passes `-I$(HOME)/.local/include` literally, and
# without the link protoc only warns about the missing directory — then fails
# later on an unresolved import, several screens away from the cause.
ARG PROTOC_VERSION=33.1
RUN set -eu; \
  curl -fsSLo /tmp/protoc.zip \
    "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-aarch_64.zip"; \
  unzip -q /tmp/protoc.zip -d /usr/local 'bin/protoc' 'include/*'; \
  chmod 0755 /usr/local/bin/protoc; \
  rm /tmp/protoc.zip; \
  mkdir -p /home/pi/.local; \
  ln -sfn /usr/local/include /home/pi/.local/include; \
  protoc --version

# ---------------------------------------------------------------------------
# Rust
# ---------------------------------------------------------------------------
# Laid out like the official rust image: toolchain under /usr/local, so the home
# directory stays a per-run volume and the toolchain is not re-downloaded.
# rust-analyzer comes from rustup rather than a GitHub release (which is what
# pi-lsp-adapter would install) — a component matched to the toolchain cannot
# disagree with it about proc-macro ABI, which is exactly what breaks analysis
# on a mismatched pair.
#
# rust-src is not optional for the language server: without it, every `std::`
# hover and go-to-definition returns nothing.
#
# CARGO_HOME is world-writable because the container runs as an arbitrary uid
# with no passwd entry, and cargo writes its registry index and .crate cache
# there on the first build. The profile mounts a named volume over
# `registry/` so that download survives the run.
ARG RUST_VERSION=1.96.0
# rustup-init (бутстраппер) версионируется отдельно от тулчейна, который он
# ставит: RUST_VERSION — это rustc/cargo, а сам бутстраппер тянулся с
# .../dist/x86_64-.../rustup-init — вечно "текущая" ссылка без версии в пути.
# static.rust-lang.org хранит те же файлы и под версией, в .../archive/<версия>/,
# что даёт разом и пин, и сумму: rustup-init.sha256 лежит рядом с архивным
# бинарём. Версия ниже — та, что реально ставится сейчас (dist/ и archive/1.29.0
# отдают побайтово одинаковый файл, сверено вручную 2026-08-23).
ARG RUSTUP_VERSION=1.29.0
# Сумма — из rustup-init.sha256 рядом с aarch64-бинарём того же архива.
ARG RUSTUP_INIT_SHA256=9732d6c5e2a098d3521fca8145d826ae0aaa067ef2385ead08e6feac88fa5792
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/go/bin:${PATH}
RUN set -eu; \
  curl -fsSLo /tmp/rustup-init \
    "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/aarch64-unknown-linux-gnu/rustup-init"; \
  echo "${RUSTUP_INIT_SHA256}  /tmp/rustup-init" | sha256sum -c -; \
  chmod 0755 /tmp/rustup-init; \
  /tmp/rustup-init -y --no-modify-path --profile minimal \
    --default-toolchain "${RUST_VERSION}" \
    -c clippy -c rustfmt -c rust-src -c rust-analyzer; \
  rm /tmp/rustup-init; \
  chmod -R a+w "$RUSTUP_HOME" "$CARGO_HOME"; \
  rustc --version; cargo --version; rust-analyzer --version

# cargo-nextest: the test runner Rust projects actually gate on (per-test
# process isolation, machine-readable output). Shipped as a prebuilt binary —
# building it from source here would add ~5 minutes to every image rebuild.
#
# Закреплено на конкретный релиз GitHub вместо get.nexte.st/latest/linux
# (плавающий редирект на "последнюю" сборку): та же версия при пересборке
# образа, и есть с чем сверять сумму — get.nexte.st её не даёт, а сам релиз
# публикует .sha256 рядом с каждым архивом.
ARG NEXTEST_VERSION=0.9.143
ARG NEXTEST_SHA256=2a64b3566a92508550a7ab29c3e8db25472ca37730ecb4d22100b6aa440c2a68
RUN set -eu; \
  curl -fsSLo /tmp/nextest.tar.gz \
    "https://github.com/nextest-rs/nextest/releases/download/cargo-nextest-${NEXTEST_VERSION}/cargo-nextest-${NEXTEST_VERSION}-aarch64-unknown-linux-gnu.tar.gz"; \
  echo "${NEXTEST_SHA256}  /tmp/nextest.tar.gz" | sha256sum -c -; \
  tar -C /usr/local/bin -xzf /tmp/nextest.tar.gz cargo-nextest; \
  rm /tmp/nextest.tar.gz; \
  chmod 0755 /usr/local/bin/cargo-nextest; \
  cargo nextest --version

# Mutation testing and dependency audit for Rust.
#
# cargo-audit and cargo-deny come from their release binaries through
# cargo-binstall, with `--disable-strategies compile` so a missing release fails
# here instead of quietly falling back to a five-minute source build nobody
# ordered. binstall itself is fetched as a tarball rather than run from its
# install script: no shell piping, and the version that lands is the one asked
# for.
#
# Версия закреплена (не releases/latest/download/…), но сверить сумму нечем
# достоверно: релиз cargo-binstall не публикует ни .sha256, ни checksums.txt —
# только minisign .sig поверх отдельно распространяемого публичного ключа, и
# даже официальный install-from-binstall-release.sh (см. cargo-bins/cargo-binstall,
# проверено 2026-08-23) сам его не проверяет, просто curl | tar. Заводить ради
# одного бинаря отдельный доверенный ключ и minisign, которого больше нигде в
# образе нет, — цена, которую не оправдывает источник, не проверяемый даже
# собственным установщиком.
ARG BINSTALL_VERSION=1.21.1
RUN set -eu; \
  curl -fsSL -o /tmp/binstall.tgz \
    "https://github.com/cargo-bins/cargo-binstall/releases/download/v${BINSTALL_VERSION}/cargo-binstall-aarch64-unknown-linux-musl.tgz"; \
  tar -C /usr/local/cargo/bin -xzf /tmp/binstall.tgz cargo-binstall; \
  rm /tmp/binstall.tgz; \
  cargo binstall -y --disable-strategies compile cargo-audit cargo-deny; \
  cargo audit --version; cargo deny --version

# cargo-mutants is the exception: its only release binary is built against
# glibc 2.39 (Ubuntu 24.04) and this image is bookworm, glibc 2.36 — installing
# it as a binary produces a command that exits with "GLIBC_2.39 not found" the
# first time the mutation gate runs. Built from source instead, which costs a
# few minutes per image rebuild and nothing at run time. `--locked` so the build
# uses the versions the release was tested with.
#
# The build caches (~1 GB of registry sources and target objects) are dropped in
# the same layer; the registry index the runtime needs comes back as a volume.
RUN set -eu; \
  cargo install cargo-mutants --locked; \
  rm -rf "$CARGO_HOME/registry" "$CARGO_HOME/git" /tmp/cargo-install*; \
  chmod -R a+w "$CARGO_HOME"; \
  cargo mutants --version

# pi-lsp-adapter (0.1.3) hardcodes a 10s LSP request timeout: no config key, no
# environment variable, and index.ts builds the runtime manager without the
# option, so the default is the only value there is. gopls needs more than that
# on a cold index of a large module — the first `lsp_references` on lk-api timed
# out twice before answering on the third try, which the agent spends turns on.
# rust-analyzer's first response after `cargo metadata` is slower still.
ARG LSP_REQUEST_TIMEOUT_MS=60000
RUN set -eu; \
  for file in /usr/local/lib/node_modules/pi-lsp-adapter/src/lsp/client.ts \
              /usr/local/lib/node_modules/pi-lsp-adapter/src/lsp/runtimeManager.ts; do \
    grep -q 'options.requestTimeoutMs ?? 10_000' "$file" \
      || { echo "LSP timeout patch: pattern missing in $file — check the adapter version"; exit 1; }; \
    sed -i "s/options\.requestTimeoutMs ?? 10_000/options.requestTimeoutMs ?? ${LSP_REQUEST_TIMEOUT_MS}/" "$file"; \
    grep -q "options.requestTimeoutMs ?? ${LSP_REQUEST_TIMEOUT_MS}" "$file" \
      || { echo "LSP timeout patch: substitution failed in $file"; exit 1; }; \
  done

# ---------------------------------------------------------------------------
# Python
# ---------------------------------------------------------------------------
# Not in the original brief, but the projects these presets work on are not
# single-stack: govorun is a Tauri client (Rust + web UI) in front of a Python
# ASR server, so a "Rust task" reaches the Python side by the second step. uv
# carries the whole stack — interpreter, virtualenvs, tools — in one binary, so
# this costs one layer rather than a pyenv/pip/pipx tower.
#
# The interpreter and the tools are installed into /usr/local, not $HOME: the
# home directory is a per-run volume, and anything placed there would be
# reinstalled on every fresh one.
#
# mutmut is the mutation gate for Python (the trio is completed by gremlins for
# Go and StrykerJS for TypeScript), pip-audit its vulnerability half, ruff the
# linter/formatter. pyright's language server arrives with the npm globals.
ARG PYTHON_VERSION=3.13
# Закреплено на релиз (не releases/latest/download/…) и сверяется по сумме:
# astral публикует uv-aarch64-unknown-linux-gnu.tar.gz.sha256 рядом с каждым
# архивом релиза.
ARG UV_VERSION=0.12.5
ARG UV_SHA256=9bf43b4d1a07665bf64d4c4e710930b382321a785e0eb10aac07f46471f86a31
ENV UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python \
    UV_PYTHON_BIN_DIR=/usr/local/bin \
    UV_TOOL_DIR=/usr/local/share/uv/tools \
    UV_TOOL_BIN_DIR=/usr/local/bin \
    UV_LINK_MODE=copy
RUN set -eu; \
  curl -fsSL -o /tmp/uv.tar.gz \
    "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-unknown-linux-gnu.tar.gz"; \
  echo "${UV_SHA256}  /tmp/uv.tar.gz" | sha256sum -c -; \
  tar -C /tmp -xzf /tmp/uv.tar.gz; \
  install -m 0755 /tmp/uv-aarch64-unknown-linux-gnu/uv /tmp/uv-aarch64-unknown-linux-gnu/uvx /usr/local/bin/; \
  rm -rf /tmp/uv.tar.gz /tmp/uv-aarch64-unknown-linux-gnu; \
  uv python install --default "${PYTHON_VERSION}"; \
  uv tool install ruff; \
  uv tool install mutmut; \
  uv tool install pip-audit; \
  chmod -R a+rX /usr/local/share/uv; \
  rm -rf /home/pi/.cache/uv; \
  python3 --version; ruff --version; pip-audit --version; \
  # mutmut 3.x парсит конфигурацию проекта даже на `version` и без
  # source_paths падает — в пустом образе проверяется наличие бинаря.
  test -x /usr/local/bin/mutmut

# ---------------------------------------------------------------------------
# Rootless docker daemon (opt-in at run time via PI_DIND=1)
# ---------------------------------------------------------------------------
# Why rootless rather than the two usual answers:
#   - mounting the host's /var/run/docker.sock would put the agent's containers
#     on the host daemon (not isolated at all) and hand it root on the host;
#   - --privileged would isolate the containers but open the host's devices.
# Rootless keeps the inner containers inside this sandbox and needs no
# privileged flag: the daemon comes up with the podman seccomp profile plus
# /dev/net/tun, with /proc still masked and AppArmor untouched. That profile
# lives next to this file and is passed by the sandbox profile, not baked in.
#
# Pinned, and not merely for reproducibility: 28.x is the release the official
# rootless image ships and the one this setup was verified against. In 29.x the
# startup script writes net.ipv4.ip_forward through sysctl, which fails under a
# read-only /proc/sys — and making that writable means `systempaths=unconfined`,
# i.e. handing back /proc/kcore and /proc/sysrq-trigger for a single sysctl.
# When this pin disappears from Docker's bookworm repo (they prune old
# versions), the build fails loudly on "Version not found" rather than silently
# jumping to 29.x. Last verified against 28.5.2 on 2026-08-13.
ARG DOCKER_VERSION=5:28.5.2-1~debian.12~bookworm
# Compose is versioned independently of the daemon: an E2E test runs against the
# repository's own stack file, the same one deployment uses, and reaching it
# means `docker compose`. Without the plugin the only reachable level is
# testcontainers, i.e. hand-wired components in the test process — which leaves
# the composition root, config loading and start-up order unverified.
ARG COMPOSE_VERSION=5.4.0-1~debian.12~bookworm
# containerd.io тянулся вовсе без версии — тот же плавающий источник, что и
# закреплённые выше docker-ce/compose, просто без пина, хотя приходит из того
# же репозитория и под той же подписью (signed-by=docker.asc выше). Версия —
# та, что реально стоит в уже собранном образе (containerd --version → v2.3.3),
# и она же последняя доступная под bookworm в этом репозитории на момент
# проверки (apt-cache madison containerd.io, 2026-08-23). Отдельная сумма не
# нужна: пакет ставится apt'ом из репозитория, подпись которого уже проверяется
# ключом docker.asc, — то же свойство, которым пользуются docker-ce и compose.
ARG CONTAINERD_VERSION=2.3.3-1~debian.12~bookworm
RUN set -eu; \
  install -m 0755 -d /etc/apt/keyrings; \
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; \
  chmod a+r /etc/apt/keyrings/docker.asc; \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
    > /etc/apt/sources.list.d/docker.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    "docker-ce=${DOCKER_VERSION}" \
    "docker-ce-cli=${DOCKER_VERSION}" \
    "docker-ce-rootless-extras=${DOCKER_VERSION}" \
    "docker-compose-plugin=${COMPOSE_VERSION}" \
    "containerd.io=${CONTAINERD_VERSION}" \
    uidmap \
    libcap2-bin \
    dbus-user-session \
    fuse-overlayfs \
    slirp4netns \
    iproute2 \
    iptables \
    procps; \
  rm -rf /var/lib/apt/lists/*; \
  dockerd --version | grep -q "version 28\\." \
    || { echo "agent image expects docker 28.x; got $(dockerd --version)"; exit 1; }

# Debian ships newuidmap/newgidmap setuid-root; measured here, that does not
# grant CAP_SETUID under this daemon, and RootlessKit dies with "write to
# uid_map failed: Operation not permitted". File capabilities — how Alpine ships
# the same binaries, which is why the stock rootless image works — do grant it.
# They are also the narrower of the two: one capability instead of full root.
RUN set -eu; \
  chmod u-s /usr/bin/newuidmap /usr/bin/newgidmap; \
  setcap cap_setuid+ep /usr/bin/newuidmap; \
  setcap cap_setgid+ep /usr/bin/newgidmap; \
  getcap /usr/bin/newuidmap | grep -q cap_setuid \
    || { echo "newuidmap did not take cap_setuid"; exit 1; }

# The daemon runs as the same unprivileged user the agent does, which is the
# caller's own uid (companion passes it as a build arg). On the 1000 default that
# is the base image's `node`, whose subuid range already exists; on any other uid
# a subordinate range has to be granted, or newuidmap has nothing to map and
# RootlessKit cannot start. The runtime directory and the daemon's data root are
# created owned by that uid so the container — started with --user <uid> — can
# write them without a chown at startup.
ARG RUNTIME_UID=1000
ARG RUNTIME_GID=1000
RUN set -eu; \
  if ! getent passwd "$RUNTIME_UID" >/dev/null; then \
    groupadd -g "$RUNTIME_GID" pirun 2>/dev/null || true; \
    useradd -u "$RUNTIME_UID" -g "$RUNTIME_GID" -M -s /usr/sbin/nologin pirun; \
  fi; \
  runtime_user="$(getent passwd "$RUNTIME_UID" | cut -d: -f1)"; \
  grep -q "^${runtime_user}:" /etc/subuid || echo "${runtime_user}:200000:65536" >> /etc/subuid; \
  grep -q "^${runtime_user}:" /etc/subgid || echo "${runtime_user}:200000:65536" >> /etc/subgid; \
  install -d -m 0700 -o "$RUNTIME_UID" -g "$RUNTIME_GID" "/run/user/${RUNTIME_UID}"; \
  install -d -m 0755 -o "$RUNTIME_UID" -g "$RUNTIME_GID" /home/pi/.local/share/docker

# ---------------------------------------------------------------------------
# Frontend: Node is the base image, this adds package managers, Vite and the
# TypeScript/Vue toolchain
# ---------------------------------------------------------------------------
# pnpm and yarn come from corepack (shipped with Node) rather than npm -g: it
# is how a repository's `packageManager` field is honoured, and a run that
# installs with the wrong manager produces a lockfile diff nobody asked for.
#
# Versions are pinned where a mismatch changes output that lands in the repo
# (typescript, because vue-tsc and vtsls both type-check with it) and left
# floating where it only affects the agent's own workflow.
#
# @vtsls/language-server and typescript are the exact pair pi-lsp-adapter would
# install for the `vtsls` server; installed here so nothing is fetched at run
# time and the agent directory can stay read-only.
#
# There is deliberately NO language server for `.vue` here. @vue/language-server
# (Volar 3) was installed and dropped: it answers `initialize` and advertises
# hoverProvider, then never replies to `textDocument/hover` — measured both with
# a bare LSP client and through pi's own adapter, which gave up after its 60 s
# timeout. Its hybrid mode expects a sibling tsserver carrying
# @vue/typescript-plugin, and wiring vtsls with that plugin returned nothing for
# .vue either. Type checking of single-file components is not lost: `vue-tsc
# --noEmit` works and is the gate that matters; what an agent loses is hover and
# go-to-definition inside .vue, where it falls back to grep.
# Versions are pinned to what the image was last built with, taken from the image
# itself rather than guessed: an unpinned list means a rebuild a month from now
# ships a different toolchain than the stack prompts promise the agent, and the
# difference surfaces as a test failure nobody can reproduce.
ARG TYPESCRIPT_VERSION=6.0.3
ARG VTSLS_VERSION=0.3.0
ARG PNPM_VERSION=11.23.0
ARG YARN_VERSION=1.22.22
ARG VUE_TSC_VERSION=3.3.10
ARG VITE_VERSION=8.2.2
ARG ESLINT_VERSION=10.8.1
ARG PRETTIER_VERSION=3.9.6
ARG PYRIGHT_VERSION=1.1.413
ARG YAML_LS_VERSION=1.24.0
ARG VSCODE_LS_VERSION=4.10.0
ARG STRYKER_VERSION=10.0.0
# Делегирование pi→pi. Держится ровно на той же версии, что стоит у хостового
# pi (`~/.pi/agent/npm`): родитель и ребёнок должны понимать один формат
# определений агентов и один набор переменных-лимитов. Peer-зависимости
# (@earendil-works/pi-*) резолвятся из соседних global-модулей, как у
# pi-lsp-adapter. Тул `subagent` появляется у прогона только когда пресет
# назовёт это расширение явно — установка сама по себе прав не даёт.
ARG PI_SUBAGENTS_VERSION=0.56.0
RUN set -eu; \
  corepack enable; \
  corepack prepare "pnpm@${PNPM_VERSION}" --activate; \
  corepack prepare "yarn@${YARN_VERSION}" --activate; \
  npm install -g --ignore-scripts \
    "typescript@${TYPESCRIPT_VERSION}" \
    "@vtsls/language-server@${VTSLS_VERSION}" \
    "vue-tsc@${VUE_TSC_VERSION}" \
    "vite@${VITE_VERSION}" \
    "eslint@${ESLINT_VERSION}" \
    "prettier@${PRETTIER_VERSION}" \
    "pyright@${PYRIGHT_VERSION}" \
    "yaml-language-server@${YAML_LS_VERSION}" \
    "vscode-langservers-extracted@${VSCODE_LS_VERSION}" \
    "@stryker-mutator/core@${STRYKER_VERSION}" \
    "@stryker-mutator/vitest-runner@${STRYKER_VERSION}" \
    "@stryker-mutator/typescript-checker@${STRYKER_VERSION}" \
    "pi-subagents@${PI_SUBAGENTS_VERSION}"; \
  npm cache clean --force; \
  rm -rf /home/pi/.npm /home/pi/.cache/node; \
  tsc --version; vtsls --version; vite --version; vue-tsc --version; \
  stryker --version; \
  test -f /usr/local/lib/node_modules/pi-subagents/index.ts

# ---------------------------------------------------------------------------
# Браузер для фронтенд-пресетов
# ---------------------------------------------------------------------------
# Зачем в образе, а не через MCP хоста. Скилл `browser` в Claude Code — роутер над
# двумя MCP-серверами, которые живут на ХОСТЕ и держат persistent-профиль с
# логинами пользователя (`~/.claude/browser/profile`). Пробросить их в контейнер
# агента значит отдать агенту залогиненные сессии человека — цена несоразмерна
# задаче «посмотреть на свою же страницу на localhost». Здесь браузер свой,
# одноразовый и без чужих кук; гоняется из `bash` скриптом, скриншот кладётся в
# /tmp и читается тулом `read` — картинку модель получает как картинку
# (проверено на deepseek-v4-flash-vision-exp: описала цвета, положение элементов
# и назвала поломку вёрстки).
#
# PLAYWRIGHT_BROWSERS_PATH обязателен и не косметика: по умолчанию браузеры
# уезжают в ~/.cache/ms-playwright, а `/home/pi/.cache` — точка монтирования
# именованного тома, который на прогоне ЗАКРОЕТ содержимое образа. Системный
# путь тома не касается.
ARG PLAYWRIGHT_VERSION=1.62.1
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/ms-playwright
RUN set -eu; \
  npm install -g --ignore-scripts "playwright@${PLAYWRIGHT_VERSION}"; \
  playwright install --with-deps chromium; \
  chmod -R a+rX /usr/local/ms-playwright; \
  npm cache clean --force; \
  rm -rf /home/pi/.npm /home/pi/.cache/node; \
  node -e "console.log(require('/usr/local/lib/node_modules/playwright').chromium.executablePath())"

COPY agent-entrypoint.sh /usr/local/bin/pi-agent-entrypoint
RUN chmod 0755 /usr/local/bin/pi-agent-entrypoint

# Pillow и requests в системный интерпретатор. Скилл vision даёт зрение агентам,
# чья модель картинок не видит, и мелкий текст там читается только через
# «вырезать фрагмент и увеличить» — то есть упирается в декодер растра; requests
# кладётся рядом, потому что каждый второй вспомогательный скрипт агента пишется
# на нём и без него падает на первой строке. Флаг --break-system-packages нужен
# потому, что uv помечает свой интерпретатор managed и иначе ставить в него
# отказывается; кэш uv чистится здесь же, до того как следующий слой пересоздаёт
# домашний каталог (иначе root-owned хвост уедет в volume).
RUN set -eu; \
  UV_LINK_MODE=copy uv pip install --system --break-system-packages pillow requests; \
  chmod -R a+rX /usr/local/share/uv; \
  rm -rf /home/pi/.cache/uv; \
  python3 -c 'import PIL, requests; print("pillow", PIL.__version__, "requests", requests.__version__)'

# The container home is wiped of everything the build left there, then recreated
# empty and world-writable.
#
# Both halves matter. Files written during the build belong to root, and the
# home tree is mode 1777 — sticky, so a container running as an arbitrary uid
# may create files next to them but may not replace them. That is not a
# hypothetical: `uv venv` died on exactly this, renaming its temp file over a
# root-owned cache entry ("Operation not permitted"). And these directories are
# volume mount points, so docker seeds a fresh volume from whatever the image
# has at that path — root ownership and all — which would carry the same failure
# into every run and every later rebuild of the cache volume.
RUN set -eu; \
  rm -rf /home/pi/.cache /home/pi/.npm /home/pi/.cargo /home/pi/.config \
         /home/pi/.local/share/pnpm /home/pi/.rustup; \
  mkdir -p /home/pi/.cache /home/pi/.npm /home/pi/.cargo /home/pi/go/pkg/mod \
           /home/pi/.local/share/pnpm; \
  chmod -R 1777 /home/pi

# The cargo registry is a volume mount point, and docker creates a missing image
# path as root — which the container, running as an unprivileged uid, then
# cannot write. That is not theoretical either: rust-analyzer came up, failed to
# write the registry index cache ("Permission denied (os error 13)") and
# answered every hover with nothing, while cargo itself still built from the
# already-extracted sources. The directories are recreated here because the
# cargo-mutants layer deletes them to keep its build cache out of the image.
RUN set -eu; \
  mkdir -p /usr/local/cargo/registry /usr/local/cargo/git; \
  chmod -R a+w /usr/local/cargo

# Non-root by default, not only when the caller remembers `--user`. The companion
# always passes it (`sandbox.user: current`), so this changes nothing for a normal
# run — it is here for the ones that bypass it: a profile that sets `user: root`,
# or a bare `docker run` of this image. Both would otherwise get root in a
# container with a loosened seccomp profile and /dev/net/tun.
USER ${RUNTIME_UID}

ENTRYPOINT ["/usr/local/bin/pi-agent-entrypoint"]
