---
description: Build and inspect the container image that sandboxed pi runs use
argument-hint: '[status|build|clean] [--image <tag>] [--pi-version <v>] [--no-cache]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

Manage the pi sandbox image.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" sandbox "$ARGUMENTS"
```

Return the output verbatim.

Notes to relay when relevant:

- `status` (the default) shows whether docker is reachable, whether the image is built, and which sandbox containers are still around.
- `build` builds the image from the Dockerfile shipped with the plugin, pinned to the pi version installed on this machine. It takes a minute or two on a cold cache and streams docker's own output.
- `clean` removes leftover sandbox containers — only needed if a run was killed in a way that skipped the normal cleanup.
- Once the image exists, `--sandbox docker` on `/pi:delegate` or `/pi:review` runs that job inside it.
- If docker is not installed or the daemon is unreachable, say so plainly and stop: there is nothing to fall back to except running without the sandbox.
