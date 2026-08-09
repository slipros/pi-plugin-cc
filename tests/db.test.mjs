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
