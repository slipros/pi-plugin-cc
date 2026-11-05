# Setting up metrics from scratch

Three distinct sources produce metrics for this setup, and each connects in its own way:

| Source | What it measures | How it is connected |
| --- | --- | --- |
| Claude Code itself | tokens and cost of the calling tool | `CLAUDE_CODE_ENABLE_TELEMETRY=1`, standard `OTEL_*` |
| pi directly (non-delegated runs) | tokens and cost of runs you start yourself in the pi TUI | the pi telemetry extension `@desek/pi-opentelemetry`, standard `OTEL_*` |
| delegated pi agents (sandboxed) | tokens and cost of every run the companion starts | the companion on the host, `PI_OTEL_*` — see below |

The third source deserves its own variables. The companion process is spawned by Claude Code,
which **strips every `OTEL_*` variable from child-process environments** (`PI_*` passes through),
so a shell-only standard setup never reaches the exporter at all. Configure it with:

- `PI_OTEL_ENABLE=1`
- `PI_OTEL_EXPORTER_OTLP_ENDPOINT` — full collector URL for OTLP/HTTP JSON (e.g. `http://<collector>:4318/v1/metrics`), used as-is;
- `PI_OTEL_EXPORTER_OTLP_HEADERS` — `k=v,k=v` request headers, typically the collector's Bearer.

If the `PI_OTEL_` variables are absent, the exporter falls back to the standard `OTEL_*` ones
(unchanged behaviour from before they existed) — it just never sees them under Claude Code.

**Do not set `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` or `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` globally**
to work around this. Every OTel client on the machine reads those, and both readings are wrong:

- Claude Code, when `OTEL_EXPORTER_OTLP_PROTOCOL=grpc`, pushes its metrics gRPC-style at the
  HTTP port the per-signal endpoint names — and loses them;
- `@desek/pi-opentelemetry` always appends `/v1/metrics` to the endpoint address, so it POSTs to
  `.../v1/metrics/v1/metrics`, which no collector accepts.

The per-signal variables are standard and shared; the companion's variables are its own and private.

## Ready-made shell block

Add to `~/.profile` or `~/.zshrc` (fill in the placeholders — collector address and token):

```sh
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export PI_OTEL_ENABLE=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector>:4317
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <token>"
# companion (sandboxed pi agents): OTLP/HTTP JSON, own variables — Claude Code strips OTEL_* from child processes
export PI_OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector>:4318/v1/metrics
export PI_OTEL_EXPORTER_OTLP_HEADERS="$OTEL_EXPORTER_OTLP_HEADERS"
```

Restart the sessions afterwards — both the running Claude Code instances and the pi TUIs read the
environment once at start, so a changed profile reaches nothing already running.

## Checking that it works

- `pia setup` prints `Telemetry: enabled (source: pi) → …` — the `pi` source means the companion
  sees its own variables, not the fallback. `off` with a hint about `PI_OTEL_EXPORTER_OTLP_ENDPOINT`
  means `PI_OTEL_ENABLE` is set but the endpoint did not arrive.
- In the collector, the companion's series carry the resource label `pi.runner="companion"`; the
  extension's series on the same host do not — that is how the two sources stay distinguishable.
- The companion exports **after** a run reaches a terminal state (completed, failed or cancelled),
  not during it, and the values are **cumulative per model** across the whole journal — a dashboard
  shows totals, `rate()` shows the pace, and a missed send heals on the next export.

See [metrics.md](metrics.md) for what the series contain and [config.md](config.md) for every variable.
