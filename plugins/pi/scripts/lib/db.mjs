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
      db.exec(SCHEMA);
      return { db, close: () => db.close() };
    });
  } catch {
    return null;
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
      ["input", "output", "cache_read", "cache_write", "reasoning", "cost", "turns", "tool_calls", "tool_errors"].includes(
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
  const where = days ? `WHERE created_at >= datetime('now', '-${Number(days)} days')` : "";
  return handle.db
    .prepare(
      `SELECT ${expression} AS bucket,
              COUNT(*)            AS runs,
              SUM(input)          AS input,
              SUM(output)         AS output,
              SUM(cache_read)     AS cache_read,
              SUM(cost)           AS cost,
              SUM(duration_seconds) AS seconds
       FROM jobs ${where}
       GROUP BY bucket
       ORDER BY (SUM(input) + SUM(output)) DESC, bucket DESC
       LIMIT ${Number(limit)}`
    )
    .all();
}

export function queryTotals(handle, { days = 30 } = {}) {
  const where = days ? `WHERE created_at >= datetime('now', '-${Number(days)} days')` : "";
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
