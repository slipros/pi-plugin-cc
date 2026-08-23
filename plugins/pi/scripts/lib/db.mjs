import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { forJournal } from "./redact.mjs";

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
  updated_at       TEXT,
  prompt           TEXT,
  result_text      TEXT,
  settings         TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
-- One row per request the run made to the model, recorded on the credential
-- proxy — the only place on the host that sees the exchange whole. The relation
-- to a run is honestly 1:N, and rolling it up on write would throw away the
-- distribution, which is the entire point: one degraded request out of forty,
-- the p90 of time-to-first-token, the longest silence inside a stream.
--
-- No foreign key on purpose: SQLite leaves them off by default, so it would be
-- a formality. Rows with no job id are not written at all instead.
CREATE TABLE IF NOT EXISTS requests (
  id               INTEGER PRIMARY KEY,
  job_id           TEXT    NOT NULL,
  seq              INTEGER NOT NULL,
  started_at       TEXT    NOT NULL,
  provider         TEXT,
  model            TEXT,
  api              TEXT,
  path             TEXT,
  stream           INTEGER DEFAULT 0,
  status           INTEGER,
  error_kind       TEXT,
  ttfb_ms          INTEGER,
  ttft_ms          INTEGER,
  stream_ms        INTEGER,
  total_ms         INTEGER,
  max_gap_ms       INTEGER,
  chunks           INTEGER,
  request_bytes    INTEGER,
  response_bytes   INTEGER,
  in_tokens        INTEGER,
  out_tokens       INTEGER,
  reasoning_tokens INTEGER,
  cached_tokens    INTEGER,
  finish_reason    TEXT,
  retry_after_ms   INTEGER,
  rl_remaining     INTEGER,
  usage_json       TEXT
);
CREATE INDEX IF NOT EXISTS requests_job     ON requests(job_id);
CREATE INDEX IF NOT EXISTS requests_started ON requests(started_at);
CREATE INDEX IF NOT EXISTS requests_model   ON requests(model, started_at);
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
/**
 * The journal holds prompts and answers — the contents of whatever repositories
 * this machine has delegated work on. `~/.local/share` is world-readable by
 * default, and so was the database in it; on a shared machine that handed every
 * task and every answer to anyone who could read the home directory.
 *
 * WAL means two more files (`-wal`, `-shm`) with the same contents, so the
 * directory is tightened rather than the file alone, and the file is chmod'ed
 * on every open to fix journals created by older versions.
 */
const JOURNAL_DIR_MODE = 0o700;
const JOURNAL_FILE_MODE = 0o600;

function tighten(file) {
  try {
    fs.chmodSync(path.dirname(file), JOURNAL_DIR_MODE);
  } catch {
    // Not ours to tighten; the run goes on.
  }
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      fs.chmodSync(candidate, JOURNAL_FILE_MODE);
    } catch {
      // Missing (WAL files appear on first write) or not ours.
    }
  }
}

