# dind: containers inside the sandbox

The `agent` profile (`PI_DIND=1`) gives a run its own docker inside the sandbox — for
`testcontainers` tests and for E2E against the repository's compose stack. This is how it is put
together and what has to be set up once on the host; the working command is in the skill.

Tests on `testcontainers` start a database in a container — the light profile (`agent-lite`) has no daemon and should not have one. The `agent` profile gives the run **its own** rootless daemon: its containers live inside the sandbox, die with it, and never show up in `docker ps` on the host.

```bash
/pi:delegate --preset go-developer "fix the integration tests"   # the profile is already in the preset
/pi:sandbox build agent                                          # one image for every stack
```

No host socket, no `--privileged`. Everything that turned out to be needed — measured, not taken from a tutorial:

| What | Why |
|---|---|
| `--security-opt seccomp=@sandbox/dind-seccomp.json` | docker's default profile blocks `unshare`/`mount`/`clone` with `CLONE_NEW*`, without which rootless does not start. `@sandbox/` resolves through the same directories as a Dockerfile (project → `~/.claude/pi/sandbox` → the plugin), so no absolute path is hard-coded |
| `--device /dev/net/tun` | RootlessKit creates a tap interface; without it `ip tuntap add` fails |
| `DOCKERD_ROOTLESS_ROOTLESSKIT_FLAGS=--pidns` | with its own PID namespace the daemon gets its own `/proc` and can write sysctls in its network namespaces |
| volume `pi-dind-images` under `~/.local/share/docker` | otherwise images are pulled again on every run |
| `TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1` | otherwise testcontainers addresses containers through `172.17.0.1` and hangs on the readiness check |
| `TESTCONTAINERS_RYUK_DISABLED=true` | the reaper is pointless: everything inside dies with the sandbox |

`docker compose` is in the image (as a plugin), for E2E against a repository's compose stack rather than only testcontainers. `DOCKER_HOST`/`XDG_RUNTIME_DIR` are not set in the profile's env: the entrypoint derives them from `id -u`, so the image works under any uid.

**Not needed:** `apparmor=unconfined` (AppArmor is not active on Docker Desktop; on native Linux with AppArmor enabled the `docker-default` profile will likely report some mount operations on top of seccomp — there it probably would be), `systempaths=unconfined` (`/proc/kcore` and `/proc/sysrq-trigger` stay masked), `--device /dev/fuse` (overlay2 works natively on top of a volume), `--privileged`.

**The seccomp profile** is generated from rootless podman's profile (`containers/common`) by `make-dind-seccomp.py` next to the Dockerfile — which also records the upstream URL, the date, the sha256 of source and result, and the command to reproduce it (`--fetch` downloads and verifies the hash). It allows four syscalls upstream keeps behind `CAP_SYS_ADMIN`: `sethostname`, `setdomainname`, `setns`, `chroot`. The nested runc performs them, while docker checks the capability gate against the **outer** container, which does not have that capability. Allowing a syscall grants no privilege: the kernel still requires `CAP_SYS_ADMIN` in the namespace the caller owns — the nested runtime has it, a process reaching for the host does not. (A cap-gated ALLOW instead of an unconditional one does **not** work here — tested, and it breaks the nested daemon for the same reason.)

**The docker version in the image is pinned to 28.x** (a check in the Dockerfile fails the build otherwise). In 29.x the startup script writes `net.ipv4.ip_forward` through sysctl and fails on a read-only `/proc/sys`; the only cure is `systempaths=unconfined`, which means handing back `/proc/kcore` for the sake of one sysctl.

**Portability.** The image is built for the host's uid (`RUNTIME_UID`/`RUNTIME_GID` are passed from `process.getuid()`): for uid ≠ 1000 a user and a subuid range are created, otherwise RootlessKit does not start. Changing user means rebuilding the image (`sandbox build agent`).

**Parallel dind runs.** Image storage is per run — the mount is marked `:isolate`, so docker hands the container an anonymous volume that dies with it. Otherwise two daemons fight over containerd's exclusive lock on a shared volume and corrupt `meta.db`; docker has no shared RW image storage for several dind instances ([moby#40196](https://github.com/moby/moby/issues/40196)), so isolation is the only way to raise the `dind` pool above one. Module and build caches stay shared: `:isolate` applies to a single mount, unlike `isolateCaches`, which anonymises all of them.

The price of isolation is cold image storage on every start, and a **host-side registry mirror** removes it:

```bash
docker run -d --restart=always --name pi-registry-mirror -p 5000:5000 \
  -v pi-registry-cache:/var/lib/registry \
  -e REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io registry:2
```

The profile passes `PI_REGISTRY_MIRROR` (default `http://host.docker.internal:5000`) to the daemon inside the sandbox, and the entrypoint writes `registry-mirrors` + `insecure-registries` + `max-concurrent-downloads: 10` into `daemon.json` before dockerd starts. The first run warms the mirror, the rest pull layers over the local network. If the mirror is unreachable docker goes upstream on its own and the run is fine. Only Docker Hub is proxied: private registries are contacted directly.

**Residual risk.** Checked by a pen-test agent from the inside: escape to the host was **not achieved**. seccomp really does return EPERM for `fsopen`/`open_by_handle_at`/`bpf`/`userfaultfd`/`kexec` even with full caps in a user namespace — those are the userns-escape primitives. The agent can create user namespaces and mount inside them, but `mount_setattr` on host mounts returns EPERM (they are owned by the init userns), and escape is left to a kernel vulnerability rather than a supported mechanism. It has no host daemon, no host devices, no unmasked `/proc` and no `CAP_SYS_ADMIN` outside. A run that relaxes isolation says so itself: `Sandbox replaces the default seccomp profile…`, `Sandbox passes the host device /dev/net/tun…`.
