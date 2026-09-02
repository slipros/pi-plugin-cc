# Sandbox: what the container gets, profiles, images

How sandbox profiles are declared, what images are built from, and why provider keys and forge
tokens never enter the container. The working commands are in the skill (`skills/pi/SKILL.md`).

`--sandbox docker` runs the whole pi process inside a container: built-in tools, `!` commands and extensions all execute there, and the only thing mounted from the host is the workspace.

```bash
/pi:sandbox build                     # build the image (pinned to your pi version)
/pi:delegate --sandbox docker         rewrite this module and run the tests
/pi:sandbox                           # image state and leftover containers
/pi:sandbox clean                     # remove containers a crash left behind
```

## What the container gets

| | |
| --- | --- |
| Workspace | bind mounted at `/workspace/<dirname>`, read-write — the directory keeps its name, so build recipes reading `$(notdir $(CURDIR))` compute the same value inside and out |
| Agent directory | a named docker volume, so host settings, sessions and installed pi packages stay out. Two files are laid in read-only: `auth.json` and `models.json` (custom provider definitions — without it a preset naming a local gateway model would fail with `Unknown provider`) |
| Credentials | never enter the container: a run-scoped proxy on the host holds the real key and the agent gets a token that dies with the run |
| Identity | your uid/gid, so files written through the mount are not owned by root |
| Network | on by default, because the model call needs it |
| Environment | `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0` — a sandbox default rather than a profile field, so no profile needs to repeat it. The container has no business fetching updates or sending telemetry; its only legitimate outbound connection is the model |

The rest of your home directory, your SSH keys and everything outside the workspace are simply not there. Sessions live in the volume, so `--session last` keeps working across sandboxed runs — but a session started on the host cannot be continued in the sandbox, and vice versa. Sessions are also split per workspace through `PI_CODING_AGENT_SESSION_DIR`: pi buckets them by working directory, and containers used to share one flat `/workspace`, so one bucket held the transcripts of every repository this machine had ever touched.

If the image is missing or the daemon is unreachable, the run fails **before** a job exists, with the command that fixes it.

### Real keys stay on the host

For the duration of a run a local proxy is raised, the agent gets a one-time token, and the real key is substituted on the host. The run log says `Credentials stay on the host`. A sandbox protects the host from the agent, but would not protect the keys: the agent has bash and network inside, and would simply read `auth.json`. The token lives exactly as long as the run.

**The agent does not know which model answers it.** Inside the container the provider is called `sandbox` and the model `agent-model`; the proxy substitutes the real name in the request body. The practical benefit: an agent cannot move itself to a pricier model at the same provider — the bill goes to the account owner, not to the sandbox. Behavioural fields (`api`, `compat`, window size) are carried over from the real entry, since lying in those would change how pi works rather than hide a name. The journal and reports record the real model, so statistics stay about what actually answered.

This works both for your own providers from `~/.pi/agent/models.json` and for the ones built into pi: their addresses come from the model catalogue next to the `pi` binary, and a provider definition is laid into the container's `models.json`. Turned off per profile with `"proxyCredentials": false`.

**Forge tokens do not enter either — and push from inside is impossible.** The same trick raises a git proxy; details in [git-proxy.md](git-proxy.md).

## Equipment that will not arrive stops the run

A preset can name skills and extensions by container path. A path nothing mounts — or a mount whose host side does not exist, which docker turns into an empty directory — means the agent runs without the rules that equipment carries, while the run looks entirely normal. `delegate` therefore refuses to start and names the mount that would fix it; `presets` marks the same preset with `⚠ NOT MOUNTED`. See [agents.md](agents.md).

## Trusted workspaces: what a repository may decide

Two things hang off one list:

```json
{ "trustedProjects": ["~/github"], "presets": { } }
```

Entries match by prefix, so one line covers everything under it. `"trustProjectConfig": true` is the blunt version: trust every workspace, wherever it is.

For a workspace **not** covered by either:

- its `.claude/pi/config.json` is sanitized — it may still choose a model, prompts and a toolchain, but not `mounts`, `env`, `agentDir`, `volume`, `user`, `image`, `network`, `args`, `mode`, `isolateCaches` or `onFinish`. What was stripped is printed with the run.
- its **caches are not shared**. Named volumes the profile mounts writable — the module cache, the build cache, the gopls index — are replaced with anonymous volumes that die with the container, and the agent directory becomes one volume per workspace.

The reason is one vector: those volumes outlive the run and are shared by every other one, so a module or build object written by a repository you cloned from the internet would be picked up by the next run, in a different repository. An untrusted run pays with a cold build cache — modules still resolve instantly from the host download cache, mounted read-only through `GOPROXY=file://`.

## Sandbox profiles: giving an agent its toolchain

The image is deliberately bare — node, git, ripgrep. An agent that has to build Go, run a linter or honour your commit gates needs those tools inside, and that equipment is the same for every Go preset you own. So it is named once, under `sandboxProfiles`, and referenced by name:

