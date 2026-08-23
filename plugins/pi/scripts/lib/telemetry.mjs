import { openDatabase } from "./db.mjs";
import { isTruncationReason } from "./finish-reason.mjs";

// Retention lives with the schema, in db.mjs; re-exported so the telemetry
// module stays the one place that knows about `requests`.
export { pruneRequests } from "./db.mjs";

/**
 * Per-request telemetry, collected on the credential proxy.
 *
 * The proxy is the only place on the host that sees a model exchange whole:
 * pi reports what it managed to parse, retries HTTP failures internally, and
 * carries forward six keys of whatever usage the provider sent. A 429, a
 * stream that died halfway, a provider field nobody has heard of — none of it
 * reaches the journal any other way.
 *
 * What this deliberately never touches: the messages, the system prompt, the
 * tool definitions, the response text. The request body is already parsed a few
 * lines away, which makes the discipline a choice rather than a limitation —
 * the same line `redactArgs` draws for command lines. Only the envelope is
 * measured: timings, sizes, status, and the usage object.
 *
 * Writes are batched. The journal opens and closes the database on every
 * `recordJobSafely`, which is fine twice per run and ruinous per HTTP request:
 * a hundred WAL opens per run, times however many runs are going at once.
 */

/** How long rows may sit in memory before they are flushed. */
const FLUSH_INTERVAL_MS = 30_000;

/** Rows that force an early flush, so a killed run loses a bounded amount. */
const FLUSH_AT_ROWS = 50;

const COLUMNS = [
  "job_id",
  "seq",
  "started_at",
  "provider",
  "model",
  "api",
  "path",
  "stream",
  "status",
  "error_kind",
  "ttfb_ms",
  "ttft_ms",
  "stream_ms",
  "total_ms",
  "max_gap_ms",
  "chunks",
  "request_bytes",
  "response_bytes",
  "in_tokens",
  "out_tokens",
  "reasoning_tokens",
  "cached_tokens",
  "finish_reason",
  "retry_after_ms",
  "rl_remaining",
  "usage_json"
];

/** Nearest-rank median of an unsorted array of numbers; null when empty. */
function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) {
    return null;
  }
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.5 * sorted.length) - 1)];
}

/**
 * Collect the requests of one run.
 *
 * @param {string|null} jobId  a run with no id is not recorded at all: an
 *   orphaned row answers no question and cannot be joined to anything.
 */
/** Ниже этой длины совпадение ответов ничего не значит: подтверждения совпадают сами собой. */
const REPEAT_MIN_TOKENS = 200;
/** Насколько две длины считаются «той же»: генерация одного и того же не совпадает до токена. */
const REPEAT_TOLERANCE = 0.01;

