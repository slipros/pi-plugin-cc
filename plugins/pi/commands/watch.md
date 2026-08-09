---
description: Show what a pi agent is doing — its turns, tool calls and answers
argument-hint: '[job-id] [--since <cursor>] [--follow [--for <seconds>]] [--tail <n>]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

Show the transcript of a pi job.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" watch "$ARGUMENTS"
```

Return the output verbatim.

Execution notes:

- Without `--follow` the command prints a snapshot and exits — that is the right choice inside a Claude Code turn.
- Every snapshot ends with a cursor. When checking on the same job again later in the conversation, pass `--since <cursor>` from the previous output so the user sees only what is new instead of the whole transcript again.
- `--follow` streams until the job ends and will not return while the agent is still working. Inside a turn, always bound it with `--for <seconds>` (10–60 is usually enough to see whether the agent is on track); it returns at the deadline with a fresh cursor. Unbounded `--follow` belongs in `Bash(run_in_background: true)` or in the user's own terminal via `!`.
- `--tail <n>` limits the snapshot to the last n lines, which is usually enough to answer "what is it doing right now".

If the job is still running, remind the user they can redirect it with `/pi:steer <message>`.
