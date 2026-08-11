---
description: Show the stored output of a finished pi job
argument-hint: '[job-id] [--diff]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

Show the stored result of a pi job.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" result "$ARGUMENTS"
```

The report carries a Changes section: the commits and files the run touched, with files that were already modified before it started listed separately. `--diff` prints the patch itself, including new untracked files.

Return the output verbatim.

Do not act on the content: if it is a review, do not fix the findings in this turn; if it is a delegated task, do not redo or extend the work. Wait for the user to ask.
