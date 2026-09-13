# Development: pitfalls that already cost us

Things that are easy to get wrong when changing the companion, the RPC engine or the test suite.
Each one has shipped at least once with green tests.

## Call the entry point for real at least once

A change without a test on the entry point must be run once end to end, with a fake pi binary
behind `PI_PLUGIN_BINARY` (that is how `tests/recovery.test.mjs` and `tests/loop-nudge.test.mjs`
work). One stray closing brace once turned the whole json engine (`runPiTurn`) into dead code: it
returned `undefined` in a millisecond without spawning anything, `node --check` was silent, and
every test stayed green because none of them reached the entry point.

## A test double must refuse what pi refuses

The fake pi has to behave like the real one: emit turns asynchronously, keep a streaming flag and
reject a bare `prompt` sent to a busy agent (`Agent is already processing. Specify
streamingBehavior ('steer' or 'followUp') to queue the message.`). A synchronous double accepted
anything, and the loop-nudge delivery shipped with seven green tests while it had never reached a
model once.

## Async bodies need an async helper

A synchronous helper such as `withWorkspace(run)` with an `async` body restores the environment and
removes the fixture at the body's first `await`. From then on the test writes into the real
`~/.local/share/pi-plugin/state` through the `CLAUDE_PLUGIN_DATA` fallback — this once left 220
fake buckets that `status --global` listed as real jobs, and made three tests pass for the wrong
reason. Use `withWorkspaceAsync` with `await run(...)` (`tests/wait.test.mjs`,
`tests/events.test.mjs`).

CLI tests that spawn the companion must clear `PI_COMPANION_SESSION_ID` and
`CLAUDE_CODE_SESSION_ID` (`sessionEnv` in `tests/events.test.mjs`); otherwise the id of the Claude
Code instance running the suite leaks into the runs as their owner.

## SQLite: MAX(NULL, x) is NULL

`recordJob` writes a job twice — at start, when nothing is measured yet, and at the end. Counters
that must not go backwards are updated with `MAX(column, excluded.column)`, which is only safe for
columns with `DEFAULT 0`. For a nullable column `MAX(NULL, 5)` is `NULL`, so the start-of-run write
wiped everything measured by the end. Nullable columns go through
`COALESCE(excluded.column, column)` (`lib/db.mjs`). The metric columns are nullable on purpose: a
zero added by `ALTER TABLE` must stay distinguishable from a measured zero.

## pi RPC: steering a busy agent

- `prompt` with `streamingBehavior: "steer"` covers both agent states: the field is only read
  while the agent is streaming. Separate `steer` / `follow_up` commands always enqueue — sent to a
  settled agent, the message sits in the queue and is lost.
- pi drops an answer cut at the output ceiling from the session history entirely, together with
  the steer queue of that turn. A message meant for a truncated turn is sent after
  `agent_settled`, as a plain prompt, instead of the continuation — "continue from where you were
  cut" and "stop and decide" on the same truncation contradict each other.
- The rejection carries the id of the command it refuses (optional field): match it before
  touching a watchdog, or a refused nudge will mark the agent settled while a continuation is still
  in flight.

## Running processes keep old code

A long-running Node process (`pia events --follow` under a Monitor) keeps the modules it loaded at
start. After changing the companion, restart it — otherwise the old behaviour silently continues.

## What the credential proxy mask loses

Behind the proxy mask pi no longer sees the real provider, so everything it infers from the provider
name and base URL is gone. The plugin restores `maxTokensField` (the provider list is copied from
pi's module-private `detectCompat`, plus `ollama.com` by measurement) and `prompt_cache_key` for
api.openai.com. The rest of the inferred compat — `thinkingFormat`, `supportsStore`,
`requiresReasoningContentOnAssistantMessages` — survives only as an explicit `compat` on the
provider in `~/.pi/agent/models.json`.
