---
description: Run a recorded pi task again, on the same settings or another model
argument-hint: '<run-id> [--append <text>] [--prompt <text>|--stdin] [--model <id>] [--preset <name>] [--background]'
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

The task itself can change too, which is the common case: `--append "<text>"` adds an instruction to the recorded task (repeatable), while `--prompt "<text>"` or `--stdin` replaces it and keeps the settings. A replacement also revives a run whose stored text has passed the retention window — its settings outlive its prompt.

Return the output verbatim. Do not act on the result until the user asks.
