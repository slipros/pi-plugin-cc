---
description: pi sessions of this workspace and the state of the cache behind each
argument-hint: '[session-id] [--all] [--global] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

List what can be continued.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" sessions $ARGUMENTS
```

Each row is one pi session: how long since the provider last saw it, whether that is still inside the cache window (`warm`) or past it (`cold`), the contour a continuation would inherit, and how large the context grew — the size that would be re-billed on a cold continuation.

Sessions are bucketed by the directory a run was started from, so a session started elsewhere is not missing, only in another bucket: `--global` looks across all of them.

Return the output verbatim. Do not act on the result until the user asks.