```json
{
  "sandboxProfiles": {
    "go": {
      "mounts": [
        "/home/linuxbrew/.linuxbrew/opt/go/libexec:/usr/local/go:ro",
        "~/go/bin:/gobin:ro",
        "~/.pi/agent/extensions:/pi-agent/host-extensions:ro",
        "~/.pi/agent/skills:/pi-skills:ro",
        "pi-plugin-gomod:/home/pi/go/pkg/mod",
        "pi-plugin-gocache:/home/pi/.cache"
      ],
      "env": ["PATH=/usr/local/go/bin:/gobin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
      "extensions": ["/pi-agent/host-extensions/custom-gcl-precommit.ts"],
      "skills": ["/pi-skills/git-commit"]
    }
  },
  "presets": {
    "go-fix":    { "model": "opencode-go/kimi-k3", "systemPrompt": "fixer",       "sandbox": "go" },
    "go-review": { "model": "opencode-go/glm-5.2", "systemPrompt": "adversarial", "sandbox": "go", "readOnly": true }
  }
}
```

- `extensions` / `skills` of a profile load **only** when the sandbox is active, so they can point at container paths that do not exist on your host. Gates belong here: a pre-commit linter gate missing inside the container does not fail loudly, it just stops gating — which is why an unmounted one now stops the run instead.
- Host binaries are not copied in, they are bind mounted: `~/go/bin:/gobin:ro` makes the same file on disk visible at `/gobin`, read-only. Statically linked binaries (anything built by Go) run as-is; something linked against host libraries has to be installed in the image instead.
- `env` takes both forms: `"NAME"` forwards the host value, `"NAME=value"` sets one. A mounted binary is useless until `PATH` names its directory.
- Named volumes (`pi-plugin-gomod:/home/pi/go/pkg/mod`) keep module and build caches between runs; without them every run recompiles the world.
- `"sandbox": {"profile": "go", "network": "none"}` starts from a profile and overrides single fields; `--sandbox go` applies a profile for one run. Equipment adds to the profile rather than replacing it, so `{"profile": "go", "env": ["PI_HOOKS=…"]}` keeps the profile's `PATH` — without which every mounted binary is unreachable.
- A profile may itself name a `profile`, so `agent` is `agent-base` plus the docker daemon instead of a copy of it. A cycle is reported, not hung.

### Language servers

The image ships the `pi-lsp-adapter` extension (`/usr/local/lib/node_modules/pi-lsp-adapter/src/index.ts`), so a run gets `lsp_definition`, `lsp_references`, `lsp_workspace_symbols` and `lsp_diagnostics` without downloading anything. The server itself is bind mounted from the host — `gopls` is a static Go binary and runs as it is.

```json
"mounts": [
  "~/go/bin:/gobin:ro",
  "~/.pi/agent/lsp.sandbox.json:/home/pi/.pi/agent/lsp.json:ro",
  "~/.pi/agent/lsp.sandbox.lock.json:/home/pi/.pi/agent/lsp/lsp.lock.json:ro"
]
```

The adapter resolves every path from the **home directory**, not from `PI_CODING_AGENT_DIR`, so its config is `$HOME/.pi/agent/lsp.json` and never `/pi-agent/lsp.json`. A server counts as missing until it appears in `lsp.lock.json` — even with `"installMode": "off"` and an absolute `bin` — and `/lsp install` is interactive, so a headless run cannot fix it: mount a lockfile naming the container path (`{"servers": {"gopls": {"installer": "system", "resolvedCommand": ["/gobin/gopls"]}}}`).

No volume is needed for this. The adapter's writable directories (`pids`, `logs`, `cache`, `workspaces`) are created by the image, stay empty across a run, and the index that actually costs time belongs to the language server, which keeps it under `$HOME/.cache` — a volume you already have.

## Running somewhere else: `--cwd`

`--cwd <path>` moves the agent's working directory without moving you:

```bash
/pi:delegate --preset go-developer --cwd ~/proj/bookmarks   implement SPEC.md
/pi:review --cwd ../other-repo
```

Only the agent moves. The directory is what gets bind mounted at `/workspace/<dirname>`, what pi runs in, and the tree `review` diffs — while the job records stay in the workspace you typed the command in, so `status`, `watch`, `steer` and `result` keep finding the job. A missing path is an error before the job exists, because the usual cause is a typo and an agent started in the wrong tree is worse than one not started.

Configuration does **not** follow: presets, prompts and `.claude/pi/config.json` come from your workspace, never from the target. To pick up the target's own instructions, say so: `--append-system-prompt @../other-repo/.claude/pi/SYSTEM.md`.

`--mount host:container[:ro]` adds one more directory to whatever profile the run ended up with:

```bash
/pi:delegate --preset go-fix --mount ~/proj/shared-lib:/shared:ro   port this module to the new API
```

It is repeatable, and a relative host path (`./fixtures:/fixtures:ro`) resolves against the workspace rather than being read by docker as a named volume. Mounting onto a container path the profile already uses replaces that mount instead of adding a second one. Without a sandbox there is nowhere to mount into and the flag is an error, not a no-op.