export function openDatabase(file = databasePath()) {
  try {
    if (file !== ":memory:") {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: JOURNAL_DIR_MODE });
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
      if (file !== ":memory:") {
        tighten(file);
      }
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
    ["degraded", "INTEGER DEFAULT 0"],
    // What a run actually was, so it can be repeated or compared: the task it
    // was given, what it answered, and the settings it ran under.
    ["prompt", "TEXT"],
    ["result_text", "TEXT"],
    ["settings", "TEXT"],
    // Rolled up from `requests` when the run ends, so the reports keep reading
    // one table instead of joining per row.
    ["req_count", "INTEGER DEFAULT 0"],
    ["req_failed", "INTEGER DEFAULT 0"],
    ["ttft_p50_ms", "INTEGER DEFAULT 0"],
    // Generation windows only: the denominator `model_ms` never was, since it
    // carries prefill and the provider's queue with it.
    ["gen_ms", "INTEGER DEFAULT 0"],
    ["gen_out_tokens", "INTEGER DEFAULT 0"],
    // Time this run spent queued for a slot of its own pool — already measured
    // by `awaitSandboxSlot` and thrown away until now.
    ["slot_wait_ms", "INTEGER DEFAULT 0"],
    // Профиль того, КАК модель ломается. Счётчики выше говорят, сколько работа
    // стоила; эти — по какой причине она буксовала, и это разные вопросы. Их
    // приходилось выкапывать из журналов событий вручную, по одному прогону за
    // раз, а сравнивать модели между собой так нельзя вовсе.
    //
    // Рассуждение на ход — сильнейший из найденных признаков вырождения:
    // на живых прогонах у сорвавшихся оно было в 18 раз обильнее, чем у чистых,
    // при одинаковом числе ходов.
    ["think_p50_chars", "INTEGER DEFAULT 0"],
    ["think_max_chars", "INTEGER DEFAULT 0"],
    // Ход, ушедший целиком в размышление: ни текста, ни вызова инструмента.
    ["turns_idle", "INTEGER DEFAULT 0"],
    // Ответы, упёршиеся в потолок вывода, — не то же, что оборванный ПОСЛЕДНИЙ
    // ответ (тот виден в phase): счётчик показывает, сколько раз за прогон
    // генерация шла до упора.
    ["answers_cut", "INTEGER DEFAULT 0"],
    // Самая длинная серия ответов одинаковой длины подряд: повтор, укладывающийся
    // в потолок, не меняет ни одного другого поля.
    ["repeat_run", "INTEGER DEFAULT 0"],
    // Сколько раз плагин сам вмешался в круг.
    ["loop_nudges", "INTEGER DEFAULT 0"]
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
  "updated_at",
  "prompt",
  "result_text",
  "settings",
  "req_count",
  "req_failed",
  "ttft_p50_ms",
  "gen_ms",
  "gen_out_tokens",
  "slot_wait_ms",
  "think_p50_chars",
  "think_max_chars",
  "turns_idle",
  "answers_cut",
  "repeat_run",
  "loop_nudges"
];

/** Ceiling on any single stored text field. */
const MAX_TEXT_CHARS = 32 * 1024;

/**
 * How long the journal keeps the text of a run.
 *
 * Counters are history and stay forever — they are what the statistics are
 * built from. Prompts and answers are repository content, so they expire: long
 * enough to repeat or compare a run one still remembers, short enough that the
 * file is not an archive of everything this machine has ever been asked.
 */
