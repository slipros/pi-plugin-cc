# pi plugin for Claude Code

Delegate tasks and code reviews from Claude Code to [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) — on any model pi can reach, with a system prompt you choose per run.

Built in the shape of the official [Codex plugin](https://github.com/openai/codex-plugin-cc), with two things that plugin has no equivalent for: **explicit model selection** (pi speaks to hundreds of models across providers) and **presets** — complete agent profiles (model, thinking level, system prompt, tools, extensions) you define once and use by name.

## What you get

| Command | Purpose |
| --- | --- |
| `/pi:delegate` | Hand a task to a pi agent: preset or model, system prompt, tool permissions, session. |
| `/pi:review` | Read-only code review of the working tree or a branch diff. |
| `/pi:watch` | Watch what the agent is doing: turns, tool calls, answers. |
| `/pi:steer` | Redirect a running agent mid-flight. |
| `/pi:models` | The model catalogue: context window, output ceiling, thinking and image support. |
| `/pi:presets` | The agents you configured — description, model, prompt, tools, sandbox — and the stored system prompts. |
| `/pi:status` | Running and recent pi jobs — this workspace, or every one with `--global`. |
| `/pi:result` | Stored output of a finished job, and `--diff` for what it changed. |
| `/pi:wait` | Block until background jobs finish. |
| `/pi:cancel` | Stop a running job (soft abort first), or `--all` of them. |
| `runs` | The journal as a list: what was run, what it was asked, what it cost. |
| `rerun` | Run a recorded task again — same settings, or a different model. |
| `/pi:sandbox` | Build and inspect the container image runs are isolated in. |
| `stats` | Token usage across every workspace, grouped by day, model, preset or project. |
| `/pi:setup` | Check that pi is installed, authenticated and configured. |

Plus the `pi:pi-delegate` subagent (so Claude can delegate without a slash command) and the `pi-cli-runtime` skill (so Claude knows how pi's flags, sessions and event stream behave).

The same functionality is also packaged as a **standalone skill** in [`skills/pi`](skills/pi) — handy for iterating without reinstalling a plugin:

```bash
ln -s "$PWD/skills/pi" ~/.claude/skills/pi
```

## Requirements

- Node.js 18.18+
- pi: `npm install -g @earendil-works/pi-coding-agent`
- At least one provider pi can authenticate against (run `pi`, then `/login`)

## Install

```bash
/plugin marketplace add slipros/pi-plugin-cc
/plugin install pi@pi-tools
/reload-plugins
/pi:setup
```

### `pia` — the same companion from a shell

Every slash command is a subcommand of one node script, and outside Claude Code
— in a brief, in a hook, in a terminal — that script otherwise has to be named
by a fifty-character path, kept correct in every place it is written down.
[`bin/pia`](bin/pia) is a shim that works out the path itself, following
symlinks, so it serves a checkout and an installed skill alike:

```bash
ln -s "$PWD/bin/pia" ~/.local/bin/pia
pia presets      # the agents this setup offers, and what each is for
pia status       # running and recent jobs
```

Run it with no arguments for the full command list. Every example in
[`skills/pi/SKILL.md`](skills/pi/SKILL.md) is written for this entry point.

## Choosing a model

Every run command takes the same selection flags:

```bash
/pi:delegate --model opencode-go/kimi-k3 --thinking high   fix the failing auth test
/pi:delegate --provider anthropic --model claude-sonnet-5  refactor the retry logic
/pi:review   --model opencode-go/glm-5.2 --base main
```

- `--model` accepts `provider/id`, a bare id, or a substring that matches exactly one catalogue entry (`kimi` → `opencode-go/kimi-k3`). The plugin checks your local catalogue first and warns when a name matches nothing or several things; the name is passed to pi either way, so a model the catalogue does not know about still runs.
- `--thinking off|minimal|low|medium|high|xhigh|max` sets reasoning effort.
- `--preset <name>` applies a named bundle from your config (see below).
- With no flags at all, pi uses its own configured default model.

`/pi:models [search]` prints the catalogue with context windows and thinking support. Presets and stored prompts are `/pi:presets`, which answers a different question — not "what can answer me" but "who should do the work" — and answers it without walking several hundred catalogue entries.

## Choosing a system prompt

One flag, three kinds of value:

```bash
/pi:delegate --system-prompt explorer                 how does session resumption work here?
/pi:delegate --system-prompt @.claude/pi/prompts/dba.md   explain this query plan
/pi:delegate --system-prompt "Answer in one sentence"     what does this module do?
```

- **A name** — looked up in `.claude/pi/prompts/<name>.md`, then `~/.claude/pi/prompts/<name>.md`, then the prompts shipped with the plugin. A project file shadows a built-in of the same name.
- **`@path`** (or any path ending in `.md`/`.txt`) — a file.
- **Anything else** — the prompt text itself.

Four prompts ship with the plugin:

| Name | For |
| --- | --- |
| `reviewer` | Structured code review: verdict, findings by severity, notes. |
| `adversarial` | Challenges the design, not the syntax: assumptions, failure modes, rollback. |
| `fixer` | Makes a change: smallest correct edit, verifies it, reports what it could not verify. |
| `explorer` | Investigates and explains existing code with `file:line` citations. |

When nothing is set, `.claude/pi/SYSTEM.md` in the repository is used, and failing that pi keeps its own prompt. `--append-system-prompt <text|@file>` (repeatable) and `.claude/pi/APPEND_SYSTEM.md` add to whichever base was chosen instead of replacing it.

## Configuration

Optional. `~/.claude/pi/config.json` for personal defaults, `<repo>/.claude/pi/config.json` for project ones — the project file wins, and command-line flags win over both.

```json
{
  "defaults": {
    "model": "opencode-go/glm-5.2",
    "thinking": "medium",
    "timeoutMs": 1800000
  },
  "presets": {
    "fast":  { "model": "opencode-go/deepseek-v4-flash", "thinking": "off" },
    "deep":  { "model": "opencode-go/kimi-k3", "thinking": "high", "systemPrompt": "fixer" },
    "audit": { "model": "opencode-go/glm-5.2", "systemPrompt": "adversarial", "readOnly": true },
    "dba":   {
      "model": "opencode-go/kimi-k3",
      "thinking": "high",
      "systemPrompt": "@.claude/pi/prompts/dba.md",
      "appendSystemPrompt": ["Answer in Russian."],
      "tools": "read,grep,find,ls,bash",
      "extensions": ["npm:pi-mcp-adapter"],
      "timeoutMs": 3600000
    }
  },
  "commands": {
    "delegate": { "preset": "deep" },
    "review":   { "preset": "audit" }
  }
}
```

**A preset is a whole agent, not just a model.** Every field a run understands can live in one: `model`, `provider`, `thinking`, `systemPrompt`, `appendSystemPrompt`, `tools`, `excludeTools`, `extensions`, `skills`, `sandbox`, `mounts`, `git`, `readOnly`, `noTools`, `noBuiltinTools`, `noExtensions`, `noSkills`, `timeoutMs`, `engine`, `budget`. Define them once and run `--preset dba`.

Give each one a `description` as well — a single line saying what it is for. `/pi:presets` prints it next to the profile, which is how an agent picks one without opening the system prompt behind it.

### Budgets: stopping a run that costs too much

Time was the only ceiling a run had, and it is a poor proxy for the thing worth bounding — a fast model can spend a dollar in two minutes, a cheap one can idle for an hour for free.

```json
"presets": {
  "explorer": { "model": "opencode-go/kimi-k3", "budget": { "maxCostUsd": 2, "maxTurns": 40 } }
}
```

```bash
/pi:delegate --max-cost 0.5 --max-tokens 200000 --max-turns 20   refactor the parser
```

Each ceiling applies on its own, and the flags add to what a preset already set rather than replacing it. The numbers come from the usage the run already reports, checked after every model answer: on the rpc engine the run is asked to `abort`, so it wraps up and keeps whatever it has produced; on `--engine json` there is no control channel and the process is stopped the way a timeout stops it.

Enforcement is "stop after", never "predict before" — the size of a message is known only once it is paid for, so a budget can be crossed by the last message and no earlier. Set them as ceilings you do not want passed, not as exact allowances. A run stopped this way ends as a failure with `Stopped by the run budget: …` among its problems.

### Tuning a global preset for one project

The project file **merges into** your personal one field by field, so a repository names only what it changes. Keep the preset, swap the model, add a note and one more mounted directory:

```json
{
  "presets": {
    "go-review": {
      "model": "opencode-go/kimi-k3",
      "appendSystemPrompt": ["This service uses sqlc; migrations are generated, do not hand-edit them."]
    }
  },
  "sandboxProfiles": {
    "go": { "mounts": ["~/proj/protos:/protos:ro"] }
  }
}
```

The system prompt, `readOnly`, the sandbox and the whole Go toolchain come from the global definitions untouched. Three rules cover what "merges" means:

- **Equipment accumulates** — `appendSystemPrompt`, `extensions`, `skills`, `mounts`, `env`, `args`. The project adds to the list rather than replacing it. An entry that collides with an inherited one takes its place: mounts are matched by container path, env by variable name, so `"mounts": ["~/other:/gobin:ro"]` redirects `/gobin` instead of mounting it twice.
- **Decisions are replaced** — `model`, `thinking`, `systemPrompt`, `sandbox`, `readOnly`, `tools`, `excludeTools`, `timeoutMs`. A project that lists `excludeTools` means exactly those.
- **`null` removes** — `"sandbox": null` drops a sandbox the global preset asked for. It is the way back out of a merge.

Nested objects merge the same way, so `"sandbox": {"network": "none"}` keeps the image, mounts and everything else the layer below set.

One default is set for you: `excludeTools` is `["ask_question"]`, because a delegated run has nobody at the keyboard and a question tool would burn a turn waiting for an answer that never comes. Set `"excludeTools": []` in any layer to hand it back.

Values resolve layer by layer, highest first: command-line flags → preset → per-command defaults → global defaults. Commit identity is the one exception: your gitconfig sits between the flags and the preset (see "Who the agent commits as"). The system prompt is chosen as a unit, so `--system-prompt` on the command line replaces a preset's prompt outright; `appendSystemPrompt`, `extensions`, `skills` and `mounts` stack across layers instead of replacing each other.

## Choosing the agent's tools

Built-in pi tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

```bash
/pi:delegate --read-only            investigate why the build fails   # read, grep, find, ls + LSP navigation
/pi:delegate --tools read,grep,bash reproduce the bug, change nothing
/pi:delegate --exclude-tools bash   fix the types, do not run commands
/pi:delegate --no-tools             think out loud about the architecture
/pi:delegate --write                override a preset's read-only setting
```

`--read-only` and `--write` are the top layer: they outrank both the preset and the command's defaults, which is why `review --write` lifts the read-only setting review is configured with. `--stdin` appends piped input to the prompt, for handing over a brief without quoting it.

`--read-only` also keeps the LSP navigation tools — `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_more` — since finding who calls a symbol changes nothing and is exactly what a review needs. `lsp_diagnostics` is left out: gates decide whether code is broken. Note `--tools` is an allow list, so spelling one out drops everything you did not name, LSP included.

Anything beyond the built-ins comes from pi extensions — including MCP servers, via the `pi-mcp-adapter` extension that reads your project's `.mcp.json`:

```bash
/pi:delegate --extension npm:pi-mcp-adapter   query the database over MCP
/pi:delegate --extension ./tools/my-ext.ts --skill ./skills/db  …
/pi:delegate --no-extensions                  clean run, no third-party tools
```

pi itself has **no sandbox** — by default `bash`, `edit` and `write` run with your permissions. `/pi:review` is read-only by configuration and `/pi:delegate` allows writes; either can be flipped for one run with `--read-only` or `--write`, which outrank both the preset and the command's defaults. A delegated run that edited files leaves those edits in your working tree: review them with `git diff` before committing, the plugin never commits anything. For real isolation, see the next section.

## Sandboxing a run

`--sandbox docker` runs the whole pi process inside a container: built-in tools, `!` commands and extensions all execute there, and the only thing mounted from the host is the workspace.

```bash
/pi:sandbox build                    # build the image (pinned to your pi version)
/pi:delegate --sandbox docker        rewrite this module and run the tests
/pi:sandbox                          # image state and leftover containers
/pi:sandbox clean                    # remove containers a crash left behind
```

What the container gets:

| | |
| --- | --- |
| Workspace | bind mounted at `/workspace/<dirname>`, read-write — the directory keeps its name, so build recipes reading `$(notdir $(CURDIR))` compute the same value inside and out |
| Agent directory | a named docker volume, so host settings, sessions and installed pi packages stay out |
| Credentials | Never enter the container: a run-scoped proxy on the host holds the real key and the agent gets a token that dies with the run. The container also sees a generic `sandbox/agent-model` rather than the real provider and model, so a run cannot move itself to a pricier one — the proxy decides what answers |
| Provider definitions | `~/.pi/agent/models.json` bind mounted read-only, so custom providers (a local gateway, ollama, llama.cpp) resolve to the same models as on the host |
| Identity | your uid/gid, so files written through the mount are not owned by root |
| Network | on by default, because the model call needs it |

The rest of your home directory, your SSH keys and everything outside the workspace are simply not there. Sessions live in the volume, so `--session last` keeps working across sandboxed runs — but a session started on the host cannot be continued in the sandbox, and vice versa.

Extensions loaded from host paths (`--extension ~/.pi/agent/extensions/…`) do not exist inside the container; the plugin warns when a run asks for one. `npm:` and `git:` sources are fetched inside the container and work normally.

### Trusted workspaces: what a repository may decide

Two things hang off one list:

```json
{ "trustedProjects": ["~/github"], "presets": { } }
```

Entries match by prefix, so one line covers everything under it — `"trustedProjects": ["~/github"]` vouches for every repository beneath that directory. `"trustProjectConfig": true` is the blunt version: trust every workspace, wherever it is, which restores exactly the behaviour this plugin had before any of this existed.

For a workspace **not** covered by either:

- its `.claude/pi/config.json` is sanitized — it may still choose a model, prompts and a toolchain, but not `mounts`, `env`, `agentDir`, `volume`, `user`, `image`, `network`, `args`, `mode`, `isolateCaches` or `onFinish`. What was stripped is printed with the run.
- its **caches are not shared**. Named volumes the profile mounts writable — the Go module cache, the build cache, the gopls index — are replaced with anonymous volumes that die with the container, and the agent directory (sessions, model store) becomes one volume per workspace. Read-only mounts and host directories you named yourself are untouched.

The reason is one vector: those volumes outlive the run and are shared by every other one. A module or a build object written by a repository you cloned from the internet would be picked up by the next run, in a different repository. An untrusted run pays for it with a cold build cache — modules still resolve instantly from the host download cache, which is mounted read-only through `GOPROXY=file://`.

Sessions are split per workspace regardless of trust, through `PI_CODING_AGENT_SESSION_DIR`: pi buckets them by working directory, but containers used to share one flat `/workspace`, so one bucket used to hold the transcripts of every repository this machine had ever touched — and `--session last` could resume a session from a different project. Sessions recorded before this are still in the old shared bucket; nothing migrates them, they simply stop being visible to new runs.

### Sandbox profiles: giving an agent its toolchain

The container is deliberately bare — node, git, ripgrep. An agent that has to build Go, run a linter or honour your commit gates needs those tools inside, and that equipment is the same for every Go preset you own. So it is named once, under `sandboxProfiles`, and referenced by name:

```json
{
  "sandboxProfiles": {
    "go": {
      "mounts": [
        "/home/linuxbrew/.linuxbrew/opt/go/libexec:/usr/local/go:ro",
        "~/go/bin:/gobin:ro",
        "~/.pi/agent/extensions:/pi-agent/host-extensions:ro",
        "pi-plugin-gomod:/home/pi/go/pkg/mod",
        "pi-plugin-gocache:/home/pi/.cache"
      ],
      "env": ["PATH=/usr/local/go/bin:/gobin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
      "extensions": [
        "/pi-agent/host-extensions/custom-gcl-precommit.ts",
        "/pi-agent/host-extensions/claude-hooks.ts"
      ]
    }
  },
  "presets": {
    "go-fix":    { "model": "opencode-go/kimi-k3", "systemPrompt": "fixer",      "sandbox": "go" },
    "go-review": { "model": "opencode-go/glm-5.2", "systemPrompt": "adversarial", "sandbox": "go", "readOnly": true }
  }
}
```

A profile understands the same fields as an inline sandbox object, plus two that only make sense with one:

- `extensions` / `skills` — loaded **only** when the sandbox is active, so they can point at container paths that do not exist on your host. This is where gate extensions belong: a pre-commit linter gate that is missing inside the container does not fail loudly, it just stops gating.

**Language servers.** The image ships the `pi-lsp-adapter` extension (`/usr/local/lib/node_modules/pi-lsp-adapter/src/index.ts`) so a run gets `lsp_definition`, `lsp_references`, `lsp_workspace_symbols` and `lsp_diagnostics` without downloading anything. The server itself is bind mounted from the host — `gopls` is a static Go binary and runs as it is. Two things the adapter needs, and one trap:

```json
"mounts": [
  "~/go/bin:/gobin:ro",
  "~/.pi/agent/lsp.sandbox.json:/home/pi/.pi/agent/lsp.json:ro",
  "~/.pi/agent/lsp.sandbox.lock.json:/home/pi/.pi/agent/lsp/lsp.lock.json:ro"
]
```

The adapter resolves every path from the **home directory**, not from `PI_CODING_AGENT_DIR`, so its config is `$HOME/.pi/agent/lsp.json` and never `/pi-agent/lsp.json`. A server is treated as missing until it appears in `lsp.lock.json` — even with `"installMode": "off"` and an absolute `bin` — and `/lsp install` is interactive, so a headless run cannot fix it: mount a lockfile naming the container path (`{"servers": {"gopls": {"installer": "system", "resolvedCommand": ["/gobin/gopls"]}}}`).

Nothing about this needs a volume. The adapter's writable directories (`pids`, `logs`, `cache`, `workspaces`) are created by the image with permissive modes, they stay empty across a run, and the index that actually costs time to rebuild belongs to the language server, which keeps it under `$HOME/.cache` — a volume you already have. Let the adapter's state die with the container.
- Everything else (`image`, `network`, `mounts`, `env`, `args`, `agentDir`, `user`) behaves as above.

Mechanics worth knowing:

- Host binaries are not copied in, they are bind mounted: `~/go/bin:/gobin:ro` makes the same file on disk visible at `/gobin` inside, read-only. Statically linked binaries (anything built by Go) run as-is; something linked against host libraries would need to be installed in the image instead.
- `env` entries take both forms: `"NAME"` forwards the host value, `"NAME=value"` sets one for the container. A mounted binary is useless until `PATH` names its directory.
- Named volumes (`pi-plugin-gomod:/home/pi/go/pkg/mod`) keep module and build caches between runs; without them every run recompiles the world.
- `"sandbox": {"profile": "go", "network": "none"}` starts from a profile and overrides single fields. Equipment (`mounts`, `env`, `extensions`, `skills`, `args`) adds to the profile rather than replacing it, so `{"profile": "go", "env": ["PI_HOOKS=…"]}` keeps the profile's `PATH` — without which every mounted binary is unreachable. An entry colliding with an inherited one still wins its slot.
- A profile may itself name a `profile`, so `agent` is `agent-base` plus the docker daemon instead of a copy of it. A cycle is reported, not hung.

`--sandbox <name>` also takes a profile name on the command line, so `--sandbox go` works for a one-off run.

### Running somewhere else: --cwd

`--cwd <path>` moves the agent's working directory without moving you:

```
/pi:delegate --preset go-developer --cwd ~/proj/bookmarks   implement SPEC.md
/pi:review --cwd ../other-repo
```

Only the agent moves. The directory is what gets bind mounted at `/workspace/<dirname>`, what pi runs in, and the tree `review` diffs — while the job records stay in the workspace you typed the command in, so `status`, `watch`, `steer` and `result` keep finding the job without you leaving your own repository. The run header and `status` show a `Working directory` line, and a directory outside your workspace also raises a warning: the edits land there, not here.

A missing path is an error before the job exists, because the usual cause is a typo and an agent started in the wrong tree is worse than one not started. Relative and `~` paths resolve against your current directory, then expand to the enclosing git root.

Configuration does **not** follow: presets, prompts and `.claude/pi/config.json` come from your workspace, never from the target. `--cwd` hands the agent code, not somebody else's settings. To pick up the target's own instructions, say so: `--append-system-prompt @../other-repo/.claude/pi/SYSTEM.md`.

`--mount host:container[:ro]` adds one more directory to whatever profile the run ended up with, without restating it — a sibling repository, a directory of protobufs, a data set:

```
/pi:delegate --preset go-fix --mount ~/proj/shared-lib:/shared:ro   port this module to the new API
```

It is repeatable, and a relative host path (`./fixtures:/fixtures:ro`) resolves against the workspace rather than being read by docker as a named volume. Mounting onto a container path the profile already uses replaces that mount instead of adding a second one, so a run can redirect `/gobin` as well as extend the profile. Without a sandbox there is nowhere to mount into and the flag is an error, not a no-op.

**A git worktree works as the working directory, with nothing to mount by hand.** A worktree owns no repository: its `.git` is a file naming the absolute path of the shared one, which the container would otherwise not have. The companion detects this from `--cwd` and mounts that repository at exactly the path the file names, adding a `Worktree: shared … mounted` line to the run header. This is what makes several agents work in one repository at once — one worktree and one background job per branch. The mount must be writable, since git keeps each worktree's index and HEAD inside it, so overriding it with a read-only `--mount` breaks `git add`.

### One image per stack

A profile may name its own image and the Dockerfile that builds it:

```json
"sandboxProfiles": {
  "agent-base": { "image": "pi-sandbox-agent:latest", "dockerfile": "agent" },
  "node": { "image": "pi-sandbox-node:latest", "dockerfile": "node" }
}
```

```
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

That example is not hypothetical: `go test -race` links the race runtime through cgo, so without a C compiler the race detector — part of any serious test gate — fails outright, and `CGO_ENABLED=1` is pinned in the image so a stray `CGO_ENABLED=0` cannot switch it back off.

Three kinds of tooling, three homes:

- **In the image** — anything versioned and reproducible: the language SDK, `gopls`, the C toolchain.
- **Mounted from the host** — locally built binaries no registry has: `custom-gcl` (golangci-lint carrying house rules), `mockery`, protoc plugins. They live in `~/go/bin`, which the profile mounts read-only.
- **Proxied, not copied** — the module cache. Bind mount the host download cache read-only and point Go at it: `GOPROXY=file:///host-gomod,https://proxy.golang.org,direct`. Gigabytes of already-fetched modules, private ones included, resolve instantly; the container never writes to the host cache and unpacks into its own volume. Verified with `--network none`: `go mod download` and `go test -race -count=1` both pass offline.

## Deeper reading

The skill file (`skills/pi/SKILL.md`) is what an agent loads on every invocation, so it holds the working commands and nothing else. The reasoning behind them lives here:

- [docs/sandbox.md](docs/sandbox.md) — sandbox profiles, images, concurrency pools, why provider keys never enter the container
- [docs/git-proxy.md](docs/git-proxy.md) — forge access from a sandbox: fetch through a per-run proxy, push refused
- [docs/dind.md](docs/dind.md) — a docker daemon inside the sandbox, parallel runs, the host-side registry mirror
- [docs/telemetry.md](docs/telemetry.md) — what `ctx`, `tok/s` and cost actually measure
- [docs/config.md](docs/config.md) — config layers, presets, what a project may override

### Containers inside the sandbox

Integration tests that start a database container need a docker daemon of their own — the `agent` profile (`PI_DIND=1`) gives the run one, with no host socket and no `--privileged`. What it takes to run rootless docker inside a container, what stays parallel-safe with several such runs at once, and the one-time host setup that keeps image pulls cheap: **[docs/dind.md](docs/dind.md)**.

### The full inline form

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

`maxConcurrent` caps how many containers of one profile run at once. A run over the cap **waits for a slot** instead of failing: when the provider behind the profile limits parallel sessions, the extra runs would otherwise be cut off mid-flight. Its log shows `Waiting for a free slot: profile <name> is at its limit of N`, and the wait is bounded by the run's own timeout. Slots are counted from live docker containers, not from job records.

**Several profiles can share one allowance** when the limit belongs to the provider rather than to a profile. The profile names a pool; the pool's size is declared once, at the root of the config:

```json
"concurrencyPools": { "ollama-pro": 3 },
"sandboxProfiles": {
  "agent-base": { "image": "pi-sandbox-agent:latest", "concurrencyGroup": "ollama-pro" },
  "agent":      { "profile": "agent-base" }
}
```

`agent-base` and `agent` now draw from the same three slots instead of three each. Keeping the number with the pool means profiles cannot disagree about how many sessions the provider allows, and a reference to an undefined pool is an error before the run starts rather than a silent "no limit". All of it is optional: without `concurrencyGroup` a profile falls back to its own `maxConcurrent`, and without that there is no cap at all.

The run header shows occupancy at launch — `Slots: 2/3 in use · pool ollama-pro`, and `— this run waits for a free slot` when none is left.

Containers are named `pi-<profile>-<job-id>` (`pi-go-delegate-msonq…`), so `docker ps` shows which profile is holding a slot.

`memory`, `cpus` and `pidsLimit` are optional ceilings — leave them out and docker imposes none, which is how runs behaved before they existed. They earn their place once runs go parallel: a language server indexing a large repository holds several hundred megabytes on its own, so a few containers at once are gigabytes on the host. A profile passes them down to any profile built on it, and `args` still takes any docker flag these three do not cover.

Two limits worth knowing: the workspace bind mount is read-write, so a sandboxed agent can still rewrite your checkout (that is the point — the isolation is about the rest of the machine), and the container-local agent directory means the extensions and skills you installed on the host are absent unless the preset asks for them explicitly.

## Watching and steering a running agent

Delegated runs are not black boxes. Every job records pi's full event stream, and the run stays reachable while it works.

```bash
/pi:watch                        # what is the agent doing right now
/pi:watch --tail 20              # just the tail
/pi:watch <job> --since 149      # only what happened since the last check
/pi:watch <job> --follow --for 30  # stream for 30 seconds, then return
/pi:watch <job> --follow         # stream until the job ends

/pi:steer  hold on — stop reading files and start editing
/pi:steer  --follow-up  when you are done, add tests
```

Every snapshot ends with a cursor, and `--since <cursor>` picks up from there. That is what makes a background job followable from inside a Claude Code turn: check in, get only the new events, steer if needed, check in again. `--follow` on its own never returns while the agent works, so pair it with `--for <seconds>` unless you are running it yourself in a terminal.

A steering message is delivered after the agent's current turn finishes its tool calls and **before the next model call**, so it redirects work in progress instead of interrupting a tool mid-run. `--follow-up` waits until the agent is otherwise done. If the job already settled, the message is sent as a new prompt in the same pi session.

This works because jobs run against a live `pi --mode rpc` session (`--engine json` switches back to a one-shot run, which is faster to start but cannot be steered). `/pi:cancel` uses the same channel: it asks pi to `abort` first — keeping the session and any partial output — and only escalates to signals if that does not land.

## Background jobs

Long runs belong in the background:

```bash
/pi:review --background
/pi:status
/pi:result
/pi:cancel
```

`--background` **detaches the run**: the command validates the preset and the sandbox, hands the work to a separate process, prints the job id and exits in about a second. The agent then outlives the shell that started it, so nothing has to hold a terminal (or a Claude Code turn) open for an hour, and nothing is killed by a stray `timeout` or a cancelled turn. Startup problems still surface in front of you — detaching happens after validation — and whatever the detached process says before it becomes a tracked job goes to the `Startup log` named in the output. Stop a run deliberately with `/pi:cancel`.

Token usage is recorded as the run goes, not only at the end: `/pi:status` shows `Usage: in … · out … · $…` for a job that is still working, updated on every model answer. One write per assistant turn, not per tool call.

**Waiting for one, or for all of them.** Nothing used to announce the end of a background run; the answer sat in a job record until somebody thought to look.

```bash
/pi:wait                       # the newest live job
/pi:wait <job> <job>           # these ones
/pi:wait --all --for 600       # everything running, up to ten minutes
```

`wait` exits non-zero if the deadline passed or a job did not finish cleanly, so a script can branch on it. For a notification instead of a wait, give the run a hook:

```json
"defaults": { "onFinish": "notify-send \"pi $PI_JOB_STATUS\" \"$PI_JOB_TITLE\"" }
```

```bash
/pi:delegate --notify 'echo "$PI_JOB_ID $PI_JOB_STATUS" >> ~/pi-runs.log'   fix the flaky test
```

The command runs on the host when the job reaches a terminal state — including a failed one, since "it finished" is the moment worth announcing — with `PI_JOB_ID`, `PI_JOB_KIND`, `PI_JOB_STATUS`, `PI_JOB_TITLE`, `PI_JOB_WORKSPACE`, `PI_JOB_RUN_ROOT`, `PI_JOB_MODEL`, `PI_JOB_SUMMARY`, `PI_JOB_ELAPSED` and `PI_JOB_LOG` in its environment. It is given ten seconds and then killed; a hook that fails is a line in the job log and nothing more. It may only come from your own config or the flag — a project config that names `onFinish` has it stripped, because the sandboxed agent can write that file through the mounted workspace.

**A fleet, not one job at a time.** State is bucketed per workspace, so a run started from another repository used to be invisible:

```bash
/pi:status --global            # every workspace on this machine
/pi:status --running           # only what is still going
/pi:status --model glm --preset go-developer
/pi:cancel --all               # every live job here
/pi:cancel --all --global      # everywhere
```

`cancel` now also acts on `pending` and `orphaned` jobs, not only `running` ones: both can still hold a container, and with it a slot of a concurrency pool.

## What the run changed

The report says what the agent *answered*; this says what it *did*. A snapshot of the tree is taken before pi starts, so the two can be told apart:

```bash
/pi:result                     # the answer, with a Changes section
/pi:result <job> --diff        # the patch itself
/pi:review --job <job>         # review exactly what that run changed
```

The Changes section lists the commits and the files, and — separately — the files that were **already** modified when the run started, so nobody reads their own work-in-progress as the agent's. `--diff` is read from the tree on demand rather than stored, and includes new untracked files, which `git diff` never shows.

One thing it cannot know: edits you make in the same tree while the run is going are counted as the agent's. In a worktree or with `--cwd` that does not happen; in a shared checkout it can.

## Who the agent commits as

```json
"defaults": { "git": { "name": "pi agent", "email": "pi@example.dev" } },
"presets": { "go-developer": { "git": { "email": "go-developer@example.dev" } } }
```

```
/pi:delegate --git-name "pi agent" --git-email pi@example.dev   implement SPEC.md
```

This sets `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, which git reads ahead of any config file — so one setting covers a sandboxed run (where `~/.gitconfig` may not exist at all) and a host run (where it does exist, but names you rather than the agent). The run header shows `Commits as: …`.

Name and email come as a pair: half an identity is refused before the run starts, since git would refuse the commit anyway. Layers merge field by field, so a global name and a per-preset address work.

**Order of precedence: flags, then your gitconfig, then a preset.** A `git` block in a preset or in `defaults` is a *fallback*, used only where git itself has no answer — it does not override the identity you configured for that tree. To make an agent commit as itself in a tree where you have an identity, pass the flags on the run.

**With no flags, the identity is read from the working directory.** The companion asks git, in the directory the agent will work in, who it would commit as — so `includeIf "gitdir:…"` rules keep working inside the sandbox:

```gitconfig
[includeIf "gitdir:~/work/"]
	path = ~/work/.gitconfig
[includeIf "gitdir:~/work/client/"]
	path = ~/work/client/.gitconfig
```

Rules apply top to bottom, so the narrower one goes below the general one. The lookup happens **on the host, before the container starts** — inside it never could: the repository is under `/workspace/` there, and the path the rule matches on does not exist.

## Token accounting

Job files answer "what is running now"; they cannot answer "what did this week cost" — they live in a temp tree, are split per workspace, keep the newest 50 each and vanish on reboot. So finished and starting runs are also appended to a durable SQLite journal at `~/.local/share/pi-plugin/jobs.db` (override with `PI_PLUGIN_DB`).

```
pi-companion.mjs stats                       # last 30 days, by day
pi-companion.mjs stats --by model            # how each model behaved
pi-companion.mjs stats --by preset --days 7
pi-companion.mjs stats --by workspace --all
pi-companion.mjs stats --by status           # how runs ended
pi-companion.mjs stats --by kind             # delegate versus review
pi-companion.mjs models --stats <search>     # the catalogue plus these numbers
```

The report is not only tokens: `ok` is the share of runs that finished, `ctx avg`/`ctx max` how much of the context window a run held at its peak, `tok/s` the model's speed, `p50`/`p90` run durations, `tools`/`err` tool calls and the errors among them.

**`ctx` answers "does this fit in the window", which the `in` column cannot.** Every turn resends the conversation, so the input total runs far ahead of what the model ever held at once — a four-turn run totalling 30K of input peaked at 10K of context. It is measured as the largest `input + cache + output` of a single exchange.

**`tok/s` is measured on the generation window itself** — first content frame to last chunk, summed over a run's requests and taken from the credential proxy. It replaced a rate measured against model time (the run minus its tools), whose denominator carried prefill, the provider's queue and the network: on one measured run that read 122 tok/s against a real 259.

Two exclusions, both deliberate. A run **without proxy telemetry** — recorded before this existed, or run without a sandbox — shows a dash instead of being folded in on the old measurement: two definitions of speed in one column is worse than a gap. And an **answer under 1,000 output tokens** does not count at all, because the tokens delivered in the first frame were generated before the window opened, and the shorter the answer the more that inflates the number. The `out/run` column next to the rate is the average answer length behind it — two buckets whose lengths differ several times over are not comparable, whatever the denominator says.

Two things this README used to claim, both since measured and both wrong. Tokens do **not** arrive in a few large batches — checked from both ends of the channel, the median gap between deltas is 11 ms. And **89% of a run does not go to gopls**: across 68 transcripts, tools took 35% of the time, of which gopls was 3.5% and bash 96% — nearly half of that one `go build ./...`. Before switching to a faster model, look at the task brief, not at the language server.

It uses `node:sqlite`, which ships with Node 22.3+ and needs no dependency; on older Node the journal is simply skipped and everything else works unchanged. Cost is only shown when the provider reports it — `ollama-pro` and `opencode-go` send zero, so there the honest answer is tokens, not money.

### Repeating a run, and comparing two

The journal also keeps the task, the answer and the settings a run used, which is what makes a run repeatable:

```bash
pi-companion.mjs runs                        # this workspace, newest first
pi-companion.mjs runs --all --days 7         # every workspace
pi-companion.mjs runs <id>                   # what it was asked, what it answered
pi-companion.mjs rerun <id>                  # again, same settings
pi-companion.mjs rerun <id> --model other/m  # same task, different model
pi-companion.mjs rerun <id> --append "and leave the migrations alone"
pi-companion.mjs rerun <id> --prompt "the task, rewritten"
pi-companion.mjs runs <id> --json | jq -r .prompt > task.md   # edit it yourself…
pi-companion.mjs rerun <id> --stdin < task.md                 # …and send it back
```

`rerun` keeps what you chose — preset, model, thinking level, sandbox, ceilings — and resolves everything else fresh from the config as it is now, so it repeats the run rather than a stale copy of your setup. Flags override the recipe, which is the point: the same task on two models is the only honest way to compare them on work you actually do.

The task is editable as well, since "that, but with one thing changed" is the common case: `--append` adds an instruction, `--prompt`/`--stdin` replaces the text and keeps everything else. Getting the text out to edit it by hand works too — `runs <id> --json` carries the journal's copy (redacted, capped at 32 KB), and `result <job> --json` the original in full while the job file survives. A replacement also revives a run whose stored text has aged out: the settings outlive the prompt.

**This is repository content on disk, so it is bounded.** Text is redacted for the shapes secrets announce themselves in (provider keys, bearer tokens, JWTs, `password=` assignments, credentials in URLs), capped at 32 KB a field, and expires after 90 days — `runs --prune [--days N]` sweeps on demand, and a sweep happens by itself at most once a day. Only the text expires: counters, timings and costs are kept forever, so statistics still cover the whole history. A random password with no recognisable shape is not caught by the redaction, and the journal file and its directory are 0600/0700 rather than the world-readable default.

### What the proxy measures

Every model request of a sandboxed run passes through the credential proxy, which is the only place on the host that sees the exchange whole. pi retries HTTP failures internally and carries six usage keys forward, so a run that hit three 429s and one dropped stream simply looked slow.

Each request is recorded as one row: status, `error_kind` (`transport`, `timeout`, `aborted`, `truncated`), time to first byte, time to first **content** frame, the generation window, the longest silence inside it, sizes, rate-limit headers, and the provider's own usage — with the raw blob kept only when it holds a key nobody has mapped. `runs <id>` prints the roll-up: how many requests, how many failed, median time to first token, the generation rate, and the time the run spent queued for a sandbox slot.

What is never recorded: messages, system prompts, tool definitions, response text, or request headers. The body is parsed a few lines away to rewrite the model name, so this is a discipline rather than a limitation — the same line `redactArgs` draws for command lines. Rows expire with the same 90-day retention.

Job state lives outside your repository, bucketed per workspace, and survives Claude Code restarts. Each record keeps the pi session id, so any run can be picked up in pi itself:

```bash
pi --session <session-id>
```

`/pi:delegate --session last` continues the most recent pi session in the workspace from Claude Code instead.

## How it works

```
/pi:delegate ──▶ commands/delegate.md ──▶ scripts/pi-companion.mjs
                                              │
                     ┌────────────────────────┼────────────────────────┐
                     ▼                        ▼                        ▼
              config + presets          system prompt             job state on disk
              model catalogue           (prompts/system/*.md)     jobs/<id>.{json,log,
                     │                                             events.jsonl,inbox.jsonl}
                     └────────────────────────┬────────────────────────┘
                                              ▼
                         pi --mode rpc --model … --system-prompt … --tools …
                            │                                    ▲
              events (JSONL) │                                    │ steer / follow_up / abort
                            ▼                                    │
              progress · transcript · usage · answer      inbox ◀─┴── /pi:steer, /pi:cancel
```

One `pi --mode rpc` process per job, with a two-way JSONL channel over stdin/stdout. Outbound: events become progress lines, a replayable transcript (`/pi:watch`), token usage and the final answer. Inbound: `/pi:steer` and `/pi:cancel` append to the job's inbox file, and the process owning the run forwards them into the live session as `steer`, `follow_up` or `abort`.

The inbox is a plain append-only JSONL file rather than a socket: it survives restarts, behaves identically on every platform, and you can read it with `cat` when something looks wrong.

## Development

```bash
npm test     # node --test, no dependencies
```

## License

MIT
