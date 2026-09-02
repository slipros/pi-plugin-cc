# Jobs: background runs, watching, steering, results

A delegated run is not a black box and does not have to hold a terminal open. This file covers
the lifecycle: start it detached, watch it, redirect it, collect what it did.

## Background runs

```bash
/pi:review --background
/pi:status
/pi:result
/pi:cancel
```

`--background` **detaches the run**: the command validates the preset and the sandbox, hands the work to a separate process, prints the job id and exits in about a second. The agent then outlives the shell that started it, so nothing has to hold a terminal (or a Claude Code turn) open for an hour, and nothing is killed by a stray `timeout` or a cancelled turn. Startup problems still surface in front of you — detaching happens after validation — and whatever the detached process says before it becomes a tracked job goes to the `Startup log` named in the output.

Token usage is recorded as the run goes, not only at the end: `/pi:status` shows `Usage: in … · out … · $…` for a job that is still working, updated on every model answer (one write per assistant turn, not per tool call).

## Waiting, and being told

```bash
/pi:wait                       # the newest live job
/pi:wait <job> <job>           # these ones
/pi:wait --all --for 600       # everything running, up to ten minutes
```

`wait` exits non-zero if the deadline passed or a job did not finish cleanly, so a script can branch on it. A job id printed by `delegate --background` can reach `wait` before the detached child has written its record; the wait is on the named jobs appearing, not on the bucket being empty.

For a notification instead of a wait, give the run a hook:

```json
"defaults": { "onFinish": "notify-send \"pi $PI_JOB_STATUS\" \"$PI_JOB_TITLE\"" }
```

```bash
/pi:delegate --notify 'echo "$PI_JOB_ID $PI_JOB_STATUS" >> ~/pi-runs.log'   fix the flaky test
```

The command runs on the host when the job reaches a terminal state — including a failed one, since "it finished" is the moment worth announcing — with `PI_JOB_ID`, `PI_JOB_KIND`, `PI_JOB_STATUS`, `PI_JOB_TITLE`, `PI_JOB_WORKSPACE`, `PI_JOB_RUN_ROOT`, `PI_JOB_MODEL`, `PI_JOB_SUMMARY`, `PI_JOB_ELAPSED` and `PI_JOB_LOG` in its environment. It gets ten seconds and is then killed; a hook that fails is a line in the job log and nothing more. It may only come from your own config or the flag — a project config naming `onFinish` has it stripped, because a sandboxed agent can write that file through the mounted workspace.

`events` is the machine-readable version of the same announcement: one line per finished run across every workspace, for a supervisor that watches a fleet rather than a job (`events --follow`, `events --tail 20`).

## Watching and steering

```bash
/pi:watch                          # what is the agent doing right now
/pi:watch --tail 20                # just the tail
/pi:watch <job> --since 149        # only what happened since the last check
/pi:watch <job> --follow --for 30  # stream for 30 seconds, then return
/pi:steer  hold on — stop reading files and start editing
/pi:steer  --follow-up  when you are done, add tests
```

Every snapshot ends with a cursor, and `--since <cursor>` picks up from there. That is what makes a background job followable from inside a Claude Code turn: check in, get only the new events, steer if needed, check in again. `--follow` on its own never returns while the agent works, so pair it with `--for <seconds>` unless you are running it yourself in a terminal.

A steering message is delivered after the agent's current turn finishes its tool calls and **before the next model call**, so it redirects work in progress instead of interrupting a tool mid-run. `--follow-up` waits until the agent is otherwise done. If the job already settled, the message is sent as a new prompt in the same pi session.

This works because jobs run against a live `pi --mode rpc` session (`--engine json` switches back to a one-shot run, which is faster to start but cannot be steered). `/pi:cancel` uses the same channel: it asks pi to `abort` first — keeping the session and any partial output — and only escalates to signals if that does not land.

## A fleet, not one job at a time

```bash
/pi:status --global            # every workspace on this machine
/pi:status --running           # only what is still going
/pi:status --model glm --preset go-developer
/pi:cancel --all               # every live job here
/pi:cancel --all --global      # everywhere
```

`cancel` also acts on `pending` and `orphaned` jobs, not only `running` ones: both can still hold a container, and with it a slot of a concurrency pool.

**Job records live in the bucket of the directory a run was started from**, which used to make the same id resolve from one shell and not from another — a `cd` between two calls turned "no such job" into the answer about a job that plainly exists. `result` and `status <id>` now fall back to the global list when the local bucket misses, read the record from its own bucket, and print which workspace it came from:

```
note: job record lives in /home/me/proj/other, not in this workspace — found it via the global list.
```

## What the run changed

The report says what the agent *answered*; this says what it *did*. A snapshot of the tree is taken before pi starts, so the two can be told apart:

```bash
/pi:result                     # the answer, with a Changes section
/pi:result <job> --diff        # the patch itself
/pi:review --job <job>         # review exactly what that run changed
```

The Changes section lists the commits and the files, and — separately — the files that were **already** modified when the run started, so nobody reads their own work-in-progress as the agent's. `--diff` is read from the tree on demand rather than stored, and includes new untracked files, which `git diff` never shows.

One thing it cannot know: edits you make in the same tree while the run is going are counted as the agent's. In a worktree or with `--cwd` that does not happen; in a shared checkout it can.

## Continuing a session

Each record keeps the pi session id, so an unsandboxed job can be picked up in pi itself — a sandboxed one keeps its session in the agent volume, where the host cannot see it:

```bash
pi --session <session-id>
/pi:continue last "<what next>"   # from Claude Code, with the run's preset, model and sandbox
/pi:sessions                      # what can be continued, and how warm its cache still is
```

Continuing replays the whole history to the provider, which is nearly free while the provider still caches it and full price once it does not — so a session older than the configured cache TTL (`cacheTtl`, 40 minutes by default) is refused rather than silently re-billed. `--stale-ok` pays for the replay on purpose; `--fresh` keeps the agent and drops the history. See [config.md](config.md).

## Where state lives

Job state lives outside your repository, bucketed per workspace, and survives Claude Code restarts: `~/.local/share/pi-plugin/state/<bucket>/jobs/<id>.{json,log,events.jsonl,inbox.jsonl}`, newest 50 per bucket. It answers "what is running now". What a week cost is a different question, answered by the durable journal — see [metrics.md](metrics.md).

The inbox is a plain append-only JSONL file rather than a socket: it survives restarts, behaves identically on every platform, and you can read it with `cat` when something looks wrong.
