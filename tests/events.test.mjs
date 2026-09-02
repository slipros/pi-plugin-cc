import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.PI_PLUGIN_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-events-")), "jobs.db");

import { recordFleetEvent } from "../plugins/pi/scripts/lib/fleet-events.mjs";
import { upsertJob, writeJobFile } from "../plugins/pi/scripts/lib/state.mjs";

const COMPANION = fileURLToPath(new URL("../plugins/pi/scripts/pi-companion.mjs", import.meta.url));

function withWorkspace(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-events-"));
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

/** The async twin: the sync one tears the workspace down before a promise settles. */
async function withWorkspaceAsync(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-events-"));
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

function runEvents(workspaceRoot, args, dataDir) {
  return spawnSync(process.execPath, [COMPANION, "events", ...args], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, PI_PLUGIN_DB: process.env.PI_PLUGIN_DB }
  });
}

/** Follow in a child while the test writes to the log the child is watching. */
function followEvents(workspaceRoot, args, dataDir, duringRun) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [COMPANION, "events", "--follow", ...args], {
      cwd: workspaceRoot,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, PI_PLUGIN_DB: process.env.PI_PLUGIN_DB }
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code }));
    setTimeout(() => {
      try {
        duringRun();
      } catch (error) {
        reject(error);
      }
    }, 400);
  });
}

test("an empty log says so rather than printing nothing", () => {
  withWorkspace((workspaceRoot, dataDir) => {
    const result = runEvents(workspaceRoot, [], dataDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No finished pi runs recorded yet/);
  });
});

test("the tail is the recent history, newest last", () => {
  withWorkspace((workspaceRoot, dataDir) => {
    recordFleetEvent({ id: "delegate-1", status: "completed", workspaceRoot });
    recordFleetEvent({ id: "delegate-2", status: "failed", workspaceRoot });
    recordFleetEvent({ id: "delegate-3", status: "completed", workspaceRoot });

    const lines = runEvents(workspaceRoot, ["--tail", "2"], dataDir).stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /delegate-2/);
    assert.match(lines[1], /delegate-3/);
  });
});

test("--workspace narrows the fleet to this checkout", () => {
  withWorkspace((workspaceRoot, dataDir) => {
    recordFleetEvent({ id: "delegate-here", status: "completed", workspaceRoot });
    recordFleetEvent({ id: "delegate-elsewhere", status: "completed", workspaceRoot: "/other/repo" });

    const mine = runEvents(workspaceRoot, ["--workspace"], dataDir).stdout;
    assert.match(mine, /delegate-here/);
    assert.ok(!mine.includes("delegate-elsewhere"), "another workspace's run leaked in");

    const all = runEvents(workspaceRoot, [], dataDir).stdout;
    assert.match(all, /delegate-elsewhere/);
  });
});

test("following reports an ending that happens while it watches", async () => {
  await withWorkspaceAsync(async (workspaceRoot, dataDir) => {
    const { stdout, code } = await followEvents(workspaceRoot, ["--for", "3", "--poll", "1"], dataDir, () => {
      recordFleetEvent({ id: "delegate-late", status: "completed", elapsed: "2m", workspaceRoot });
    });

    assert.equal(code, 0);
    assert.match(stdout, /pi fleet channel armed/);
    assert.match(stdout, /delegate-late/);
    assert.match(stdout, /✅/);
  });
});

test("following reports a run whose process died, which announces nothing itself", async () => {
  await withWorkspaceAsync(async (workspaceRoot, dataDir) => {
    const { stdout } = await followEvents(workspaceRoot, ["--for", "3", "--poll", "1"], dataDir, () => {
      // A pid that cannot be alive: this is the ending no in-process hook can
      // report, and the only one a sweep exists for.
      const job = {
        id: "delegate-killed",
        kind: "delegate",
        title: "killed mid-run",
        workspaceRoot,
        status: "running",
        pid: 0x7ffffff0,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString()
      };
      writeJobFile(workspaceRoot, job.id, job);
      upsertJob(workspaceRoot, job);
    });

    assert.match(stdout, /delegate-killed/);
    assert.match(stdout, /orphaned/);
  });
});

test("the same ending is not reported twice", async () => {
  await withWorkspaceAsync(async (workspaceRoot, dataDir) => {
    const { stdout } = await followEvents(workspaceRoot, ["--for", "3", "--poll", "1"], dataDir, () => {
      const job = {
        id: "delegate-killed",
        kind: "delegate",
        workspaceRoot,
        status: "running",
        pid: 0x7ffffff0,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString()
      };
      writeJobFile(workspaceRoot, job.id, job);
      upsertJob(workspaceRoot, job);
    });

    const mentions = stdout.split("\n").filter((line) => line.includes("delegate-killed"));
    assert.equal(mentions.length, 1, `reported ${mentions.length} times:\n${stdout}`);
  });
});
