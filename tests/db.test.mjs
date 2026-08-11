import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { jobToRow, openDatabase, queryStats, queryTotals, recordJob } from "../plugins/pi/scripts/lib/db.mjs";

function temporaryDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-"));
  return { handle: openDatabase(path.join(dir, "jobs.db")), dir };
}

function job(overrides = {}) {
  return {
    id: "delegate-1",
    kind: "delegate",
    model: "ollama-pro/deepseek",
    preset: "go-developer",
    workspaceRoot: "/repo",
    status: "completed",
    createdAt: new Date().toISOString(),
    startedAt: new Date(Date.now() - 12_000).toISOString(),
    completedAt: new Date().toISOString(),
    usage: { input: 100, output: 20, cost: 0.5 },
    ...overrides
  };
}

test("a job record maps onto the journal's columns", () => {
  const row = jobToRow(job({ toolCalls: ["read", "bash"], runRoot: "/elsewhere" }));
  assert.equal(row.workspace, "/repo");
  assert.equal(row.run_root, "/elsewhere", "the directory the agent actually worked in is kept separately");
  assert.equal(row.input, 100);
  assert.equal(row.tool_calls, 2);
  assert.equal(row.duration_seconds, 12);
});

test("re-recording a job keeps the larger counters", () => {
  const { handle, dir } = temporaryDatabase();
  assert.ok(handle, "node:sqlite should be available on this Node");

  recordJob(handle, job({ status: "running", usage: { input: 100, output: 20, cost: 0.5 } }));
  recordJob(handle, job({ status: "completed", usage: { input: 250, output: 40, cost: 1.5 } }));
  // A stale write must not undo a total a later one already raised.
  recordJob(handle, job({ status: "completed", usage: { input: 10, output: 1, cost: 0 } }));

  const totals = queryTotals(handle, { days: null });
  assert.equal(totals.runs, 1, "the same job id stays one row");
  assert.equal(totals.input, 250);
  assert.equal(totals.output, 40);

  handle.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("totals group along whichever axis is asked for", () => {
  const { handle, dir } = temporaryDatabase();

  recordJob(handle, job({ id: "a", model: "m1", preset: "fast", usage: { input: 10, output: 1 } }));
  recordJob(handle, job({ id: "b", model: "m1", preset: "deep", usage: { input: 30, output: 3 } }));
  recordJob(handle, job({ id: "c", model: "m2", preset: "deep", usage: { input: 5, output: 5 } }));

  const byModel = Object.fromEntries(queryStats(handle, { by: "model", days: null }).map((r) => [r.bucket, r]));
  assert.equal(byModel.m1.runs, 2);
  assert.equal(byModel.m1.input, 40);
  assert.equal(byModel.m2.input, 5);

  const byPreset = Object.fromEntries(queryStats(handle, { by: "preset", days: null }).map((r) => [r.bucket, r]));
  assert.equal(byPreset.deep.runs, 2);

  assert.throws(() => queryStats(handle, { by: "nonsense" }), /Unknown grouping/);

  handle.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the rate uses only generation windows, and percentiles come from durations", () => {
  const { handle, dir } = temporaryDatabase();

  // A run the proxy measured: 2000 generated tokens over 20s of generation.
  recordJob(
    handle,
    job({
      id: "measured",
      model: "m1",
      usage: { input: 10, output: 2000, cost: 0 },
      timing: { modelMs: 6000, toolMs: 30_000, spanMs: 36_000 },
      proxyStats: { count: 4, failed: 0, ttftP50Ms: 300, genMs: 20_000, genOutTokens: 2000 },
      startedAt: new Date(Date.now() - 36_000).toISOString()
    })
  );
  // Model time but no proxy telemetry — an unsandboxed run, or one from before
  // the measurement existed. Folding it in would mix two definitions of speed
  // in one column, which is worse than leaving a gap.
  recordJob(
    handle,
    job({
      id: "untimed",
      model: "m1",
      usage: { input: 10, output: 100_000, cost: 0 },
      timing: { modelMs: 1000, toolMs: 0, spanMs: 1000 }
    })
  );
  recordJob(handle, job({ id: "failed", model: "m1", status: "failed", usage: { input: 1, output: 1 } }));

  const [row] = queryStats(handle, { by: "model", days: null });
  assert.equal(row.runs, 3);
  assert.equal(row.completed, 2);
  assert.equal(row.failed, 1);
  assert.equal(Math.round(row.tokensPerSecond), 100, "2000 tokens over 20s of generation, untimed run excluded");
  assert.equal(row.outputPerRun, 2000, "the answer length the rate was measured on");
  assert.equal(row.p50Seconds, 12);
  assert.equal(row.p90Seconds, 36, "the slow run is what p90 is for");

  handle.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a short answer carries no rate at all", () => {
  const { handle, dir } = temporaryDatabase();

  // The tokens delivered in the first frame were generated before the window
  // opened, so a one-word answer would report an arbitrarily large rate.
  recordJob(
    handle,
    job({
      id: "one-word",
      model: "m2",
      usage: { input: 5000, output: 6, cost: 0 },
      proxyStats: { count: 1, failed: 0, ttftP50Ms: 90, genMs: 5, genOutTokens: 6 }
    })
  );

  const [row] = queryStats(handle, { by: "model", days: null });
  assert.equal(row.runs, 1);
  assert.equal(row.tokensPerSecond, null);
  assert.equal(row.outputPerRun, null);

  handle.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the models report only queries the journal when stats are asked for", async () => {
  const { renderModelsReport } = await import("../plugins/pi/scripts/lib/render.mjs");
  const catalogue = { models: [{ id: "m1" }], presets: {}, prompts: [], defaults: {} };

  assert.ok(!renderModelsReport(catalogue).includes("Measured here"), "no section without --stats");
  assert.ok(
    renderModelsReport({ ...catalogue, measured: [] }).includes("nothing to compare"),
    "an empty history says so instead of showing an empty table"
  );

  const report = renderModelsReport({
    ...catalogue,
    measured: [
      {
        bucket: "m1",
        runs: 4,
        completed: 3,
        avg_context: 812_431,
        max_context: 1_004_000,
        tokensPerSecond: 40.4,
        outputPerRun: 2400,
        p50Seconds: 12,
        p90Seconds: 300,
        turns: 8,
        counted_runs: 4,
        tool_calls: 10,
        tool_errors: 1,
        cost: 0
      }
    ]
  });
  assert.match(report, /\| `m1` \| 4 \| 75% \| 812K \| 1\.0M \| 40\.4 \| 2K \| 12s \| 5\.0m \| 2\.0 \| 10% \|/);
});
