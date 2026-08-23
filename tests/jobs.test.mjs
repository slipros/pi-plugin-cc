import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Tracked runs also write to the durable journal, whose default location is the
// user's own data directory. Point it somewhere disposable before importing
// anything that records, or a test run pollutes real usage statistics.
process.env.PI_PLUGIN_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-")), "jobs.db");

import {
  buildStatusSnapshot,
  createJobLogFile,
  createProgressReporter,
  enrichJob,
  formatElapsed,
  resolveCancelableJob,
  resolveResultJob,
  runTrackedJob
} from "../plugins/pi/scripts/lib/jobs.mjs";
import { listJobs, resolveJobFile, upsertJob, writeJobFile } from "../plugins/pi/scripts/lib/state.mjs";

// `async`, and awaiting the body, on purpose. Synchronous, it returned the
// caller's promise and ran `finally` at the body's first `await`: the fixture
// was deleted and CLAUDE_PLUGIN_DATA unset while the test was still running, so
// everything after that point wrote to the real user state directory through the
// homedir fallback — 168 stray job buckets in one afternoon, and three tests that
// passed by reading a file they had written outside their own fixture.
async function withWorkspace(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-jobs-"));
  const workspaceRoot = path.join(dataDir, "repo");
  fs.mkdirSync(workspaceRoot);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    return await run(workspaceRoot);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("a tracked job records its result and stays readable afterwards", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const job = { id: "pi-1", kind: "delegate", title: "task", workspaceRoot, logFile: null };
    const execution = await runTrackedJob(job, async () => ({
      exitStatus: 0,
      sessionId: "session-9",
      model: "opencode-go/glm-5.2",
      usage: { input: 1 },
      summary: "done",
      rendered: "# result\n",
      errors: []
    }));

    assert.equal(execution.sessionId, "session-9");

    const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspaceRoot, "pi-1"), "utf8"));
    assert.equal(stored.status, "completed");
    assert.equal(stored.pid, null);
    assert.equal(stored.rendered, "# result\n");

    const { job: resolved, stored: storedResult } = resolveResultJob(workspaceRoot);
    assert.equal(resolved.id, "pi-1");
    assert.equal(storedResult.sessionId, "session-9");
  });
});

test("a non-zero exit marks the job failed", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const job = { id: "pi-2", kind: "review", workspaceRoot, logFile: null };
    await runTrackedJob(job, async () => ({ exitStatus: 1, rendered: "boom", errors: ["nope"] }));
    assert.equal(listJobs(workspaceRoot)[0].status, "failed");
  });
});

test("a thrown runner is stored as a failure with its message", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const job = { id: "pi-3", kind: "delegate", workspaceRoot, logFile: null };
    await assert.rejects(
      runTrackedJob(job, async () => {
        throw new Error("pi exploded");
      }),
      /pi exploded/
    );
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspaceRoot, "pi-3"), "utf8"));
    assert.equal(stored.status, "failed");
    assert.equal(stored.errorMessage, "pi exploded");
  });
});

test("a running job whose process is gone is reported as orphaned", () => {
  const enriched = enrichJob({
    id: "pi-4",
    kind: "delegate",
    status: "running",
    pid: 2_147_483_600,
    startedAt: new Date(Date.now() - 5000).toISOString()
  });
  assert.equal(enriched.status, "orphaned");
});

test("a live process keeps its running status", () => {
  const enriched = enrichJob({ id: "pi-5", status: "running", pid: process.pid, startedAt: new Date().toISOString() });
  assert.equal(enriched.status, "running");
});

test("status shows newest first and can be filtered to one job", () => {
  withWorkspace((workspaceRoot) => {
    upsertJob(workspaceRoot, { id: "pi-old", kind: "delegate", status: "completed", createdAt: "2020-01-01T00:00:00.000Z" });
    upsertJob(workspaceRoot, { id: "pi-new", kind: "review", status: "completed", createdAt: "2030-01-01T00:00:00.000Z" });

    const all = buildStatusSnapshot(workspaceRoot);
    assert.deepEqual(all.jobs.map((job) => job.id), ["pi-new", "pi-old"]);

    const single = buildStatusSnapshot(workspaceRoot, { jobId: "pi-old" });
    assert.equal(single.jobs.length, 1);
    assert.throws(() => buildStatusSnapshot(workspaceRoot, { jobId: "missing" }), /No pi job matches/);
  });
});

