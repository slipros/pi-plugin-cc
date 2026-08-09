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
| `/pi:models` | List available models, presets and system prompts. |
| `/pi:status` | Running and recent pi jobs for this workspace. |
| `/pi:result` | Stored output of a finished job. |
| `/pi:cancel` | Stop a running job (soft abort first). |
| `/pi:sandbox` | Build and inspect the container image runs are isolated in. |
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

`/pi:models [search]` prints the catalogue with context windows and thinking support, followed by your presets and stored prompts.

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

**A preset is a whole agent, not just a model.** Every field a run understands can live in one: `model`, `provider`, `thinking`, `systemPrompt`, `appendSystemPrompt`, `tools`, `excludeTools`, `extensions`, `skills`, `sandbox`, `readOnly`, `noTools`, `noBuiltinTools`, `noExtensions`, `noSkills`, `timeoutMs`, `engine`. Define them once and run `--preset dba`.

One default is set for you: `excludeTools` is `["ask_question"]`, because a delegated run has nobody at the keyboard and a question tool would burn a turn waiting for an answer that never comes. Set `"excludeTools": []` in any layer to hand it back.

Values resolve layer by layer, highest first: command-line flags → preset → per-command defaults → global defaults. The system prompt is chosen as a unit, so `--system-prompt` on the command line replaces a preset's prompt outright; `appendSystemPrompt`, `extensions` and `skills` stack across layers instead of replacing each other.

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

pi itself has **no sandbox** — by default `bash`, `edit` and `write` run with your permissions. `/pi:review` is always read-only; `/pi:delegate` allows writes by default. A delegated run that edited files leaves those edits in your working tree: review them with `git diff` before committing, the plugin never commits anything. For real isolation, see the next section.

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
| Workspace | bind mounted at `/workspace`, read-write — edits land in your tree as usual |
| Agent directory | a named docker volume, so host settings, sessions and installed pi packages stay out |
| Credentials | `~/.pi/agent/auth.json` bind mounted read-only, so providers work without the rest of `~/.pi/agent` |
| Identity | your uid/gid, so files written through the mount are not owned by root |
| Network | on by default, because the model call needs it |

The rest of your home directory, your SSH keys and everything outside the workspace are simply not there. Sessions live in the volume, so `--session last` keeps working across sandboxed runs — but a session started on the host cannot be continued in the sandbox, and vice versa.

Extensions loaded from host paths (`--extension ~/.pi/agent/extensions/…`) do not exist inside the container; the plugin warns when a run asks for one. `npm:` and `git:` sources are fetched inside the container and work normally.

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
- Everything else (`image`, `network`, `mounts`, `env`, `args`, `agentDir`, `user`) behaves as above.

Mechanics worth knowing:

- Host binaries are not copied in, they are bind mounted: `~/go/bin:/gobin:ro` makes the same file on disk visible at `/gobin` inside, read-only. Statically linked binaries (anything built by Go) run as-is; something linked against host libraries would need to be installed in the image instead.
- `env` entries take both forms: `"NAME"` forwards the host value, `"NAME=value"` sets one for the container. A mounted binary is useless until `PATH` names its directory.
- Named volumes (`pi-plugin-gomod:/home/pi/go/pkg/mod`) keep module and build caches between runs; without them every run recompiles the world.
- `"sandbox": {"profile": "go", "network": "none"}` starts from a profile and overrides single fields.

`--sandbox <name>` also takes a profile name on the command line, so `--sandbox go` works for a one-off run.

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
      "args": ["--memory=4g"]
    }
  }
}
```

`"sandbox": "docker"` is shorthand for the defaults, and `--sandbox none` switches a preset's sandbox back off for one run.

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
