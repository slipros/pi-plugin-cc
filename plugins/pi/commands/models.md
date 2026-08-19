---
description: List the models pi can use, with context window, output ceiling and thinking support
argument-hint: '[search] [--stats [--days N]]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

Show the pi model catalogue for this workspace.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" models "$ARGUMENTS"
```

The table lists what pi can reach: model id, context window, output ceiling, thinking and image support. `--stats` adds how those models actually behaved on this machine — runs, success share, generation rate, answer length, durations, cost — read from the journal rather than from the catalogue.

Presets and stored system prompts are **not** in this report: `/pi:presets` has them. The two answer different questions — "what can answer me" against "who should do the work" — and keeping both here made the slower report the only way to get the faster answer.

Return the output verbatim.

If the user asked which model to use for a specific task rather than for a plain listing, add one short recommendation after the table, based on the context window, thinking support and the task at hand. Keep it to two sentences.