test("result refuses to guess while only unfinished jobs exist", () => {
  withWorkspace((workspaceRoot) => {
    assert.throws(() => resolveResultJob(workspaceRoot), /No pi jobs have been recorded/);
    upsertJob(workspaceRoot, { id: "pi-run", kind: "delegate", status: "running", pid: process.pid, createdAt: new Date().toISOString() });
    assert.throws(() => resolveResultJob(workspaceRoot), /No finished pi job yet/);
  });
});

test("cancel needs an explicit id when several jobs run", () => {
  withWorkspace((workspaceRoot) => {
    assert.throws(() => resolveCancelableJob(workspaceRoot), /No running pi job/);
    upsertJob(workspaceRoot, { id: "pi-a", kind: "delegate", status: "running", pid: process.pid, createdAt: "2030-01-01T00:00:00.000Z" });
    assert.equal(resolveCancelableJob(workspaceRoot).id, "pi-a");
    upsertJob(workspaceRoot, { id: "pi-b", kind: "review", status: "running", pid: process.pid, createdAt: "2030-01-02T00:00:00.000Z" });
    assert.throws(() => resolveCancelableJob(workspaceRoot), /Multiple pi jobs are running/);
  });
});

test("progress writes to the log and pushes phase changes into the job record", () => {
  withWorkspace((workspaceRoot) => {
    writeJobFile(workspaceRoot, "pi-6", { id: "pi-6", status: "running" });
    upsertJob(workspaceRoot, { id: "pi-6", status: "running" });
    const logFile = createJobLogFile(workspaceRoot, "pi-6", "a task");
    const report = createProgressReporter({ workspaceRoot, jobId: "pi-6", logFile });

    report({ phase: "working", message: "read: src/index.ts" });
    report({ phase: "working", message: "grep: TODO" });

    const log = fs.readFileSync(logFile, "utf8");
    assert.match(log, /Starting a task\./);
    assert.match(log, /read: src\/index\.ts/);
    assert.equal(listJobs(workspaceRoot)[0].phase, "working");
  });
});

test("elapsed time is formatted for humans", () => {
  const start = "2026-01-01T00:00:00.000Z";
  assert.equal(formatElapsed(start, "2026-01-01T00:00:42.000Z"), "42s");
  assert.equal(formatElapsed(start, "2026-01-01T00:03:07.000Z"), "3m 7s");
  assert.equal(formatElapsed(start, "2026-01-01T02:05:00.000Z"), "2h 5m");
  assert.equal(formatElapsed("nonsense"), null);
});

test("usage is recorded while the job runs, one write per assistant turn", async () => {
  const { createProgressReporter } = await import("../plugins/pi/scripts/lib/jobs.mjs");
  const { resolveJobFile, writeJobFile, ensureStateDir } = await import("../plugins/pi/scripts/lib/state.mjs");
  const fsMod = await import("node:fs");
  const pathMod = await import("node:path");

  // Через ту же фикстуру, что и остальные: свой mkdtemp давал рабочий каталог,
  // но не подменял CLAUDE_PLUGIN_DATA, и состояние джоба уезжало в настоящий
  // каталог пользователя — там оно и оставалось после теста.
  await withWorkspace(async (workspaceRoot) => {
    ensureStateDir(workspaceRoot);
    const jobId = "delegate-usage-1";
    writeJobFile(workspaceRoot, jobId, { id: jobId, status: "running" });
    const logFile = pathMod.join(workspaceRoot, "job.log");
    const report = createProgressReporter({ workspaceRoot, jobId, logFile });

    const read = () => JSON.parse(fsMod.readFileSync(resolveJobFile(workspaceRoot, jobId), "utf8"));

    report({ phase: "working", message: "Turn 1 started.", usage: {} });
    assert.equal(read().usage, undefined, "an empty usage object is not worth a write");

    report({ phase: "working", message: "answer", usage: { input: 100, output: 20, cost: 0.5 } });
    assert.deepEqual(read().usage, { input: 100, output: 20, cost: 0.5 });

    report({ phase: "working", message: "bash: ls", usage: { input: 100, output: 20, cost: 0.5 } });
    assert.deepEqual(read().usage, { input: 100, output: 20, cost: 0.5 }, "unchanged counters do not rewrite");

    report({ phase: "working", message: "answer", usage: { input: 250, output: 40, cost: 1.5 } });
    assert.deepEqual(read().usage, { input: 250, output: 40, cost: 1.5 });
  });
});

