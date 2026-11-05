# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A Claude Code plugin (`pi-tools` marketplace → `pi` plugin) that delegates tasks and code reviews
to [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), on any model pi can reach.
It is pure Node ESM with **zero runtime dependencies** — `package.json` has no `dependencies` block
and none should be added; everything is built on `node:` built-ins.

## Commands

```bash
npm test                                  # node --test over tests/**/*.test.mjs
node --test tests/config.test.mjs         # one file
node --test --test-name-pattern "preset"  # one test by name

node plugins/pi/scripts/pi-companion.mjs             # usage / full flag reference
./bin/pia presets                                    # same CLI through the shim
PI_COMPANION=/path/to/pi-companion.mjs pia status    # drive another checkout's copy
```

There is no linter, formatter or build step. `npm test` is the whole gate.

`tests/git-proxy.e2e.test.mjs` shells out to the real `git` binary; `db.test.mjs` and the journal
need Node 22.3+ (`node:sqlite`). Tests isolate themselves via `CLAUDE_PLUGIN_DATA`, `PI_PLUGIN_DB`,
`XDG_DATA_HOME` and `GIT_CONFIG_GLOBAL`; `npm test` preloads `tests/isolate-env.mjs`, which strips
`PI_OTEL_*`/`OTEL_EXPORTER*` so no run exports to the developer's collector (a bare `node --test`
skips that preload). The git tests need git 2.32+ first in `PATH` (`GIT_CONFIG_GLOBAL`, `init -b`).
`PI_PLUGIN_BINARY` points the runtime at a generated
`fake-pi.mjs` (tests/recovery, tests/loop-nudge) driven by `PI_FAKE_*` env knobs, so no test ever
spends a token.

## Architecture

Everything is one CLI. Slash commands, the subagent and `pia` are all thin wrappers around
`plugins/pi/scripts/pi-companion.mjs`, which dispatches through the `COMMANDS` table near the end of
the file to one `command*` function per subcommand. `plugins/pi/scripts/lib/` holds the actual logic;
`pi-companion.mjs` mostly assembles flags → settings → a tracked job.

The four surfaces that must stay in sync when a flag or command changes:

| Surface | Location |
| --- | --- |
| Slash commands | `plugins/pi/commands/*.md` (frontmatter + instructions to the calling model) |
| Subagent | `plugins/pi/agents/pi-delegate.md` |
| Skill (Russian, loaded per invocation) | `skills/pi/SKILL.md` — `skills/pi/scripts` is a **symlink** to `plugins/pi/scripts` |
| CLI usage text | `usage()` and `KNOWN_FLAGS` in `pi-companion.mjs` |

An unknown flag is a hard error, not a silent drop (`--modle opus fix the bug` used to run the
default model on the task text "opus fix the bug"). Any new flag must be added to `KNOWN_FLAGS`.

### The run path

`executeRun()` resolves settings, then picks an engine: `runPiRpcTurn` (`lib/rpc.mjs`, default —
keeps a two-way JSONL channel over stdin/stdout so the run stays steerable) or `runPiTurn`
(`lib/pi.mjs`, one-shot `--mode json`; a job on this engine cannot be steered or aborted).
`lib/pi.mjs` owns what both share: `buildPiArgs`, event → state application, truncation recovery,
the reasoning-loop detector, `READ_ONLY_TOOLS`, `redactArgs`.

`--background` re-executes this same script detached, flagged by `PI_PLUGIN_DETACHED` with the job
id, prompt file and resolved session passed through `PI_PLUGIN_*` env vars — the child must not
re-resolve `--session last`, which would now match its own pending record.

### State, two stores

- **Job records** (`lib/state.mjs`) — JSON + log + `events.jsonl` + `inbox.jsonl` per job, under
  `$XDG_DATA_HOME/pi-plugin/state/<slug>-<sha256 prefix>/`, bucketed per workspace, capped at 50.
  Workspace identity is the git toplevel (`lib/workspace.mjs`), so a job started from a subdirectory
  lands in the same bucket. `--cwd` splits the two roots: the *run root* is where the agent works,
  the *workspace root* is where its records stay, so `status`/`watch` keep finding it.
