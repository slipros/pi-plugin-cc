---
description: List the configured pi agents — what each preset is for — and the stored system prompts
argument-hint: '[--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

Show the pi presets and system prompts available in this workspace.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" presets "$ARGUMENTS"
```

Each line is one agent: its `description`, then the profile behind it — model, provider, thinking level, system prompt, read-only, sandbox profile. A preset with no `description` shows only the profile; a config with no presets at all says so and names the file to add them to.

This command deliberately does **not** touch the model catalogue, which is what makes it fast enough to ask on every delegation. For the catalogue itself — context windows, output ceilings, measured behaviour — use `/pi:models`.

Return the output verbatim.

If the user was choosing an agent for a specific task rather than asking for a listing, name the preset that fits and say why in one sentence. Do not start a run in this turn unless they asked for one.