// The class this guards: a run whose last answer hit the output ceiling exits
// zero with the work undone — the truncated tool call is dropped and a sentence
// of intent becomes the final answer. Nothing else in the pipeline notices.
test("a run cut off on its last answer is not reported as done", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const job = { id: "pi-trunc", kind: "delegate", title: "task", workspaceRoot, logFile: null };
    await runTrackedJob(job, async () => ({
      exitStatus: 0,
      rendered: "Now let me register it in the service and wire it up:",
      errors: [],
      proxyStats: { count: 13, failed: 0, lastFinishReason: "length", truncated: 1 }
    }));

    const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspaceRoot, "pi-trunc"), "utf8"));
    assert.equal(stored.status, "completed", "the process did exit zero — that part is not a lie");
    assert.equal(stored.phase, "truncated", "but the work is not finished, and the record has to say so");
  });
});

test("a truncation earlier in the run is not held against a finished job", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const job = { id: "pi-mid", kind: "delegate", title: "task", workspaceRoot, logFile: null };
    await runTrackedJob(job, async () => ({
      exitStatus: 0,
      rendered: "# отчёт\nСТАТУС\n",
      errors: [],
      // Cut off mid-run: costs tokens and a retry, then the run carried on and
      // finished normally.
      proxyStats: { count: 212, failed: 0, lastFinishReason: "tool_calls", truncated: 2 }
    }));

    assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspaceRoot, "pi-mid"), "utf8")).phase, "done");
  });
});

test("a run without proxy telemetry keeps the old verdict", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const job = { id: "pi-notel", kind: "delegate", title: "task", workspaceRoot, logFile: null };
    await runTrackedJob(job, async () => ({ exitStatus: 0, rendered: "ok", errors: [] }));
    assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspaceRoot, "pi-notel"), "utf8")).phase, "done");
  });
});

// Сигнал берётся из самого прогона, а не из телеметрии прокси: прокси
// поднимается только в песочнице, а несэндбоксный прогон — дефолт. Пока фаза
// считалась по `proxyStats`, каждый такой обрыв уходил под галочку.
test("an unsandboxed run reports truncation from its own stop reason", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const job = { id: "pi-nosandbox", kind: "delegate", title: "task", workspaceRoot, logFile: null };
    await runTrackedJob(job, async () => ({
      exitStatus: 0,
      rendered: "Now let me wire this up:",
      errors: [],
      stopReason: "length",
      proxyStats: null
    }));

    const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspaceRoot, "pi-nosandbox"), "utf8"));
    assert.equal(stored.phase, "truncated");
  });
});

// Провайдеры называют потолок по-разному: OpenAI `length`, Anthropic
// `max_tokens`, Google `MAX_TOKENS`. Сравнение с одним написанием выключало
// фичу для всех остальных.
test("truncation is recognised in every provider's spelling", async () => {
  for (const [id, stopReason] of [
    ["pi-anthropic", "max_tokens"],
    ["pi-google", "MAX_TOKENS"]
  ]) {
    await withWorkspace(async (workspaceRoot) => {
      const job = { id, kind: "delegate", title: "task", workspaceRoot, logFile: null };
      await runTrackedJob(job, async () => ({ exitStatus: 0, rendered: "…", errors: [], stopReason }));
      assert.equal(
        JSON.parse(fs.readFileSync(resolveJobFile(workspaceRoot, id), "utf8")).phase,
        "truncated",
        `${stopReason} — тот же обрыв, что и length`
      );
    });
  }
});

// Причина последнего ответа перебивает телеметрию прокси: компакция контекста
// идёт через тот же прокси и штатно упирается в свой потолок, так что
// `lastFinishReason` завершившегося прогона вполне может быть "length".
test("a finished answer is not overruled by the proxy's last request", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const job = { id: "pi-compaction", kind: "delegate", title: "task", workspaceRoot, logFile: null };
    await runTrackedJob(job, async () => ({
      exitStatus: 0,
      rendered: "# отчёт\nСТАТУС\n",
      errors: [],
      stopReason: "stop",
      proxyStats: { count: 40, failed: 0, lastFinishReason: "length", truncated: 1 }
    }));

    assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspaceRoot, "pi-compaction"), "utf8")).phase, "done");
  });
});

test("a failed or cancelled run keeps its own phase, truncation or not", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const failed = { id: "pi-failed", kind: "delegate", title: "task", workspaceRoot, logFile: null };
    await runTrackedJob(failed, async () => ({
      exitStatus: 1,
      rendered: "",
      errors: ["provider returned 500"],
      stopReason: "length"
    }));
    const failedRecord = JSON.parse(fs.readFileSync(resolveJobFile(workspaceRoot, "pi-failed"), "utf8"));
    assert.equal(failedRecord.status, "failed");
    assert.equal(failedRecord.phase, "failed", "обрыв не переписывает провал");

    const cancelled = { id: "pi-cancelled", kind: "delegate", title: "task", workspaceRoot, logFile: null };
    await runTrackedJob(cancelled, async () => ({
      exitStatus: 1,
      rendered: "half",
      errors: ["The run was aborted before pi finished."],
      aborted: true,
      stopReason: "length"
    }));
    const cancelledRecord = JSON.parse(fs.readFileSync(resolveJobFile(workspaceRoot, "pi-cancelled"), "utf8"));
    assert.equal(cancelledRecord.status, "cancelled");
    assert.equal(cancelledRecord.phase, "failed");
  });
});

