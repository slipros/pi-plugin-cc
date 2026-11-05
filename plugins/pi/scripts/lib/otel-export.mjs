import { openDatabase } from "./db.mjs";

/**
 * Host-side OTLP/HTTP JSON export of delegated-run metrics.
 *
 * The sandbox cannot carry telemetry: its env allowlist keeps `OTEL_*` out, the
 * telemetry extension is not installed in the image, and the model name is
 * masked inside the container on purpose. The journal on the host holds the
 * real model, provider, usage and cost of every run, so the companion exports
 * cumulative counters from there — the Bearer token never approaches the
 * agent. Transport is hand-rolled on node: built-ins because this package has
 * no dependencies and must not gain any.
 *
 * Configuration lives in PI_OTEL_EXPORTER_OTLP_* variables, not the standard
 * OTEL_* ones: the companion is spawned by Claude Code, which strips every
 * OTEL_* variable from child-process environments (PI_* passes through), so a
 * standard-only setup never reaches this exporter at all. The standard OTEL_*
 * variables remain supported as a fallback so a pre-existing shell setup keeps
 * working. The standard per-signal variables must NOT be set globally for the
 * companion's benefit: every OTel client reads them, so Claude Code would push
 * gRPC metrics at an HTTP port, and @desek/pi-opentelemetry always appends
 * /v1/metrics to the address and would POST to .../v1/metrics/v1/metrics.
 */

const START_TIME_KEY = "otel_start_time";
const EXPORT_TIMEOUT_MS = 2_000;
const DEFAULT_SERVICE_NAME = "pi-coding-agent";
// Matches the extension's metric names and units exactly, or the collector
// would shard the series by schema instead of appending to it.
const TOKEN_METRIC = "pi.token.usage";
const COST_METRIC = "pi.cost.usage";

function truthy(value) {
  return ["1", "true"].includes(String(value ?? "").toLowerCase());
}

/** `k=v,k=v` — the OTel convention for headers and resource attributes. Values may contain `=`. */
export function parseKeyValueList(raw) {
  const result = {};
  for (const pair of String(raw ?? "").split(",")) {
    const item = pair.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    result[item.slice(0, eq).trim()] = item.slice(eq + 1);
  }
  return result;
}

/** jobs.model is stored as `<provider>/<model>`; the extension labels only the part after the slash. */
export function splitModelId(modelId) {
  const value = String(modelId ?? "");
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    return { model: value, provider: "" };
  }
  return { model: value.slice(slash + 1), provider: value.slice(0, slash) };
}

function httpFamily(protocol) {
  const value = String(protocol ?? "").toLowerCase();
  return value === "" || value.startsWith("http");
}

/**
 * R1: PI_OTEL_EXPORTER_OTLP_* first (Claude Code strips plain OTEL_* from its
 * child processes), standard OTEL_* as fallback. No-op unless PI_OTEL_ENABLE is
 * truthy. Returns null when the exporter must stay silent; there is no probe
 * and no retry — a cumulative series catches up on the next export anyway.
 */
export function resolveOtelConfig(env = process.env) {
  if (!truthy(env.PI_OTEL_ENABLE)) {
    return null;
  }
  const protocol = env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "";
  const metricsEndpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  let endpoint = null;
  let source = "otel";
  if (env.PI_OTEL_EXPORTER_OTLP_ENDPOINT) {
    // A PI_ endpoint is a full URL, used as-is whatever the protocol says.
    endpoint = env.PI_OTEL_EXPORTER_OTLP_ENDPOINT;
    source = "pi";
  } else if (metricsEndpoint) {
    // A per-signal endpoint is a full URL, used as-is whatever the protocol says.
    endpoint = metricsEndpoint;
  } else if (env.OTEL_EXPORTER_OTLP_ENDPOINT && httpFamily(protocol)) {
    endpoint = String(env.OTEL_EXPORTER_OTLP_ENDPOINT).replace(/\/+$/, "") + "/v1/metrics";
  }
  if (!endpoint) {
    return null;
  }
  // Headers follow the endpoint's source: an endpoint that needs auth paired
  // with silently empty headers would fail the export with no visible reason,
  // so when the PI_ headers are absent the standard ones are still honored.
  const headersRaw =
    source === "pi"
      ? env.PI_OTEL_EXPORTER_OTLP_HEADERS ?? env.OTEL_EXPORTER_OTLP_METRICS_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS
      : env.OTEL_EXPORTER_OTLP_METRICS_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS;
  const resource = {
    ...parseKeyValueList(env.OTEL_RESOURCE_ATTRIBUTES),
    "service.name": env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME,
    // Distinguishes companion-exported series from the ones the extension
    // emits for direct (non-delegated) runs on the same host.
    "pi.runner": "companion"
  };
  return { endpoint, source, headers: parseKeyValueList(headersRaw), resource };
}

