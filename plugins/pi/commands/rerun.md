---
description: Run a recorded pi task again, on the same settings or another model
argument-hint: '<run-id> [--model <id>] [--preset <name>] [--background]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

Repeat a recorded run.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" rerun $ARGUMENTS
```

The recorded preset, model, thinking level, sandbox and budgets are the floor; flags override them, which is the point — the same task on two models is the honest way to compare them. Everything else resolves fresh from the current config.

Return the output verbatim. Do not act on the result until the user asks.
