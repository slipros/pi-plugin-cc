# pi plugin for Claude Code

Delegate tasks and code reviews from Claude Code to [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) — on any model pi can reach, with a system prompt you choose per run.

Built in the shape of the official [Codex plugin](https://github.com/openai/codex-plugin-cc), with two things that plugin has no equivalent for: **explicit model selection** (pi speaks to hundreds of models across providers) and **per-run system prompts** (roles).

## What you get

| Command | Purpose |
| --- | --- |
| `/pi:delegate` | Hand a task to a pi agent. Picks model, role, tool permissions and session. |
| `/pi:review` | Read-only code review of the working tree or a branch diff. |
| `/pi:watch` | Watch what the agent is doing: turns, tool calls, answers. |
| `/pi:steer` | Redirect a running agent mid-flight. |
| `/pi:models` | List available models, presets and roles. |
| `/pi:status` | Running and recent pi jobs for this workspace. |
| `/pi:result` | Stored output of a finished job. |
| `/pi:cancel` | Stop a running job (soft abort first). |
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

## Choosing a model

Every run command takes the same selection flags:

```bash
/pi:delegate --model opencode-go/kimi-k3 --thinking high   fix the failing auth test
/pi:delegate --provider anthropic --model claude-sonnet-5  refactor the retry logic
/pi:review   --model opencode-go/glm-5.2 --base main
```

- `--model` accepts `provider/id`, a bare id, a glob (`anthropic/*`) or a fuzzy substring — pi's own matching rules apply. The plugin checks your local catalogue first and warns when a name does not match anything.
- `--thinking off|minimal|low|medium|high|xhigh|max` sets reasoning effort.
- `--preset <name>` applies a named bundle from your config (see below).
- With no flags at all, pi uses its own configured default model.

`/pi:models [search]` prints the catalogue with context windows and thinking support, followed by your presets and roles.

## Choosing a system prompt

The agent pi runs is shaped by a **role** — a system prompt file. Four ship with the plugin:

| Role | For |
| --- | --- |
| `reviewer` | Structured code review: verdict, findings by severity, notes. |
| `adversarial` | Challenges the design, not the syntax: assumptions, failure modes, rollback. |
| `fixer` | Makes a change: smallest correct edit, verifies it, reports what it could not verify. |
| `explorer` | Investigates and explains existing code with `file:line` citations. Read-only. |

```bash
/pi:delegate --role explorer   how does session resumption work in this repo?
/pi:delegate --role fixer      make the flaky timeout test deterministic
/pi:review   --role adversarial --base main
```

Overrides, highest priority first:

1. `--system-prompt <text|@file>` — replaces the prompt entirely
2. `--role <name>` — a role file
3. `.claude/pi/SYSTEM.md` in the repository — the workspace default

`--append-system-prompt <text|@file>` (repeatable) and `.claude/pi/APPEND_SYSTEM.md` add to whichever base was chosen instead of replacing it.

Custom roles are just files. `.claude/pi/roles/<name>.md` in the repo, or `~/.claude/pi/roles/<name>.md` for all your projects, both shadow the built-ins of the same name.

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
    "deep":  { "model": "opencode-go/kimi-k3", "thinking": "high" },
    "audit": { "model": "opencode-go/glm-5.2", "role": "adversarial", "readOnly": true }
  },
  "commands": {
    "delegate": { "preset": "deep" },
    "review":   { "preset": "audit" }
  },
  "roles": {
    "go-reviewer": ".claude/pi/roles/go-reviewer.md"
  }
}
```

## Choosing the agent's tools

Built-in pi tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

```bash
/pi:delegate --read-only            investigate why the build fails   # read, grep, find, ls
/pi:delegate --tools read,grep,bash reproduce the bug, change nothing
/pi:delegate --exclude-tools bash   fix the types, do not run commands
/pi:delegate --no-tools             think out loud about the architecture
```

Anything beyond the built-ins comes from pi extensions — including MCP servers, via the `pi-mcp-adapter` extension that reads your project's `.mcp.json`:

```bash
/pi:delegate --extension npm:pi-mcp-adapter   query the database over MCP
/pi:delegate --extension ./tools/my-ext.ts --skill ./skills/db  …
/pi:delegate --no-extensions                  clean run, no third-party tools
```

pi has **no sandbox** — `bash`, `edit` and `write` run with your permissions. `/pi:review` is always read-only; `/pi:delegate` allows writes by default. A delegated run that edited files leaves those edits in your working tree: review them with `git diff` before committing, the plugin never commits anything.

## Watching and steering a running agent

Delegated runs are not black boxes. Every job records pi's full event stream, and the run stays reachable while it works.

```bash
/pi:watch                 # what is the agent doing right now
/pi:watch --tail 20       # just the tail
/pi:watch <job> --follow  # live stream until the job ends

/pi:steer  hold on — stop reading files and start editing
/pi:steer  --follow-up  when you are done, add tests
```

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
              config + presets          role/system prompt        job state on disk
              model catalogue           (prompts/roles/*.md)      jobs/<id>.{json,log,
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
