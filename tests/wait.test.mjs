import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.PI_PLUGIN_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-wait-")), "jobs.db");

import { upsertJob, writeJobFile } from "../plugins/pi/scripts/lib/state.mjs";

const COMPANION = fileURLToPath(new URL("../plugins/pi/scripts/pi-companion.mjs", import.meta.url));

/**
 * The command is exercised through the CLI rather than by importing it: the
 * workspace it waits on is the process's own working directory, which is the
 * part worth covering.
 */
function runWait(workspaceRoot, args, dataDir) {
  return spawnSync(process.execPath, [COMPANION, "wait", ...args], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, PI_PLUGIN_DB: process.env.PI_PLUGIN_DB }
  });
}

function withWorkspace(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-wait-"));
  const workspaceRoot = path.join(dataDir, "repo");
  fs.mkdirSync(workspaceRoot);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    return run(workspaceRoot, dataDir);
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
  writeJobFile(workspaceRoot, job.id, job);
  upsertJob(workspaceRoot, job);
}

test("waiting on a job that has already finished returns at once", () => {
  withWorkspace((workspaceRoot, dataDir) => {
    record(workspaceRoot, {
      id: "delegate-done",
      kind: "delegate",
      title: "already over",
      workspaceRoot,
      status: "completed",
      summary: "the answer",
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    });

    const result = runWait(workspaceRoot, ["delegate-done", "--for", "5"], dataDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pi wait — done/);
    assert.match(result.stdout, /the answer/);
  });
});

test("a job still running is reported as such instead of blocking forever", () => {
  withWorkspace((workspaceRoot, dataDir) => {
    record(workspaceRoot, {
      id: "delegate-live",
      kind: "delegate",
      title: "long one",
      workspaceRoot,
      status: "running",
      // Pretend the wrapper is this test process, so the job is not reclassified
      // as orphaned before the command gets to look at it.
      pid: process.pid,
      createdAt: new Date().toISOString()
    });

    const started = Date.now();
    const result = runWait(workspaceRoot, ["delegate-live", "--for", "1"], dataDir);

    assert.equal(result.status, 1, "an unfinished wait is not a success");
    assert.match(result.stdout, /still running after 1s/);
    assert.ok(Date.now() - started >= 1000, "the command returned before its own deadline");
  });
});

test("a failed job makes the wait fail, so a caller can branch on it", () => {
  withWorkspace((workspaceRoot, dataDir) => {
    record(workspaceRoot, {
      id: "delegate-bad",
      kind: "delegate",
      title: "broken",
      workspaceRoot,
      status: "failed",
      errorMessage: "pi produced no assistant output.",
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    });

    const result = runWait(workspaceRoot, ["delegate-bad"], dataDir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /pi produced no assistant output/);
  });
});

test("an unknown job id is refused rather than waited on", () => {
  // `--for` bounds the appearance grace as well: without it this would sit out
  // the full grace period before refusing.
  withWorkspace((workspaceRoot, dataDir) => {
    record(workspaceRoot, {
      id: "delegate-known",
      kind: "delegate",
      workspaceRoot,
      status: "completed",
      createdAt: new Date().toISOString()
    });

    const result = runWait(workspaceRoot, ["delegate-missing", "--for", "2"], dataDir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No pi job matches/);
  });
});

/** Async twin of `withWorkspace`: the sync one tears down before a promise settles. */
async function withWorkspaceAsync(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-wait-"));
  const workspaceRoot = path.join(dataDir, "repo");
  fs.mkdirSync(workspaceRoot);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    return await run(workspaceRoot, dataDir);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("a job id that has not reached the journal yet is waited for, not refused", async () => {
  // The bucket already holds history, which is the case the appearance grace
  // used to miss: keyed on an empty journal, a wait fired straight after
  // `delegate --background` in a lived-in workspace exited non-zero within a
  // second — a supervisor reading only the notification takes that for a
  // finished wave.
  await withWorkspaceAsync(async (workspaceRoot, dataDir) => {
    const { spawn } = await import("node:child_process");
    record(workspaceRoot, {
      id: "delegate-older",
      kind: "delegate",
      title: "yesterday",
      workspaceRoot,
      status: "completed",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      completedAt: new Date(Date.now() - 60_000).toISOString()
    });

    const child = spawn(process.execPath, [COMPANION, "wait", "delegate-newborn", "--for", "20"], {
      cwd: workspaceRoot,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, PI_PLUGIN_DB: process.env.PI_PLUGIN_DB }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    setTimeout(() => {
      record(workspaceRoot, {
        id: "delegate-newborn",
        kind: "delegate",
        title: "just started",
        workspaceRoot,
        status: "completed",
        summary: "done",
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      });
    }, 800);

    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, `stderr: ${stderr}`);
    assert.match(stdout, /delegate-newborn/);
    assert.ok(!stderr.includes("No pi job matches"), `refused instead of waiting: ${stderr}`);
  });
});