**A git worktree works as the working directory, with nothing to mount by hand.** A worktree owns no repository: its `.git` is a file naming the absolute path of the shared one, which the container would otherwise not have. The companion detects this from `--cwd` and mounts that repository at exactly the path the file names, adding a `Worktree: shared … mounted` line to the run header. This is what makes several agents work in one repository at once — one worktree and one background job per branch. The mount must be writable, since git keeps each worktree's index and HEAD inside it.

## Concurrency: slots and pools

`maxConcurrent` caps how many containers of one profile run at once. A run over the cap **waits for a slot** instead of failing: when the provider behind the profile limits parallel sessions, the extra runs would otherwise be cut off mid-flight. Its log shows `Waiting for a free slot: profile <name> is at its limit of N`, and the wait is bounded by the run's own timeout. Slots are counted from live docker containers, not from job records.

**Several profiles can share one allowance** when the limit belongs to the provider rather than to a profile:

```json
"concurrencyPools": { "ollama-pro": 3 },
"sandboxProfiles": {
  "agent-base": { "image": "pi-sandbox-agent:latest", "concurrencyGroup": "ollama-pro" },
  "agent":      { "profile": "agent-base" }
}
```

`agent-base` and `agent` now draw from the same three slots instead of three each. Keeping the number with the pool means profiles cannot disagree about how many sessions the provider allows, and a reference to an undefined pool is an error before the run starts rather than a silent "no limit". The run header shows occupancy at launch — `Slots: 2/3 in use · pool ollama-pro`. Containers are named `pi-<profile>-<job-id>`, so `docker ps` shows which profile holds a slot.

`memory`, `cpus` and `pidsLimit` are optional ceilings — leave them out and docker imposes none. They earn their place once runs go parallel: a language server indexing a large repository holds several hundred megabytes on its own. A profile passes them down to any profile built on it, and `args` still takes any docker flag these three do not cover.

## One image per stack

A profile may name its own image and the Dockerfile that builds it:

```json
"sandboxProfiles": {
  "agent-base": { "image": "pi-sandbox-agent:latest", "dockerfile": "agent" },
  "node": { "image": "pi-sandbox-node:latest", "dockerfile": "node" }
}
```

```bash
/pi:sandbox                  # every image: built or missing, from which file, used by which profiles
/pi:sandbox build go         # build one, by image name or by profile name
/pi:sandbox build --all      # build everything the config knows about
```

Dockerfiles are looked up as `<name>.Dockerfile` in `<workspace>/.claude/pi/sandbox`, then `~/.claude/pi/sandbox`, then the plugin's own directory — the same layering as stored prompts. **Keep yours in `~/.claude/pi/sandbox/`**: the plugin is updated from git, so an image edited inside it is lost on the next pull, while a user file of the same name shadows the plugin's and survives.

The base image is the foundation — pi, git, ripgrep, make, the LSP adapter — and stack images build on it:

```dockerfile
FROM pi-plugin-sandbox:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
```

That example is not hypothetical: `go test -race` links the race runtime through cgo, so without a C compiler the race detector fails outright, and `CGO_ENABLED=1` is pinned in the image so a stray `CGO_ENABLED=0` cannot switch it back off.

Three kinds of tooling, three homes:

- **In the image** — anything versioned and reproducible: the language SDK, `gopls`, the C toolchain.
- **Mounted from the host** — locally built binaries no registry has: a linter carrying house rules, `mockery`, protoc plugins. They live in `~/go/bin`, which the profile mounts read-only.
- **Proxied, not copied** — the module cache. Bind mount the host download cache read-only and point Go at it: `GOPROXY=file:///host-gomod,https://proxy.golang.org,direct`. Gigabytes of already-fetched modules, private ones included, resolve instantly; the container never writes to the host cache and unpacks into its own volume. Verified with `--network none`: `go mod download` and `go test -race -count=1` both pass offline.

## The full inline form

The profile is configurable per preset, in full:

```json
"presets": {
  "caged": {
    "model": "opencode-go/kimi-k3",
    "sandbox": {
      "mode": "docker",
      "image": "pi-plugin-sandbox:latest",
      "network": "bridge",
      "agentDir": "volume",
      "env": ["ANTHROPIC_API_KEY"],
      "mounts": ["/opt/toolchain:/opt/toolchain:ro"],
      "memory": "4g",
      "cpus": 2,
      "pidsLimit": 512
    }
  }
}
```

`"sandbox": "docker"` is shorthand for the defaults, and `--sandbox none` switches a preset's sandbox back off for one run.

Two limits worth knowing: the workspace bind mount is read-write, so a sandboxed agent can still rewrite your checkout (that is the point — the isolation is about the rest of the machine), and the container-local agent directory means the extensions and skills you installed on the host are absent unless the preset asks for them explicitly.

## Related

- [dind.md](dind.md) — a docker daemon inside the sandbox, for testcontainers and compose stacks
- [git-proxy.md](git-proxy.md) — forge access from a sandbox: fetch through a per-run proxy, push refused
