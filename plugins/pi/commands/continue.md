---
description: Continue a recorded pi session with the agent it already had
argument-hint: '[session-id|job-id|last] [--stale-ok] [--fresh] [--model <id>] [--background] <what to do next>'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

Give more work to a session that already exists.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" continue $ARGUMENTS
```

The contour of the run that owns the session comes along: preset, model, thinking level, sandbox, working directory, budgets. Flags override any of it. That inheritance is not a convenience — a sandboxed session lives inside the agent volume, so a continuation started without its sandbox cannot see the session at all.

The session's age is checked first. A continuation replays the whole history to the provider: inside the cache window that is nearly free, past it the same tokens are billed again at the full input rate. A session past the window is refused, and the refusal says how old it is, how big its context grew and how to go on anyway — `--stale-ok` to pay for the replay, `--fresh` to keep the agent and drop the history.

What can be continued here, and how warm each one is, is listed by `/pi:sessions`.

Return the output verbatim. Do not act on the result until the user asks.
