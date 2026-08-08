import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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

function withWorkspace(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-jobs-"));
  const workspaceRoot = path.join(dataDir, "repo");
  fs.mkdirSync(workspaceRoot);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    return run(workspaceRoot);
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
