---
description: Send an instruction to a running pi job while it works
argument-hint: '[job-id] [--follow-up] <message>'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

Steer a running pi job.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" steer "$ARGUMENTS"
```

Return the output verbatim.

Notes to relay when relevant:

- A steering message reaches pi after its current assistant turn finishes its tool calls, before the next model call — it redirects work in progress rather than interrupting it mid-tool.
- `--follow-up` queues the message for after the agent finishes instead.
- If the job already finished, the message is sent as a new prompt in the same pi session.
- Jobs started with `--engine json` have no control channel; they must be re-run on the default `rpc` engine to be steerable.

Do not start new pi work in this turn, and do not act on the job's output yourself.
