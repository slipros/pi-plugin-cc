---
description: The journal of pi runs — what was asked, what it cost, and how to repeat it
argument-hint: '[run-id] [--all] [--limit N] [--days N] [--model <id>] [--preset <name>] [--prune]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

List recorded pi runs, or show one in full.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" runs $ARGUMENTS
```

Unlike `/pi:status`, this reads the durable journal, so it remembers runs from last week and from repositories that no longer exist. A run id shows the task it was given, the answer it produced, and the settings it ran under. `--prune` clears stored text older than the retention window (90 days) while keeping every counter.

Return the output verbatim.
