---
description: Check that pi is installed, authenticated and configured for this workspace
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(npm:*), Read, AskUserQuestion
---

Check the pi integration for this workspace.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" setup
```

Return the command output verbatim.

Then, based on that output:

- If the pi binary is missing, offer to install it with `npm install -g @earendil-works/pi-coding-agent`. Ask with `AskUserQuestion` before running any install command.
- If pi is installed but no models are available, tell the user to run `pi` and sign in with `/login` inside the pi TUI, or to configure `~/.pi/agent/models.json`. Do not attempt to log in for them.
- If there are config errors, point at the offending file and explain what is malformed.
- Otherwise confirm that the plugin is ready and mention `/pi:models`, `/pi:delegate` and `/pi:review`.

Do not run any other pi command in this turn.
