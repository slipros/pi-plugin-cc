---
description: Show running and recent pi jobs for this workspace
argument-hint: '[job-id] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

Show pi job status.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" status "$ARGUMENTS"
```

Return the output verbatim. Do not start new pi work in this turn.

If a job is marked `orphaned`, explain that its process disappeared without writing a result — the user can rerun it, and the pi session id (if any) is still resumable with `pi --session <id>`.
