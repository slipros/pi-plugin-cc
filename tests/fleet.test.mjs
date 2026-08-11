import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.PI_PLUGIN_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-fleet-")), "jobs.db");

import { buildStatusSnapshot, filterJobs, isCancelable, listCancelableJobs } from "../plugins/pi/scripts/lib/jobs.mjs";
import { listJobsEverywhere, upsertJob, writeJobFile } from "../plugins/pi/scripts/lib/state.mjs";

/**
 * Two workspaces under one data directory: the whole point of the fleet view is
 * that state is bucketed per workspace and no command could see across buckets.
 */
function withWorkspaces(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-fleet-"));
  const alpha = path.join(dataDir, "alpha");
  const beta = path.join(dataDir, "beta");
  fs.mkdirSync(alpha);
  fs.mkdirSync(beta);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    return run(alpha, beta);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function record(workspaceRoot, job) {
  const full = { workspaceRoot, createdAt: new Date().toISOString(), ...job };
  writeJobFile(workspaceRoot, full.id, full);
  upsertJob(workspaceRoot, full);
  return full;
}

test("the fleet view finds jobs started from another workspace", () => {
  withWorkspaces((alpha, beta) => {
    record(alpha, { id: "delegate-a", kind: "delegate", status: "running", pid: process.pid, preset: "agent" });
    record(beta, { id: "delegate-b", kind: "delegate", status: "completed", preset: "reviewer" });

    const local = buildStatusSnapshot(alpha, {});
    assert.deepEqual(local.jobs.map((job) => job.id), ["delegate-a"], "a per-workspace status stays per workspace");

    const everywhere = buildStatusSnapshot(alpha, { global: true });
    assert.deepEqual(everywhere.jobs.map((job) => job.id).sort(), ["delegate-a", "delegate-b"]);
    assert.equal(everywhere.global, true);
    assert.equal(listJobsEverywhere().length, 2);
  });
});

test("filters narrow the list by status, preset and model", () => {
  const jobs = [
    { id: "1", status: "running", preset: "agent", model: "ollama-pro/glm-5.2" },
    { id: "2", status: "completed", preset: "agent", model: "ollama-pro/glm-5.2" },
    { id: "3", status: "running", preset: "reviewer", model: "anthropic/opus-5" }
  ];

  assert.deepEqual(filterJobs(jobs, { status: "running" }).map((job) => job.id), ["1", "3"]);
  assert.deepEqual(filterJobs(jobs, { status: "running,completed" }).map((job) => job.id), ["1", "2", "3"]);
  assert.deepEqual(filterJobs(jobs, { preset: "reviewer" }).map((job) => job.id), ["3"]);
  // Substring on purpose: a model is stored as `provider/model` and filtering
  // by the model alone is what anyone actually types.
  assert.deepEqual(filterJobs(jobs, { model: "glm-5.2" }).map((job) => job.id), ["1", "2"]);
  assert.deepEqual(filterJobs(jobs, {}).length, 3);
});

test("a pending or orphaned job is cancelable, not just a running one", () => {
  // A pending run's container may already be up, and an orphaned one's
  // certainly is; treating only `running` as cancelable left both holding a
  // slot of the concurrency pool with no way to stop them.
  assert.equal(isCancelable({ status: "pending" }), true);
  assert.equal(isCancelable({ status: "orphaned" }), true);
  assert.equal(isCancelable({ status: "running" }), true);
  assert.equal(isCancelable({ status: "completed" }), false);
  assert.equal(isCancelable({ status: "cancelled" }), false);
});

test("cancel --all collects the live jobs of one workspace or of all of them", () => {
  withWorkspaces((alpha, beta) => {
    record(alpha, { id: "delegate-live", kind: "delegate", status: "running", pid: process.pid });
    record(alpha, { id: "delegate-old", kind: "delegate", status: "completed" });
    record(beta, { id: "delegate-pending", kind: "delegate", status: "pending", pid: process.pid });

    assert.deepEqual(listCancelableJobs(alpha).map((job) => job.id), ["delegate-live"]);
    assert.deepEqual(
      listCancelableJobs(alpha, { global: true }).map((job) => job.id).sort(),
      ["delegate-live", "delegate-pending"]
    );
  });
});
