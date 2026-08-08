---
description: Show what a pi agent is doing — its turns, tool calls and answers
argument-hint: '[job-id] [--follow] [--tail <n>]'
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
- `--follow` streams until the job ends and will not return while the agent is still working. Only run it with `Bash(run_in_background: true)`, or tell the user to run it themselves in a terminal with `!`.
- `--tail <n>` limits the snapshot to the last n lines, which is usually enough to answer "what is it doing right now".

If the job is still running, remind the user they can redirect it with `/pi:steer <message>`.