export const DEFAULT_TEXT_TTL_DAYS = 90;

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
    updated_at: new Date().toISOString(),
    // Redacted and capped: this is repository content on its way to a file that
    // outlives the run, the temp directory and the reboot.
    prompt: forJournal(job.prompt ?? null, MAX_TEXT_CHARS),
    result_text: forJournal(job.text ?? null, MAX_TEXT_CHARS),
    settings: job.rerunSettings ? forJournal(JSON.stringify(job.rerunSettings), MAX_TEXT_CHARS) : null,
    req_count: job.proxyStats?.count ?? 0,
    req_failed: job.proxyStats?.failed ?? 0,
    ttft_p50_ms: job.proxyStats?.ttftP50Ms ?? 0,
    gen_ms: job.proxyStats?.genMs ?? 0,
    gen_out_tokens: job.proxyStats?.genOutTokens ?? 0,
    slot_wait_ms: job.slotWaitMs ?? 0,
    think_p50_chars: job.thinkP50Chars ?? 0,
    think_max_chars: job.thinkMaxChars ?? 0,
    turns_idle: job.turnsIdle ?? 0,
    answers_cut: job.proxyStats?.truncated ?? 0,
    repeat_run: job.proxyStats?.repeatRun ?? 0,
    loop_nudges: job.loopNudges ?? 0
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
      ["input", "output", "cache_read", "cache_write", "reasoning", "cost", "turns", "tool_calls", "tool_errors", "model_ms", "tool_ms", "span_ms", "peak_context", "thinking_chars", "req_count", "req_failed", "ttft_p50_ms", "gen_ms", "gen_out_tokens", "slot_wait_ms"].includes(
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
    const recorded = recordJob(handle, job);
    // Retention rides along with the writes rather than waiting for someone to
    // run `runs --prune`; at most one sweep a day, and never fatal.
    pruneJournalTextIfDue(handle);
    return recorded;
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
              -- The rate is measured on generation windows from the proxy: first
              -- content frame to last chunk, summed over the run's requests. That
              -- is the only span with neither prefill nor the provider's queue in
              -- it, both of which model_ms carries and which made the old rate
              -- understate generation by about half.
              --
              -- Short answers are excluded, because the tokens delivered in the
              -- first frame were generated *before* the window opened: the
              -- shorter the answer, the more that inflates the result. Below the
              -- threshold the honest answer is no number at all.
              --
              -- reasoning is not added to output: providers report it as a
              -- subset of output, so summing them counted hidden reasoning twice
              -- and inflated the rate by up to 59% where it is reported at all.
              SUM(CASE WHEN gen_ms > 0 AND gen_out_tokens >= 1000 THEN gen_out_tokens ELSE 0 END) AS gen_output,
              SUM(CASE WHEN gen_ms > 0 AND gen_out_tokens >= 1000 THEN gen_ms ELSE 0 END) AS gen_time_ms,
              SUM(gen_ms > 0 AND gen_out_tokens >= 1000) AS gen_runs,
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
              SUM(thinking_chars > 0 AND reasoning = 0) AS unreported_reasoning,
              -- Профиль поломки: не сколько работа стоила, а по какой причине
              -- буксовала. Рассуждение усредняется по прогонам, а не суммируется:
              -- сумма растёт с длиной прогона и ничего не говорит о модели.
              --
              -- Нули выброшены сознательно: у прогона на модели без рассуждения
              -- (или у провайдера, который его не отдаёт) медиана равна нулю, и
              -- усреднение вместе с ними занижало бы число вдвое там, где рядом
              -- стоит одна такая модель. Но тогда среднее считается НЕ по всем
              -- прогонам корзины, и это надо показывать: think_runs говорит,
              -- по скольким из runs оно посчитано.
              AVG(NULLIF(think_p50_chars, 0)) AS think_typical,
              SUM(think_p50_chars > 0) AS think_runs,
              MAX(think_max_chars) AS think_worst,
              SUM(turns_idle)      AS turns_idle,
              SUM(answers_cut)     AS answers_cut,
              MAX(repeat_run)      AS repeat_worst,
              SUM(loop_nudges)     AS loop_nudges
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
      // Generated tokens over the generation window itself. Runs without proxy
      // telemetry — every run recorded before it existed, and every unsandboxed
      // one — contribute nothing rather than being folded in on a different
      // measurement: two definitions of speed in one column is worse than a gap.
      tokensPerSecond: row.gen_time_ms > 0 ? row.gen_output / (row.gen_time_ms / 1000) : null,
      // Kept alongside so a bucket can be told apart from one it should not be
      // compared with: rates over answers of very different lengths are not
      // comparable, whatever the denominator.
      outputPerRun: row.gen_runs > 0 ? Math.round(row.gen_output / row.gen_runs) : null,
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

/**
 * The most recent runs, with what they were asked and what they answered.
 *
 * The per-workspace job records answer "what is happening here, now"; this
 * answers "what have I run, anywhere, and what did it cost" — the list `rerun`
 * picks from.
 */
export function queryRuns(handle, { limit = 20, days = null, workspace = null, model = null, preset = null, kind = null } = {}) {
  const conditions = [];
  const params = {};
  if (days) {
    conditions.push(`created_at >= datetime('now', $window)`);
    params.window = `-${Math.max(1, Math.floor(days))} days`;
  }
  for (const [column, value] of [["workspace", workspace], ["preset", preset], ["kind", kind]]) {
    if (value) {
      conditions.push(`${column} = $${column}`);
      params[column] = value;
    }
  }
  if (model) {
    conditions.push("model LIKE $model");
    params.model = `%${model}%`;
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return handle.db
    .prepare(
      `SELECT id, kind, title, workspace, run_root, preset, model, sandbox, status, created_at,
              duration_seconds, input, output, cache_read, cost, turns,
              prompt, result_text, settings
       FROM jobs ${where}
       ORDER BY created_at DESC
       LIMIT $limit`
    )
    .all({ ...params, limit: Math.max(1, Math.floor(limit)) });
}

/** One run in full, by id or by the tail of one. */
export function queryRun(handle, reference) {
  const needle = String(reference ?? "").trim();
  if (!needle) {
    return null;
  }
  return (
    handle.db.prepare("SELECT * FROM jobs WHERE id = $id").get({ id: needle }) ??
    handle.db
      .prepare("SELECT * FROM jobs WHERE id LIKE $suffix ORDER BY created_at DESC LIMIT 1")
      .get({ suffix: `%${needle}` }) ??
    null
  );
}

/**
 * Drop the stored text of runs older than the retention window.
 *
 * Only the text: counters, timings and costs stay, because every statistic is
 * built from them and a run that has aged out should still count towards "what
 * does this model cost me". What expires is the repository content — the task,
 * the answer, and the settings blob that may quote either.
 *
 * @returns {number} rows whose text was cleared
 */
export function pruneJournalText(handle, { days = DEFAULT_TEXT_TTL_DAYS } = {}) {
  if (!handle) {
    return 0;
  }
  try {
    const result = handle.db
      .prepare(
        `UPDATE jobs SET prompt = NULL, result_text = NULL, settings = NULL
         WHERE created_at < datetime('now', $window)
           AND (prompt IS NOT NULL OR result_text IS NOT NULL OR settings IS NOT NULL)`
      )
      .run({ window: `-${Math.max(1, Math.floor(days))} days` });
    return Number(result.changes ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Delete request rows older than the retention window.
 *
 * `jobs` is history and is never dropped; `requests` is roughly a hundred times
 * the volume, for a question ("how did this one run behave") that stops being
 * asked within days.
 */
export function pruneRequests(handle, { days = DEFAULT_TEXT_TTL_DAYS } = {}) {
  if (!handle) {
    return 0;
  }
  try {
    const result = handle.db
      .prepare("DELETE FROM requests WHERE started_at < datetime('now', $window)")
      .run({ window: `-${Math.max(1, Math.floor(days))} days` });
    return Number(result.changes ?? 0);
  } catch {
    return 0;
  }
}

/** How often the automatic prune bothers to look. */
const PRUNE_INTERVAL_MS = 24 * 3600 * 1000;

/**
 * Prune on a schedule without a scheduler.
 *
 * Retention that only happens when someone remembers to ask for it is not
 * retention, and there is no daemon here to run it — so the check rides along
 * with the writes that already happen, at most once a day.
 */
export function pruneJournalTextIfDue(handle, { days = DEFAULT_TEXT_TTL_DAYS, now = Date.now() } = {}) {
  if (!handle) {
    return 0;
  }
  try {
    const last = Number(handle.db.prepare("SELECT value FROM meta WHERE key = 'text_pruned_at'").get()?.value ?? 0);
    if (Number.isFinite(last) && now - last < PRUNE_INTERVAL_MS) {
      return 0;
    }
    const cleared = pruneJournalText(handle, { days });
    // Same sweep, same schedule: per-request rows are the bulk of the file.
    pruneRequests(handle, { days });
    handle.db
      .prepare("INSERT INTO meta (key, value) VALUES ('text_pruned_at', $now) ON CONFLICT(key) DO UPDATE SET value = $now")
      .run({ now: String(now) });
    return cleared;
  } catch {
    return 0;
  }
}