// «Деградировавший» прогон — тот, что выдал работу и упал на косметике обрыва
// потока; он считается completed, поэтому обрыв ответа для него значим так же.
test("a degraded run still reports a truncated answer", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const job = { id: "pi-degraded", kind: "delegate", title: "task", workspaceRoot, logFile: null };
    await runTrackedJob(job, async () => ({
      exitStatus: 1,
      rendered: "Now let me wire this up:",
      text: "Now let me wire this up:",
      errors: ["stream ended without a finish_reason"],
      stopReason: "length"
    }));

    const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspaceRoot, "pi-degraded"), "utf8"));
    assert.equal(stored.status, "completed", "работа доехала, падение косметическое");
    assert.equal(stored.phase, "truncated");
  });
});

test("how many times a run had to continue itself is kept in the record", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const job = { id: "pi-recovered", kind: "delegate", title: "task", workspaceRoot, logFile: null };
    await runTrackedJob(job, async () => ({
      exitStatus: 0,
      rendered: "# отчёт\nСТАТУС\n",
      errors: [],
      stopReason: "stop",
      recoveredTruncations: 3
    }));

    const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspaceRoot, "pi-recovered"), "utf8"));
    assert.equal(stored.phase, "done", "прогон вытащил себя сам и закончился");
    assert.equal(stored.recoveredTruncations, 3, "но чего это стоило — видно");
  });
});

// Движок json (runPiTurn) не кладёт thinkP50Chars/thinkMaxChars/turnsIdle/
// loopNudges в execution вовсе — этой телеметрии там нет физически. Раньше
// runTrackedJob подставлял `?? 0`, и в журнал уезжал ноль, неотличимый от
// настоящего замера rpc-движка. Проверяется именно то, что доезжает до
// SQLite-журнала, а не до job-файла: `?? 0` жил в аргументе recordJobSafely.
test("прогон в форме движка json пишет в журнал NULL, а не 0, для непосчитанных метрик круга", async () => {
  const { openDatabase, queryRun } = await import("../plugins/pi/scripts/lib/db.mjs");
  await withWorkspace(async (workspaceRoot) => {
    const job = { id: "pi-json-engine-metrics", kind: "delegate", title: "task", workspaceRoot, logFile: null };
    await runTrackedJob(job, async () => ({
      exitStatus: 0,
      rendered: "ok",
      errors: [],
      turns: 5
      // Намеренно нет thinkP50Chars/thinkMaxChars/turnsIdle/loopNudges — так
      // выглядит результат runPiTurn.
    }));

    const handle = openDatabase(process.env.PI_PLUGIN_DB);
    try {
      const row = queryRun(handle, "pi-json-engine-metrics");
      assert.ok(row, "запись должна попасть в журнал");
      assert.equal(row.think_p50_chars, null, "движок json это не считает — NULL, не 0");
      assert.equal(row.think_max_chars, null);
      assert.equal(row.turns_idle, null);
      assert.equal(row.loop_nudges, null);
    } finally {
      handle.close();
    }
  });
});

test("прогон в форме движка rpc с настоящим нулём пишет в журнал 0, а не NULL", async () => {
  const { openDatabase, queryRun } = await import("../plugins/pi/scripts/lib/db.mjs");
  await withWorkspace(async (workspaceRoot) => {
    const job = { id: "pi-rpc-engine-zero", kind: "delegate", title: "task", workspaceRoot, logFile: null };
    await runTrackedJob(job, async () => ({
      exitStatus: 0,
      rendered: "ok",
      errors: [],
      turns: 5,
      // Форма ответа runPiRpcTurn на чистом прогоне: поля есть и честно нулевые.
      thinkP50Chars: 0,
      thinkMaxChars: 0,
      turnsIdle: 0,
      loopNudges: 0
    }));

    const handle = openDatabase(process.env.PI_PLUGIN_DB);
    try {
      const row = queryRun(handle, "pi-rpc-engine-zero");
      assert.equal(row.think_p50_chars, 0, "измерено и вышел настоящий ноль — не NULL");
      assert.equal(row.turns_idle, 0);
      assert.equal(row.loop_nudges, 0);
    } finally {
      handle.close();
    }
  });
});
