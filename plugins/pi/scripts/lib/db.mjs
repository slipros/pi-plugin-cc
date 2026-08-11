import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Durable journal of pi runs.
 *
 * Job records live in a temp directory, bucketed per workspace and capped at
 * the newest 50 — fine for "what is running right now", useless for "how much
 * did this week cost": the buckets are unrelated to each other and the whole
 * tree disappears on reboot. This module keeps one SQLite file outside that
 * lifecycle, written alongside the JSON records rather than instead of them,
 * so the CLI keeps working exactly as before if the database cannot be opened.
 *
 * node:sqlite ships with Node and is still marked experimental, which is worth
 * one warning to the user and no more.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  kind             TEXT,
  title            TEXT,
  workspace        TEXT,
  run_root         TEXT,
  preset           TEXT,
  model            TEXT,
  sandbox          TEXT,
  status           TEXT,
  phase            TEXT,
  created_at       TEXT,
  started_at       TEXT,
  completed_at     TEXT,
  duration_seconds INTEGER,
  input            INTEGER DEFAULT 0,
  output           INTEGER DEFAULT 0,
  cache_read       INTEGER DEFAULT 0,
  cache_write      INTEGER DEFAULT 0,
  reasoning        INTEGER DEFAULT 0,
  cost             REAL    DEFAULT 0,
  turns            INTEGER DEFAULT 0,
  tool_calls       INTEGER DEFAULT 0,
  tool_errors      INTEGER DEFAULT 0,
  model_ms         INTEGER DEFAULT 0,
  tool_ms          INTEGER DEFAULT 0,
  span_ms          INTEGER DEFAULT 0,
  peak_context     INTEGER DEFAULT 0,
  thinking_chars   INTEGER DEFAULT 0,
  degraded         INTEGER DEFAULT 0,
  session_id       TEXT,
  background       INTEGER DEFAULT 0,
  updated_at       TEXT
);
CREATE INDEX IF NOT EXISTS jobs_created_at ON jobs(created_at);
CREATE INDEX IF NOT EXISTS jobs_model      ON jobs(model);
CREATE INDEX IF NOT EXISTS jobs_workspace  ON jobs(workspace);
`;

export function databasePath() {
  if (process.env.PI_PLUGIN_DB) {
    return path.resolve(process.env.PI_PLUGIN_DB);
  }
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "pi-plugin", "jobs.db");
}

/**
 * `new DatabaseSync()` emits an ExperimentalWarning every time. The feature is
 * a deliberate choice, not news to anyone reading job statistics, and the
 * warning would land in the middle of command output — so it is dropped while
 * every other warning still gets through.
 */
function withoutSqliteWarning(fn) {
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const text = typeof warning === "string" ? warning : warning?.message ?? "";
    if (/SQLite is an experimental feature/i.test(text)) {
      return undefined;
    }
    return emit.call(process, warning, ...rest);
  };
  try {
    return fn();
  } finally {
    process.emitWarning = emit;
  }
}

/**
 * Open the journal, creating it if needed.
 *
 * @returns {{db: object, close: () => void} | null} null when SQLite is
 *   unavailable — recording is a bonus, never a reason for a run to fail.
 */
export function openDatabase(file = databasePath()) {
  try {
    if (file !== ":memory:") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    return withoutSqliteWarning(() => {
      const db = new (loadSqlite().DatabaseSync)(file);
      db.exec("PRAGMA journal_mode = WAL");
      // Without this a second writer fails instantly with SQLITE_BUSY instead of
      // waiting, and since recording is best-effort the loss is silent: the run
      // stays `running` in the journal with zero tokens forever. The plugin is
      // built for fan-out background runs, so contention is the normal case.
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec(SCHEMA);
      addMissingColumns(db);
      return { db, close: () => db.close() };
    });
  } catch {
    return null;
  }
}

/**
 * Bring an existing journal up to the current schema.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * a column added later would only ever reach fresh databases — every journal
 * with history in it would keep failing the queries that read the new column.
 * Old rows get the default, which reads as "this run predates the measurement".
 */
function addMissingColumns(db) {
  const present = new Set(db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name));
  const additions = [
    ["model_ms", "INTEGER DEFAULT 0"],
    ["tool_ms", "INTEGER DEFAULT 0"],
    ["span_ms", "INTEGER DEFAULT 0"],
    ["peak_context", "INTEGER DEFAULT 0"],
    ["thinking_chars", "INTEGER DEFAULT 0"],
    ["degraded", "INTEGER DEFAULT 0"]
  ];
  for (const [name, definition] of additions) {
    if (!present.has(name)) {
      db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
    }
  }
}

/**
 * node:sqlite is loaded synchronously and only when asked for: the module does
 * not exist on Node 18/20, which the plugin still supports, and a static import
 * would break those installs on startup rather than degrade here.
 */
function loadSqlite() {
  if (typeof process.getBuiltinModule !== "function") {
    throw new Error("node:sqlite needs Node 22.3+");
  }
  const sqlite = process.getBuiltinModule("node:sqlite");
  if (!sqlite?.DatabaseSync) {
    throw new Error("node:sqlite is not available in this Node build");
  }
  return sqlite;
}

const COLUMNS = [
  "id",
  "kind",
  "title",
  "workspace",
  "run_root",
  "preset",
  "model",
  "sandbox",
  "status",
  "phase",
  "created_at",
  "started_at",
  "completed_at",
  "duration_seconds",
  "input",
  "output",
  "cache_read",
  "cache_write",
  "reasoning",
  "cost",
  "turns",
  "tool_calls",
  "tool_errors",
  "model_ms",
  "tool_ms",
  "span_ms",
  "peak_context",
  "thinking_chars",
  "degraded",
  "session_id",
  "background",
  "updated_at"
];

function seconds(from, to) {
  const start = Date.parse(from ?? "");
  const end = Date.parse(to ?? "");
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  return Math.max(0, Math.round((end - start) / 1000));
}

/** Map a job record (the JSON shape) onto the table's columns. */
export function jobToRow(job) {
  const usage = job.usage ?? {};
  return {
    id: job.id,
    kind: job.kind ?? null,
    title: job.title ?? null,
    workspace: job.workspaceRoot ?? null,
    run_root: job.runRoot ?? job.workspaceRoot ?? null,
    preset: job.preset ?? null,
    model: job.model ?? null,
    sandbox: job.sandbox ?? null,
    status: job.status ?? null,
    phase: job.phase ?? null,
    created_at: job.createdAt ?? null,
    started_at: job.startedAt ?? null,
    completed_at: job.completedAt ?? null,
    duration_seconds: seconds(job.startedAt ?? job.createdAt, job.completedAt),
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cache_read: usage.cacheRead ?? 0,
    cache_write: usage.cacheWrite ?? 0,
    reasoning: usage.reasoning ?? 0,
    cost: usage.cost ?? 0,
    turns: job.turns ?? 0,
    tool_calls: Array.isArray(job.toolCalls) ? job.toolCalls.length : (job.toolCalls ?? 0),
    tool_errors: job.toolErrors ?? 0,
    model_ms: job.timing?.modelMs ?? 0,
    tool_ms: job.timing?.toolMs ?? 0,
    span_ms: job.timing?.spanMs ?? 0,
    peak_context: job.peakContext ?? 0,
    thinking_chars: job.thinkingChars ?? 0,
    degraded: job.degraded ? 1 : 0,
    session_id: job.sessionId ?? null,
    background: job.background ? 1 : 0,
    updated_at: new Date().toISOString()
  };
}

/**
 * Insert or update one job. Counters only ever move forward, so a late write
 * from a slower path cannot reset a total that a later one already raised.
 */
export function recordJob(handle, job) {
  if (!handle || !job?.id) {
    return false;
  }
  const row = jobToRow(job);
  const placeholders = COLUMNS.map((column) => `$${column}`).join(", ");
  const updates = COLUMNS.filter((column) => column !== "id")
    .map((column) =>
      ["input", "output", "cache_read", "cache_write", "reasoning", "cost", "turns", "tool_calls", "tool_errors", "model_ms", "tool_ms", "span_ms", "peak_context", "thinking_chars"].includes(
        column
      )
        ? `${column} = MAX(${column}, excluded.${column})`
        : `${column} = COALESCE(excluded.${column}, ${column})`
    )
    .join(", ");

  try {
    handle.db
      .prepare(
        `INSERT INTO jobs (${COLUMNS.join(", ")}) VALUES (${placeholders})
         ON CONFLICT(id) DO UPDATE SET ${updates}`
      )
      .run(row);
    return true;
  } catch {
    return false;
  }
}

/** Fire-and-forget write used from the hot path. */
export function recordJobSafely(job) {
  const handle = openDatabase();
  if (!handle) {
    return false;
  }
  try {
    return recordJob(handle, job);
  } finally {
    handle.close();
  }
}

/**
 * Window clause for the last N days.
 *
 * Timestamps are stored as ISO strings with a `T`, while `datetime()` returns a
 * space-separated one; comparing them as text let the whole boundary day in,
 * because 'T' sorts after ' '. Replacing the separator makes the comparison
 * mean what the flag says. A non-positive or non-numeric value means no window
 * rather than a clause SQLite evaluates to NULL, which matched nothing at all.
 */
function whereWithinDays(days) {
  const window = Number(days);
  if (!Number.isFinite(window) || window <= 0) {
    return "";
  }
  return `WHERE created_at >= replace(datetime('now', '-${window} days'), ' ', 'T')`;
}

const GROUPS = {
  day: "date(created_at)",
  model: "COALESCE(model, '(unknown)')",
  preset: "COALESCE(preset, '(none)')",
  workspace: "COALESCE(workspace, '(unknown)')",
  kind: "COALESCE(kind, '(unknown)')",
  status: "COALESCE(status, '(unknown)')"
};

/**
 * Token totals grouped along one axis.
 *
 * @param {object} handle
 * @param {{by?: string, days?: number|null, limit?: number}} options
 */
export function queryStats(handle, { by = "day", days = 30, limit = 50 } = {}) {
  const expression = GROUPS[by];
  if (!expression) {
    throw new Error(`Unknown grouping "${by}". Use one of: ${Object.keys(GROUPS).join(", ")}.`);
  }
  const where = whereWithinDays(days);
  const rows = handle.db
    .prepare(
      `SELECT ${expression} AS bucket,
              COUNT(*)            AS runs,
              SUM(status = 'completed') AS completed,
              SUM(status IN ('failed', 'orphaned', 'cancelled')) AS failed,
              SUM(input)          AS input,
              SUM(output)         AS output,
              SUM(reasoning)      AS reasoning,
              SUM(cache_read)     AS cache_read,
              SUM(cost)           AS cost,
              SUM(duration_seconds) AS seconds,
              SUM(model_ms)       AS model_ms,
              SUM(tool_ms)        AS tool_ms,
              -- Tokens from the same rows the model time came from: mixing the
              -- output of untimed runs into a rate measured on timed ones
              -- inflates it without limit. A run that spent model time and
              -- produced nothing is excluded from both sides for the same
              -- reason — one 300s timeout would otherwise halve a bucket.
              --
              -- reasoning is not added to output: providers report it as a
              -- subset of output, so summing them counted hidden reasoning
              -- twice and inflated the rate by up to 59% for the providers
              -- that report it at all.
              SUM(CASE WHEN model_ms > 0 AND output > 0 THEN output ELSE 0 END) AS timed_output,
              SUM(CASE WHEN model_ms > 0 AND output > 0 THEN model_ms ELSE 0 END) AS timed_model_ms,
              SUM(model_ms > 0 AND output > 0) AS timed_runs,
              SUM(turns)          AS turns,
              -- Denominator for per-run averages: runs recorded before the
              -- counters existed carry zeroes, and dividing by COUNT(*) halved
              -- every average without saying so.
              SUM(turns > 0)      AS counted_runs,
              SUM(tool_calls)     AS tool_calls,
              SUM(tool_errors)    AS tool_errors,
              -- Context is a high-water mark per run, so it averages and peaks
              -- rather than summing: totals across runs mean nothing here.
              AVG(NULLIF(peak_context, 0)) AS avg_context,
              MAX(peak_context)   AS max_context,
              SUM(degraded)       AS degraded,
              -- A provider that streams thinking but reports reasoning = 0 has
              -- its generated tokens missing from any rate's numerator.
              SUM(thinking_chars > 0 AND reasoning = 0) AS unreported_reasoning
       FROM jobs ${where}
       GROUP BY bucket
       ORDER BY (SUM(input) + SUM(output)) DESC, bucket DESC
       LIMIT ${Number(limit)}`
    )
    .all();

  // Percentiles come from the raw durations: SQLite has no percentile function,
  // and an average hides exactly what the question is about — whether a model is
  // usually quick with rare disasters, or uniformly slow.
  const durations = new Map();
  for (const row of handle.db
    .prepare(
      `SELECT ${expression} AS bucket, duration_seconds AS seconds
       FROM jobs ${where} ${where ? "AND" : "WHERE"} duration_seconds IS NOT NULL
       ORDER BY duration_seconds`
    )
    .all()) {
    if (!durations.has(row.bucket)) {
      durations.set(row.bucket, []);
    }
    durations.get(row.bucket).push(row.seconds);
  }

  return rows.map((row) => {
    const sorted = durations.get(row.bucket) ?? [];
    return {
      ...row,
      // Generated tokens over the time actually spent waiting on the model,
      // which is the run minus its tools. Runs recorded before timings existed
      // carry a zero and simply do not contribute.
      tokensPerSecond: row.timed_model_ms > 0 ? row.timed_output / (row.timed_model_ms / 1000) : null,
      p50Seconds: percentile(sorted, 0.5),
      p90Seconds: percentile(sorted, 0.9)
    };
  });
}

/** Nearest-rank percentile of an ascending array; null when there is nothing. */
function percentile(sorted, fraction) {
  if (!sorted.length) {
    return null;
  }
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function queryTotals(handle, { days = 30 } = {}) {
  const where = whereWithinDays(days);
  return (
    handle.db
      .prepare(
        `SELECT COUNT(*) AS runs, SUM(input) AS input, SUM(output) AS output,
                SUM(cache_read) AS cache_read, SUM(cost) AS cost,
                SUM(duration_seconds) AS seconds
         FROM jobs ${where}`
      )
      .get() ?? {}
  );
}
