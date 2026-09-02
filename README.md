# pi plugin for Claude Code

Delegate tasks and code reviews from Claude Code to [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) — on any model pi can reach, with a system prompt you choose per run.

Built in the shape of the official [Codex plugin](https://github.com/openai/codex-plugin-cc), with two things that plugin has no equivalent for: **explicit model selection** (pi speaks to hundreds of models across providers) and **presets** — complete agent profiles (model, thinking level, system prompt, tools, sandbox, extensions) you define once and use by name.

## What you get

| Command | Purpose |
| --- | --- |
| `/pi:delegate` | Hand a task to a pi agent: preset or model, system prompt, tool permissions, session. |
| `/pi:review` | Read-only code review of the working tree or a branch diff. |
| `/pi:watch` | Watch what the agent is doing: turns, tool calls, answers. |
| `/pi:steer` | Redirect a running agent mid-flight. |
| `/pi:models` | The model catalogue: context window, output ceiling, thinking and image support. |
| `/pi:presets` | The agents you configured — description, model with its ceilings, prompt, tools, sandbox — and the stored system prompts. |
| `/pi:status` | Running and recent pi jobs — this workspace, or every one with `--global`. |
| `/pi:result` | Stored output of a finished job, and `--diff` for what it changed. |
| `/pi:wait` | Block until background jobs finish. |
| `/pi:cancel` | Stop a running job (soft abort first), or `--all` of them. |
| `/pi:continue` · `/pi:sessions` | Continue a pi session with the run's own preset, or list what can be continued. |
| `/pi:sandbox` | Build and inspect the container image runs are isolated in. |
| `/pi:setup` | Check that pi is installed, authenticated and configured. |
| `/pi:runs` · `/pi:rerun` | The journal as a list, and the same task again — same settings or a different model. |
| `pia stats` | Token usage across every workspace, grouped by day, model, preset or project. |
| `pia events` | One line per finished run, across every workspace — a wake-up channel for a supervisor. |

Plus the `pi:pi-delegate` subagent (so Claude can delegate without a slash command) and the `pi-cli-runtime` skill (so Claude knows how pi's flags, sessions and event stream behave).

The same functionality is packaged as a **standalone skill** in [`skills/pi`](skills/pi) — handy for iterating without reinstalling a plugin:

```bash
ln -s "$PWD/skills/pi" ~/.claude/skills/pi
```

## Requirements

- Node.js 18.18+ (22.3+ for the run journal, which is skipped on older versions)
- pi: `npm install -g @earendil-works/pi-coding-agent`
- At least one provider pi can authenticate against (run `pi`, then `/login`)
- Docker, if you want runs isolated in a sandbox

## Install

```bash
/plugin marketplace add slipros/pi-plugin-cc
/plugin install pi@pi-tools
/reload-plugins
/pi:setup
```

### `pia` — the same companion from a shell

Every slash command is a subcommand of one node script, and outside Claude Code — in a brief, in a hook, in a terminal — that script otherwise has to be named by a fifty-character path. [`bin/pia`](bin/pia) is a shim that works out the path itself, following symlinks, so it serves a checkout and an installed skill alike:

```bash
ln -s "$PWD/bin/pia" ~/.local/bin/pia
pia presets      # the agents this setup offers, and what each is for
pia status       # running and recent jobs
```

Run it with no arguments for the full command list. Every example in [`skills/pi/SKILL.md`](skills/pi/SKILL.md) is written for this entry point.

## Quick start

```bash
# one task, one model, right here
pia delegate --model opencode-go/kimi-k3 --thinking high  "fix the failing auth test"

# a configured agent, isolated in a container, detached
pia delegate --preset go-developer --background --cwd ~/proj/api  "implement SPEC.md"

# check in on it, redirect it, collect the result
pia watch <job> --since 149
pia steer <job> "stop reading files, start editing"
pia result <job> --diff

# review what the working tree has become
pia review --base main --model opencode-go/glm-5.2
```

Two things worth knowing on the first day:

- **A run without a sandbox edits your working tree with your permissions.** `git diff` before you commit; the plugin never commits anything on your behalf.
- **`--background` detaches the run.** It survives the shell, the terminal and a cancelled Claude Code turn; stop it with `pia cancel`.

## Documentation

The skill file ([`skills/pi/SKILL.md`](skills/pi/SKILL.md), in Russian) is what an agent loads on every invocation, so it holds the working commands and nothing else. The reasoning behind them lives here:

| File | What is in it |
| --- | --- |
| [docs/agents.md](docs/agents.md) | Choosing a model, a system prompt and the tool set; what `presets` prints and why a preset whose equipment will not arrive refuses to run |
| [docs/config.md](docs/config.md) | Config layers and merge rules, presets, budgets, continuation cache, output ceilings, environment variables |
| [docs/sandbox.md](docs/sandbox.md) | What the container gets, trusted workspaces, profiles and toolchains, images, `--cwd`/`--mount`, concurrency pools |
| [docs/jobs.md](docs/jobs.md) | Background runs, watching and steering, waiting and notifications, the fleet view, what a run changed |
| [docs/metrics.md](docs/metrics.md) | The run journal, what `ctx`, `tok/s` and cost actually measure, repeating a run, what the proxy records |
| [docs/git-identity.md](docs/git-identity.md) | Who the agent commits as, and how `includeIf` keeps working inside a container |
| [docs/git-proxy.md](docs/git-proxy.md) | Forge access from a sandbox: fetch through a per-run proxy, push refused |
| [docs/dind.md](docs/dind.md) | A docker daemon inside the sandbox, parallel runs, the host-side registry mirror |

Research notes behind some of the decisions — decoding collapse, provider throughput, truncation — are in `docs/RESEARCH-*.md` and `docs/DESIGN-*.md` (in Russian).

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

A sandboxed run adds two host-side proxies between the container and the outside world: one holds the provider key and the other forwards git fetch, so neither credential ever enters the container.

## Development

```bash
npm test     # node --test, no dependencies
```

## License

MIT
