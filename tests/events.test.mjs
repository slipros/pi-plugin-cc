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

function runEvents(workspaceRoot, args, dataDir, session = null) {
  return spawnSync(process.execPath, [COMPANION, "events", ...args], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: sessionEnv(dataDir, session)
  });
}

/**
 * The environment a supervisor's shell has.
 *
 * The session id is what separates two supervisors sharing one machine-wide
 * log, so a test about that separation has to set it explicitly — and clear the
 * override, or the id of whatever session is running the suite leaks in.
 */
function sessionEnv(dataDir, session) {
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: dataDir,
    PI_PLUGIN_DB: process.env.PI_PLUGIN_DB
  };
  delete env.PI_COMPANION_SESSION_ID;
  if (session) {
    env.CLAUDE_CODE_SESSION_ID = session;
  } else {
    delete env.CLAUDE_CODE_SESSION_ID;
  }
  return env;
}

/** Follow in a child while the test writes to the log the child is watching. */
function followEvents(workspaceRoot, args, dataDir, duringRun, session = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [COMPANION, "events", "--follow", ...args], {
      cwd: workspaceRoot,
      env: sessionEnv(dataDir, session)
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

test("one supervisor does not hear another supervisor's runs", () => {
  withWorkspace((workspaceRoot, dataDir) => {
    recordFleetEvent({ id: "delegate-mine", status: "completed", workspaceRoot, claudeSessionId: "sess-alpha" });
    recordFleetEvent({ id: "delegate-theirs", status: "completed", workspaceRoot, claudeSessionId: "sess-beta" });
    recordFleetEvent({ id: "delegate-nobodys", status: "completed", workspaceRoot });

    const alpha = runEvents(workspaceRoot, [], dataDir, "sess-alpha").stdout;
    assert.match(alpha, /delegate-mine/);
    assert.match(alpha, /delegate-nobodys/, "a run nobody owns is announced to everybody");
    assert.ok(!alpha.includes("delegate-theirs"), "another session's run leaked into the channel");

    const everything = runEvents(workspaceRoot, ["--all"], dataDir, "sess-alpha").stdout;
    assert.match(everything, /delegate-theirs/);
    assert.match(everything, /session: sess/, "--all labels whose run each ending was");

    const adopted = runEvents(workspaceRoot, ["--owner", "sess-beta"], dataDir, "sess-alpha").stdout;
    assert.match(adopted, /delegate-theirs/, "a resumed session can adopt the runs it started before");
    assert.ok(!adopted.includes("delegate-mine"));
  });
});

test("a session with runs only from others is told they exist rather than shown an empty log", () => {
  withWorkspace((workspaceRoot, dataDir) => {
    recordFleetEvent({ id: "delegate-theirs", status: "completed", workspaceRoot, claudeSessionId: "sess-beta" });

    const alpha = runEvents(workspaceRoot, [], dataDir, "sess-alpha").stdout;
    assert.match(alpha, /No finished pi runs started by this session/);
    assert.match(alpha, /--all/);
  });
});

test("following hands each supervisor only its own endings", async () => {
  await withWorkspaceAsync(async (workspaceRoot, dataDir) => {
    const { stdout } = await followEvents(
      workspaceRoot,
      ["--for", "3", "--poll", "1"],
      dataDir,
      () => {
        recordFleetEvent({ id: "delegate-theirs", status: "completed", workspaceRoot, claudeSessionId: "sess-beta" });
        recordFleetEvent({ id: "delegate-mine", status: "completed", workspaceRoot, claudeSessionId: "sess-alpha" });
      },
      "sess-alpha"
    );

    assert.match(stdout, /runs started by session sess/, "the armed line says what the channel is narrowed to");
    assert.match(stdout, /delegate-mine/);
    assert.ok(!stdout.includes("delegate-theirs"), "another session's ending woke this supervisor");
  });
});