- **Journal** (`lib/db.mjs`) — one SQLite file outside that lifecycle, written *alongside* the JSON
  records, never instead of them. Every journal write goes through `recordJobSafely`: if the
  database cannot be opened the CLI behaves exactly as before. `lib/telemetry.mjs` batches
  per-request rows (envelope only — never messages, prompts or response text).
- **Fleet events** (`lib/fleet-events.mjs`) — one machine-wide `fleet-events.jsonl` deliberately
  outside the per-workspace buckets, so a supervisor hears about every finished run.
- **OTLP export** (`lib/otel-export.mjs`) — host-side push of cumulative `pi.token.usage` /
  `pi.cost.usage` from the journal to a collector after every terminal run, fail-safe and
  dependency-free; both engines suppress `PI_OTEL_ENABLE` in the child pi's environment so a
  non-sandboxed run is never counted twice (`withoutOtel` in `pi.mjs` and `rpc.mjs`).

### Control channel

`/pi:steer` and `/pi:cancel` append to the job's `inbox.jsonl` (`lib/inbox.mjs`); the process owning
the run forwards them into the live session as `steer`, `follow_up` or `abort`.

### Config and presets

`lib/config.mjs` layers, lowest first: built-in defaults → user config → project config
(`.claude/pi/config.json` in the home directory and in the workspace respectively) → flags. Layers
merge field by field (`mergeConfigLayer`), so a project can retune one field of a global preset.
A **preset** is a complete agent profile: model, thinking, system prompt, tools, extensions, skills,
sandbox, limits. `sanitizeProjectLayer` is what a project layer is allowed to set — treat it as a
trust boundary.

`lib/capabilities.mjs` derives what an agent can do from the *resolved* settings rather than from
declared fields, on purpose: a hand-written `vision: true` outlives the mount that made it true.
`lib/prompts.mjs` resolves `systemPrompt` (inline text / `@file` / stored name) looking in project →
home → `plugins/pi/prompts/system/` so a project file shadows a built-in.

### Sandbox and the two proxies

`lib/sandbox.mjs` runs the whole pi process in a container (pi has no sandbox of its own — its
tools, `!` commands and extensions run with the pi process's permissions). The container gets the
workspace at `/workspace` and nothing else from the host agent directory.

Credentials never enter the container. `lib/credential-proxy.mjs` and `lib/git-proxy.mjs` run on the
host inside the process owning the run: the container is handed a random per-run token and a
loopback URL, the real key is attached on the way out, and the token dies with the process. The git
proxy forwards only the two fetch routes of smart-HTTP — `git-receive-pack` is refused before the
credential is attached, so push fails regardless of how broad the forge token is.

## Conventions

- **Comments explain *why*, at length.** Most modules open with a block comment stating the problem
  the module exists to solve and what was tried before; inline comments justify non-obvious choices
  (often naming the concrete failure that motivated them). Match this — a change that removes a
  constraint should also remove the comment defending it. Comments are English in newer modules,
  Russian in parts of `pi.mjs`, `rpc.mjs`, `render.mjs`, `db.mjs`, `telemetry.mjs`, `agent-work.mjs`;
  keep the language of the file you are editing.
- Documentation split: `README.md` is an overview only, `docs/*.md` hold the reasoning (English),
  `skills/pi/SKILL.md` holds the working commands (Russian) and nothing else. Research notes
  (`RESEARCH-*.md`, `DESIGN-*.md`) and their raw data are NOT in this repository: they live in the
  agents home, `~/.agents/docs/LLM/`, together with the working backlog — they are working notes,
  not product documentation, and they are shared with the neighbouring `llm-workflow` repository.
- User-facing output is Markdown built in `lib/render.mjs`; commands return
  `output(rendered, payload, asJson)` so every command has a `--json` form.
- Errors prefer refusing over guessing whenever a wrong guess costs a paid run (unknown flag,
  missing `--cwd` directory, preset whose sandbox mounts will not arrive).
- Commit messages: Conventional Commits, subject in Russian, no AI watermark.
