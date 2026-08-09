---
description: Hand a task to a pi agent, with a chosen model and system prompt
argument-hint: '[--background|--wait] [--preset <name>] [--model <id>] [--system-prompt <name|@file|text>] [--thinking <level>] [--read-only] [--sandbox docker] [--cwd <path>] [--mount <h:c:ro>] [--git-name <n> --git-email <e>] [--session last] <task>'
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
- Isolation: `--sandbox docker` runs the whole pi process in a container with only the workspace mounted. Pass it when the user asks for it, and suggest it for work on an untrusted repository or a long unattended run. It needs the image from `/pi:sandbox build`; the script fails with that instruction if it is missing.
- Other directory: `--cwd <path>` runs the agent in another repository while the job stays recorded here, so `/pi:status` and `/pi:watch` keep working from where you are. Pass it when the user names a directory the work belongs to; never `cd` there instead.
- Extra directories: `--mount host:container[:ro]` adds one to whatever sandbox the run has — a sibling repository, fixtures, a data set. Repeatable. Pass it when the user names a directory the task needs; a task that only touches the current repository does not need it, the workspace is mounted already.
- Commit identity: `--git-name` and `--git-email` (both, or neither) make the agent commit as itself instead of as the user. Pass them when the user wants agent commits distinguishable in history.
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
- Tell the user the job started and that `/pi:status` shows progress, `/pi:watch` shows the transcript and `/pi:result` shows the answer.
- When checking on it in a later turn, use `watch <job-id> --tail 20` and then `watch <job-id> --since <cursor>` with the cursor from the previous output, so only new events come back. `watch --follow --for <seconds>` is the bounded way to look for a while; unbounded `--follow` never returns while the agent works.

If the pi agent was allowed to write, remind the user at the end to review the resulting diff with `git diff` before committing.
