---
description: Hand a task to a pi agent, with a chosen model and system prompt
argument-hint: '[--background|--wait] [--preset <name>] [--model <id>] [--system-prompt <name|@file|text>] [--thinking <level>] [--read-only] [--session last] <task>'
disable-model-invocation: false
allowed-tools: Bash(node:*), Bash(git:*), Read, Glob, Grep, AskUserQuestion
---

Delegate a task to pi through the companion script.

Raw slash-command arguments:
`$ARGUMENTS`

Argument handling:

- Preserve the user's arguments exactly. Do not rewrite the task text, do not strip flags, do not add flags the user did not ask for.
- The task text is everything that is not a flag. If it is empty, ask the user what to delegate instead of inventing a task.
- Profile: `--preset <name>` applies a full agent profile (model, thinking, system prompt, tools, extensions) from the config; individual flags `--model`, `--provider`, `--thinking` override single fields. If the user names a model that is not in the catalogue, the script warns and still passes it to pi — relay that warning.
- System prompt: `--system-prompt <value>` takes a stored prompt name (`fixer`, `reviewer`, `adversarial`, `explorer`, or a project file in `.claude/pi/prompts/`), an `@path/to/file.md`, or inline text. `--append-system-prompt <text|@file>` adds to it. Without it, pi keeps its own coding-assistant prompt unless the config says otherwise.
- By default the pi agent can edit files and run commands. Pass `--read-only` when the user only wants investigation.
- `--session last` continues the most recent pi session in this workspace; `--fresh` forces a new one.

Execution mode rules:

- If the arguments contain `--wait`, run in the foreground. If they contain `--background`, run as a Claude background task. Never ask in those cases.
- Otherwise decide: a task that clearly needs multiple files changed, a test run, or deep investigation belongs in the background; a narrow question can run in the foreground. Ask once with `AskUserQuestion`, offering `Run in background` and `Wait for results`, with the recommended option first and `(Recommended)` in its label.

Foreground flow:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" delegate "$ARGUMENTS"
```

Return the command stdout verbatim. Do not summarize it, do not re-do the work yourself, and do not act on pi's suggestions unless the user asks.

Background flow:

- Launch it with `Bash` and `run_in_background: true`:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" delegate --background "$ARGUMENTS"`,
  description: "pi delegated task",
  run_in_background: true
})
```

- Do not poll `BashOutput` in this turn.
- Tell the user the job started and that `/pi:status` shows progress, `/pi:result` shows the answer.

If the pi agent was allowed to write, remind the user at the end to review the resulting diff with `git diff` before committing.