export function createRequestRecorder(jobId, { flushIntervalMs = FLUSH_INTERVAL_MS, databaseFile = null } = {}) {
  if (!jobId) {
    return null;
  }

  const pending = [];
  const summary = {
    count: 0,
    failed: 0,
    ttft: [],
    genMs: 0,
    genOutTokens: 0,
    // Why the LAST REQUEST of this job stopped, and how many hit the output
    // ceiling along the way.
    //
    // Read it for what it is: the last request, not the agent's last answer.
    // Context compaction and other housekeeping go through the same proxy and
    // legitimately end at their own ceiling, so a job that finished cleanly can
    // still have `length` here. Deciding whether the WORK was cut off is done
    // from the agent's own `stopReason` (see `wasTruncated` in pi.mjs); this
    // number is a journal entry and a fallback for runs with no proxy events.
    lastFinishReason: null,
    truncated: 0,
    // Самая длинная серия ответов одинаковой длины подряд — см. REPEAT_* ниже.
    repeatRun: 0
  };
  let seq = 0;
  let timer = null;
  let repeatLastOut = null;
  let repeatRun = 0;

  const flush = () => {
    if (!pending.length) {
      return 0;
    }
    const rows = pending.splice(0, pending.length);
    const handle = databaseFile ? openDatabase(databaseFile) : openDatabase();
    if (!handle) {
      return 0;
    }
    try {
      const statement = handle.db.prepare(
        `INSERT INTO requests (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((column) => `$${column}`).join(", ")})`
      );
      // One transaction for the batch: a hundred autocommits is a hundred
      // fsyncs, and they land while other runs are writing the same file.
      handle.db.exec("BEGIN");
      try {
        for (const row of rows) {
          statement.run(row);
        }
        handle.db.exec("COMMIT");
      } catch (error) {
        handle.db.exec("ROLLBACK");
        throw error;
      }
      return rows.length;
    } catch {
      // Telemetry is never a reason for a run to fail, or even to warn: the
      // measurement is a bonus on top of the work that actually matters.
      return 0;
    } finally {
      handle.close();
    }
  };

  const scheduleFlush = () => {
    if (timer) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, flushIntervalMs);
    // Never a reason to keep the process alive.
    timer.unref?.();
  };

  return {
    /** @param {object} request one finished exchange, already summarized */
    record(request) {
      seq += 1;
      const row = {};
      for (const column of COLUMNS) {
        row[column] = request[column] ?? null;
      }
      row.job_id = jobId;
      row.seq = seq;
      row.started_at = request.started_at ?? new Date().toISOString();
      row.stream = request.stream ? 1 : 0;
      pending.push(row);

      summary.count += 1;
      // Written for every request, absent reason included. Keeping the previous
      // value when a request ends without one made the field mean "the last
      // reason anybody reported", so a stream that died right after a truncated
      // answer left `length` standing and the job was filed as cut off.
      summary.lastFinishReason =
        request.finish_reason === undefined || request.finish_reason === null
          ? null
          : String(request.finish_reason);
      if (isTruncationReason(request.finish_reason)) {
        summary.truncated += 1;
      }
      // Повтор, укладывающийся в потолок, не помечается НИЧЕМ: finish_reason
      // здоровый, ходы идут, джоб числится сделанным. Между тем это тот же срыв,
      // просто не дотянувший до обрыва: модель повторяет один и тот же ход, а
      // контекст при этом растёт — то есть работа не движется, а платится за неё
      // полная цена. Единственный видимый признак — серия ответов одинаковой
      // длины подряд (замерено на живом прогоне: пять ответов ровно по 1283
      // токена при равномерно растущем входе).
      //
      // Короткие ответы исключены: «готово», «ок», подтверждение вызова
      // естественно совпадают по длине и повтором не являются.
      //
      // Длина сравнивается с ПЕРВЫМ ответом серии, а не с предыдущим: при
      // цепочечном сравнении допуск накапливается, и плавный дрейф (1000 → 1045
      // шагами по 0.9%) выглядит как пять одинаковых ответов, хотя одинаковых
      // среди них нет. Неудачный запрос серию РВЁТ: между двумя ответами по 1283
      // токена, разделёнными пятью ошибками провайдера, повтора не было —
      // была пауза, и склеивать их в серию значит выдавать сбой сети за
      // вырождение модели.
      const failedRequest = Boolean(request.error_kind) ||
        !(Number(request.status) >= 200 && Number(request.status) < 300);
      const out = Number(request.out_tokens);
      if (failedRequest) {
        repeatRun = 0;
        repeatLastOut = null;
      } else if (Number.isFinite(out) && out >= REPEAT_MIN_TOKENS) {
        const same =
          Number.isFinite(repeatLastOut) &&
          Math.abs(out - repeatLastOut) <= Math.max(1, repeatLastOut * REPEAT_TOLERANCE);
        repeatRun = same ? repeatRun + 1 : 1;
        summary.repeatRun = Math.max(summary.repeatRun, repeatRun);
        // Якорь держится на первом ответе серии и обновляется только при её сбросе.
        if (!same) {
          repeatLastOut = out;
        }
      } else if (Number.isFinite(out)) {
        repeatRun = 0;
        repeatLastOut = null;
      }
      // "Failed" is anything the agent had to work around: a non-2xx answer, a
      // stream that ended early, a request that never reached the provider.
      if (failedRequest) {
        summary.failed += 1;
      }
      if (Number.isFinite(request.ttft_ms)) {
        summary.ttft.push(Number(request.ttft_ms));
      }
      // Only windows with both halves measured contribute to the rate: a
      // request with no generation window would put a zero in the denominator
      // and its tokens in the numerator.
      if (Number.isFinite(request.stream_ms) && Number(request.stream_ms) > 0 && Number(request.out_tokens) > 0) {
        summary.genMs += Number(request.stream_ms);
        summary.genOutTokens += Number(request.out_tokens);
      }

      if (pending.length >= FLUSH_AT_ROWS) {
        flush();
      } else {
        scheduleFlush();
      }
    },

    /** Roll-up stored on the job row, so reports need no join. */
    stats() {
      return {
        count: summary.count,
        failed: summary.failed,
        ttftP50Ms: median(summary.ttft) ?? 0,
        genMs: Math.round(summary.genMs),
        genOutTokens: summary.genOutTokens,
        lastFinishReason: summary.lastFinishReason,
        truncated: summary.truncated,
        repeatRun: summary.repeatRun
      };
    },

    /** Flush whatever is left. Called when the run ends, however it ends. */
    close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return flush();
    }
  };
}

/** Every recorded request of one run, oldest first. */
export function queryRequests(handle, jobId) {
  if (!handle || !jobId) {
    return [];
  }
  try {
    return handle.db.prepare("SELECT * FROM requests WHERE job_id = $id ORDER BY seq").all({ id: String(jobId) });
  } catch {
    return [];
  }
}
