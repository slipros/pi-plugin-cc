---
description: List the models pi can use, plus configured presets and system prompts
argument-hint: '[search]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

Show the pi model catalogue, presets and stored system prompts for this workspace.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" models "$ARGUMENTS"
```

Return the output verbatim.

If the user asked which model to use for a specific task rather than for a plain listing, add one short recommendation after the table, based on the context window, thinking support and the task at hand. Keep it to two sentences.
