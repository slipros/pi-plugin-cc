---
description: Cancel a running pi job, or all of them
argument-hint: '[job-id] [--all [--global]]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

Cancel a running pi job.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" cancel "$ARGUMENTS"
```

Return the output verbatim.

If the script reports that several jobs are running, show their ids and ask the user which one to cancel. Do not guess — unless the user asked to stop everything, which is `--all` (this workspace) or `--all --global` (every workspace on the machine).

`pending` and `orphaned` jobs are cancelable too: both can still hold a container, and with it a slot of a concurrency pool.

A cancelled job that had already edited files leaves those edits in place — remind the user to check `git status` when the cancelled job was a write-enabled delegation.
