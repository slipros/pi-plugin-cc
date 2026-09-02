# Metrics: the journal, what the numbers mean, repeating a run

Job files answer "what is running now"; they cannot answer "what did this week cost" — they live
in a temp tree, are split per workspace, keep the newest 50 each and vanish on reboot. So
starting and finished runs are also appended to a durable SQLite journal at
`~/.local/share/pi-plugin/jobs.db` (override with `PI_PLUGIN_DB`).

It uses `node:sqlite`, which ships with Node 22.3+ and needs no dependency; on older Node the journal is simply skipped and everything else works unchanged.

```bash
pia stats                       # last 30 days, by day
pia stats --by model            # how each model behaved
pia stats --by preset --days 7
pia stats --by workspace --all
pia stats --by status           # how runs ended
pia stats --by kind             # delegate versus review
pia models --stats <search>     # the catalogue plus these numbers
```

## What the columns mean

The report is not only tokens: `ok` is the share of runs that finished, `ctx avg`/`ctx max` how much of the context window a run held at its peak, `tok/s` the model's speed, `p50`/`p90` run durations, `tools`/`err` tool calls and the errors among them.

**`ctx` answers "does this fit in the window", which the `in` column cannot.** Every turn resends the conversation, so the input total runs far ahead of what the model ever held at once — a four-turn run totalling 30K of input peaked at 10K of context. It is measured as the largest `input + cache + output` of a single exchange.

**`tok/s` is measured on the generation window itself** — first content frame to last chunk, summed over a run's requests and taken from the credential proxy. It replaced a rate measured against model time (the run minus its tools), whose denominator carried prefill, the provider's queue and the network: on one measured run that read 122 tok/s against a real 259.

Two exclusions, both deliberate. A run **without proxy telemetry** — recorded before this existed, or run without a sandbox — shows a dash instead of being folded in on the old measurement: two definitions of speed in one column is worse than a gap. And an **answer under 1,000 output tokens** does not count at all, because the tokens delivered in the first frame were generated before the window opened, and the shorter the answer the more that inflates the number. The `out/run` column next to the rate is the average answer length behind it — two buckets whose lengths differ several times over are not comparable, whatever the denominator says.

Cost is only shown when the provider reports it — `ollama-pro` and `opencode-go` send zero, so there the honest answer is tokens, not money.

**Two claims that used to stand here and turned out wrong when measured.** Tokens do *not* arrive in a few large batches: checked from both ends of the channel, the median gap between deltas is 11 ms. And *89% of a run does not go to gopls*: across 68 transcripts tools took 35% of the time, of which gopls was 3.5% and bash 96% — nearly half of that one `go build ./...`. Before switching to a faster model, look at the task brief, not at the language server.

## Repeating a run, and comparing two

The journal also keeps the task, the answer and the settings a run used, which is what makes a run repeatable:

```bash
pia runs                        # this workspace, newest first
pia runs --all --days 7         # every workspace
pia runs <id>                   # what it was asked, what it answered
pia rerun <id>                  # again, same settings
pia rerun <id> --model other/m  # same task, different model
pia rerun <id> --append "and leave the migrations alone"
pia rerun <id> --prompt "the task, rewritten"
pia runs <id> --json | jq -r .prompt > task.md   # edit it yourself…
pia rerun <id> --stdin < task.md                 # …and send it back
```

`rerun` keeps what you chose — preset, model, thinking level, sandbox, ceilings — and resolves everything else fresh from the config as it is now, so it repeats the run rather than a stale copy of your setup. Flags override the recipe, which is the point: the same task on two models is the only honest way to compare them on work you actually do.

The task is editable as well, since "that, but with one thing changed" is the common case: `--append` adds an instruction, `--prompt`/`--stdin` replaces the text and keeps everything else. A replacement also revives a run whose stored text has aged out: the settings outlive the prompt.

**This is repository content on disk, so it is bounded.** Text is redacted for the shapes secrets announce themselves in (provider keys, bearer tokens, JWTs, `password=` assignments, credentials in URLs), capped at 32 KB a field, and expires after 90 days — `runs --prune [--days N]` sweeps on demand, and a sweep happens by itself at most once a day. Only the text expires: counters, timings and costs are kept forever, so statistics still cover the whole history. A random password with no recognisable shape is not caught by the redaction; the journal file and its directory are 0600/0700 rather than the world-readable default.

## What the run did with the code

The journal also records what the agent actually touched, so "it read a lot and changed nothing"
is a number rather than an impression: lines read, written and replaced; files read and written;
re-reads of the same file; shell calls; tool calls; per-tool errors (`edit`, `read`, `shell`);
and how long it took until the first edit. `runs <id>` prints the roll-up next to the tokens.

A run resumed after a truncation sums the two halves rather than de-duplicating them — the halves
are separate processes and neither kept the other's path set, so a file touched in both is counted
twice. The overstatement is bounded by how rarely a run has to be resumed at all.

## What the proxy measures

Every model request of a sandboxed run passes through the credential proxy, which is the only place on the host that sees the exchange whole. pi retries HTTP failures internally and carries six usage keys forward, so a run that hit three 429s and one dropped stream simply looked slow.

Each request is recorded as one row: status, `error_kind` (`transport`, `timeout`, `aborted`, `truncated` — here a broken stream, not the output ceiling: that shows in `finish_reason` and in the job phase), time to first byte, time to first **content** frame, the generation window, the longest silence inside it, sizes, rate-limit headers, and the provider's own usage — with the raw blob kept only when it holds a key nobody has mapped. `runs <id>` prints the roll-up: how many requests, how many failed, median time to first token, the generation rate, and the time the run spent queued for a sandbox slot.

What is never recorded: messages, system prompts, tool definitions, response text, or request headers. The body is parsed a few lines away to rewrite the model name, so this is a discipline rather than a limitation — the same line `redactArgs` draws for command lines. Rows expire with the same 90-day retention.

Design notes and the measurements behind all of this: [DESIGN-proxy-telemetry.md](DESIGN-proxy-telemetry.md), [RESEARCH-provider-tps.md](RESEARCH-provider-tps.md) (both in Russian).