/** R7: the only place the exporter's state is visible. Headers appear as a count, never their value (R8). */
export function describeOtelTelemetry(env = process.env) {
  if (!truthy(env.PI_OTEL_ENABLE)) {
    return { enabled: false, source: null, endpoint: null, headers: 0, reason: "PI_OTEL_ENABLE не задан" };
  }
  const protocol = env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "";
  const config = resolveOtelConfig(env);
  if (!config) {
    // PI_OTEL_EXPORTER_OTLP_ENDPOINT alone always produces a config, so being
    // here means only the standard variables were seen (or not at all).
    const reason =
      env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT
        // Naming the standard per-signal variable here would steer the user into
        // setting it globally, which breaks Claude Code and the pi extension.
        ? `протокол ${protocol || "(пусто)"} не http-семейства; задайте PI_OTEL_EXPORTER_OTLP_ENDPOINT, а не глобальный OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
        // Claude Code strips OTEL_* from child processes, so a shell-only setup
        // silently never reaches the companion — point at the PI_ variables.
        : "OTEL_EXPORTER_OTLP_ENDPOINT не задан; задайте PI_OTEL_EXPORTER_OTLP_ENDPOINT (Claude Code не передаёт OTEL_* дочерним процессам)";
    return {
      enabled: false,
      source: null,
      endpoint: env.PI_OTEL_EXPORTER_OTLP_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
      headers: 0,
      reason
    };
  }
  return {
    enabled: true,
    source: config.source,
    endpoint: config.endpoint,
    headers: Object.keys(config.headers).length ? 1 : 0,
    reason: null
  };
}

/**
 * R5: the child pi inherits the environment, and on a non-sandboxed run its
 * telemetry extension would emit the same run a second time. Only overrides
 * when the parent actually had the variable set, so the child env is not
 * silently reshaped otherwise.
 */
export function withoutOtel(env = process.env) {
  if (env.PI_OTEL_ENABLE === undefined) {
    return env;
  }
  return { ...env, PI_OTEL_ENABLE: "0" };
}

function attributes(pairs) {
  return Object.entries(pairs)
    .filter(([, value]) => value !== "" && value !== undefined)
    .map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
}

function intPoint(labels, startTimeNs, nowNs, value) {
  return {
    attributes: attributes(labels),
    // OTLP/JSON encodes int64 as a string: it exceeds the JS safe integer range.
    startTimeUnixNano: String(startTimeNs),
    timeUnixNano: String(nowNs),
    asInt: String(Math.round(value))
  };
}

/**
 * R3: the exact wire shape the extension's collector already accepts.
 * Zero values are dropped, as in the extension, so a free local model produces
 * no `pi.cost.usage` series at all. Returns null when nothing would be sent.
 */
export function buildMetricsPayload({ model, provider = "", totals, startTimeNs, nowNs, resource }) {
  const metrics = [];
  const tokenTypes = [
    ["input", totals.input],
    ["output", totals.output],
    ["cacheRead", totals.cacheRead],
    ["cacheCreation", totals.cacheWrite]
  ];
  const tokenPoints = tokenTypes
    .filter(([, value]) => Number(value) > 0)
    .map(([type, value]) => intPoint({ model, provider, type }, startTimeNs, nowNs, value));
  if (tokenPoints.length) {
    metrics.push({
      name: TOKEN_METRIC,
      unit: "tokens",
      description: "Number of tokens used",
      sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: tokenPoints }
    });
  }
  if (Number(totals.cost) > 0) {
    metrics.push({
      name: COST_METRIC,
      unit: "USD",
      description: "Cost of the pi session in USD",
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: [
          {
            attributes: attributes({ model, provider }),
            startTimeUnixNano: String(startTimeNs),
            timeUnixNano: String(nowNs),
            asDouble: Number(totals.cost)
          }
        ]
      }
    });
  }
  if (!metrics.length) {
    return null;
  }
  return {
    resourceMetrics: [
      {
        resource: { attributes: attributes(resource) },
        scopeMetrics: [{ scope: { name: "pi-plugin-cc" }, metrics }]
      }
    ]
  };
}

/**
 * One cumulative export per terminal run. Anything thrown anywhere — config,
 * journal, network — is swallowed: telemetry has no vote in whether the run
 * succeeded, and the next export's aggregate heals any missed send.
 */
export async function exportJobMetrics(job, { env = process.env, db = null, fetchImpl = null, timeoutMs = EXPORT_TIMEOUT_MS } = {}) {
  try {
    const config = resolveOtelConfig(env);
    if (!config || !job?.model) {
      return;
    }
    // openDatabase returns {db, close}; a caller may pass that handle or a bare DatabaseSync.
    const opened = db ?? openDatabase();
    if (!opened) {
      return;
    }
    const database = opened.db ?? opened;
    const ownsHandle = !db;
    try {
      const totals = database
        .prepare(
          // Quoted camelCase aliases on purpose: buildMetricsPayload reads
          // totals.cacheRead/totals.cacheWrite, and unquoted SQL aliases fold
          // to lowercase, leaving both cache series filtered out as zero
          // (the journal columns are snake_case, the payload is not).
          "SELECT COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output, COALESCE(SUM(cache_read), 0) AS \"cacheRead\", COALESCE(SUM(cache_write), 0) AS \"cacheWrite\", COALESCE(SUM(cost), 0) AS cost FROM jobs WHERE model = ?"
        )
        .get(job.model);
      const nowNs = BigInt(Date.now()) * 1_000_000n;
      // One start per database: rewriting it per export would reset every
      // cumulative series and turn rate() in Grafana into garbage.
      let startTimeNs = nowNs;
      const stored = database.prepare("SELECT value FROM meta WHERE key = ?").get(START_TIME_KEY);
      if (stored?.value) {
        startTimeNs = BigInt(stored.value);
      } else {
        database
          .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(START_TIME_KEY, String(startTimeNs));
      }
      const { model, provider } = splitModelId(job.model);
      const payload = buildMetricsPayload({
        model,
        provider,
        totals,
        startTimeNs,
        nowNs,
        resource: config.resource
      });
      if (!payload) {
        return;
      }
      await (fetchImpl ?? fetch)(config.endpoint, {
        method: "POST",
        // One-shot export: keep-alive would leave a live socket holding the
        // process open after `pia` has nothing left to do (R6).
        headers: { ...config.headers, "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } finally {
      if (ownsHandle) {
        opened.close();
      }
    }
  } catch {
    // Deliberately silent: a dead collector must not surface in the run output (R6).
  }
}
