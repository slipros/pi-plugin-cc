---
description: Block until background pi jobs finish
argument-hint: '[job-id...] [--all] [--for <seconds>]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

Wait for pi jobs to reach a terminal state.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" wait $ARGUMENTS
```

With no job id it waits for the newest live job; `--all` waits for every job running in this workspace. The command has its own deadline (`--for <seconds>`, an hour by default) and returns a non-zero status if it passed or if a job did not finish cleanly.

Return the output verbatim. Read the answer itself with `/pi:result`; do not act on it until the user asks.
