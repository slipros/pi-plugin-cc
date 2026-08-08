---
name: pi-cli-runtime
description: How to run pi (the @earendil-works/pi-coding-agent CLI) non-interactively from Claude Code — model and provider selection, thinking levels, system prompts, tool allowlists and extensions, sessions, and the JSON/RPC event streams. Use whenever you are about to invoke `pi` directly or through this plugin's companion script, or when a pi run fails and you need to read its output.
---

# Running pi from Claude Code

Prefer the companion script over raw `pi` calls: it tracks the job, captures the session id and renders a consistent report.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" delegate --preset deep "task text"
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" review --base main
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" watch [job-id] [--follow] [--tail n]
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" steer [job-id] [--follow-up] "instruction"
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" status|result|cancel [job-id]
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" models [search]
```

## Raw pi invocation

A non-interactive run needs `--print` (or `-p`). The prompt can be an argument or stdin.

```bash
pi --print --mode json --model opencode-go/glm-5.2 --thinking high "explain src/server.ts"
echo "explain src/server.ts" | pi -p --mode json
```

### Model selection

- `--model <pattern>` accepts `provider/id`, a bare id, a glob (`anthropic/*`), a fuzzy substring, and an optional `:<thinking>` suffix (`anthropic/claude-sonnet-5:high`).
- `--provider <name>` narrows the provider; `--api-key <key>` overrides credentials for the run.
- `--thinking off|minimal|low|medium|high|xhigh|max` sets reasoning effort. Models without reasoning ignore it.
- `pi --list-models [search]` prints the available catalogue as a table: `provider model context max-out thinking images`. A model missing from that table has no credentials configured.

### System prompts

- `--system-prompt <text>` replaces pi's default coding-assistant prompt.
- `--append-system-prompt <text|file>` adds to it and can be repeated.
- Project files pi reads on its own: `.pi/SYSTEM.md` (replace), `.pi/APPEND_SYSTEM.md` (append), plus `AGENTS.md`/`CLAUDE.md` context files. `--no-context-files` disables the latter.
- This plugin resolves `--system-prompt <name>` against `.claude/pi/prompts/<name>.md`, then `~/.claude/pi/prompts/<name>.md`, then the plugin's `prompts/system/<name>.md`. Built-ins are `reviewer`, `adversarial`, `fixer`, `explorer`. The same flag also accepts `@path/to/file.md` and inline text.

### Tools

Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

- `--tools read,grep,find,ls` is the read-only set used by reviews.
- `--exclude-tools bash` denies specific tools; `--no-builtin-tools` keeps only extension tools; `--no-tools` disables everything.
- `--extension <path|npm:pkg|git-url>` (repeatable) is how pi gains tools beyond the built-ins; `--skill <path>` loads a pi skill. `--no-extensions` / `--no-skills` ignore whatever was discovered.
- MCP servers reach pi through the `pi-mcp-adapter` extension, which reads `.mcp.json` / `~/.config/mcp/mcp.json` and exposes servers behind one proxy tool instead of dumping every tool definition into context.
- pi has **no sandbox**: `bash`, `edit` and `write` act with the permissions of the process. Only enable them when the task genuinely needs to change the repository.

### RPC mode: steering a live run

`pi --mode rpc` keeps a two-way JSONL channel on stdin/stdout, which is what makes a run steerable. Commands the plugin sends:

| Command | Effect |
| --- | --- |
| `{"type":"prompt","message":"…"}` | Start the work (or re-open a settled session). |
| `{"type":"steer","message":"…"}` | Delivered after the current assistant turn finishes its tool calls, before the next model call. |
| `{"type":"follow_up","message":"…"}` | Delivered once the agent has nothing left to do. |
| `{"type":"abort"}` | Stop the current operation without killing the session. |
| `{"type":"get_state"}` | Returns `sessionId`, model, streaming state. |

Framing is strict JSONL: split on `\n` only. Node's `readline` is **not** protocol-compliant here because it also splits on U+2028/U+2029, which are legal inside JSON strings.

Extra events in this mode: `queue_update` (pending steering/follow-up), `agent_settled` (the session really is done — `agent_end` alone may still be followed by a retry or a queued message).

### Sessions

- Sessions are saved to `~/.pi/agent/sessions/`, bucketed by working directory.
- `--session <path|id>` resumes a specific session (partial UUID works), `-c` continues the latest, `--fork <id>` branches, `--no-session` runs ephemerally.
- The session id is the first line of the JSON stream: `{"type":"session","id":"<uuid>",...}`. Report it so the user can pick the work up in the pi TUI with `pi --session <id>`.

### JSON event stream

`--mode json` emits one JSON object per line:

- `session` — header with the session id and cwd.
- `turn_start` / `turn_end` — turn boundaries.
- `tool_execution_start` / `tool_execution_end` — tool name, args, `isError`.
- `message_update` — streaming deltas only (no cumulative snapshot).
- `message_end` — the authoritative message; assistant messages carry `usage` with token counts and `usage.cost.total` in dollars.
- `agent_end`, `agent_settled` — completion.

Read the final answer from the last assistant `message_end`, not from the deltas.

## Failure modes worth knowing

- An unknown model prints `Error: Model "x" not found` and the run produces no assistant output; check `pi --list-models`.
- Non-interactive modes never prompt for project trust. Without a saved decision they fall back to `defaultProjectTrust` in `~/.pi/agent/settings.json`, so project-local `.pi` resources may be ignored. Pass `--approve` to trust the project for one run.
- A run that produces no assistant text is a failure even when the exit code is 0; the companion script reports that explicitly.
