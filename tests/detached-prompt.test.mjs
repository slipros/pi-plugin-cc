import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.PI_PLUGIN_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-detached-")), "jobs.db");

const { takeDetachedPrompt } = await import("../plugins/pi/scripts/pi-companion.mjs");
const state = await import("../plugins/pi/scripts/lib/state.mjs");

const PROMPT_ENV = "PI_PLUGIN_PROMPT_FILE";

function withWorkspace(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-detached-"));
  const workspaceRoot = path.join(dataDir, "repo");
  fs.mkdirSync(workspaceRoot);
  const previousData = process.env.CLAUDE_PLUGIN_DATA;
  const previousPrompt = process.env[PROMPT_ENV];
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    return run(workspaceRoot);
  } finally {
    restore("CLAUDE_PLUGIN_DATA", previousData);
    restore(PROMPT_ENV, previousPrompt);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function restore(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

test("a detached run is handed the task its parent assembled", () => {
  withWorkspace((workspaceRoot) => {
    // The regression this covers: a background start re-executes the command
    // line in a child whose stdin is closed, so a brief piped in with --stdin
    // reached nobody and the agent ran on the first line of the prompt alone.
    const brief = "Задача 11. Бриф ниже.\n\n" + "подробности задачи\n".repeat(50);
    const file = state.resolvePromptFile(workspaceRoot, "delegate-handoff");
    state.ensureStateDir(workspaceRoot);
    fs.writeFileSync(file, brief);
    process.env[PROMPT_ENV] = file;

    assert.equal(takeDetachedPrompt(), brief, "the child runs on the whole text, not on its first line");
    assert.equal(fs.existsSync(file), false, "the handoff file is consumed, not left holding a copy of the task");
    assert.equal(takeDetachedPrompt(), null, "a second read finds nothing rather than repeating the task");
  });
});

test("a foreground run resolves its own task, as before", () => {
  withWorkspace(() => {
    delete process.env[PROMPT_ENV];
    assert.equal(takeDetachedPrompt(), null);
  });
});

test("an unusable handoff falls back instead of running on an empty prompt", () => {
  withWorkspace((workspaceRoot) => {
    state.ensureStateDir(workspaceRoot);
    process.env[PROMPT_ENV] = state.resolvePromptFile(workspaceRoot, "never-written");
    assert.equal(takeDetachedPrompt(), null, "a missing file is not an empty task");

    const blank = state.resolvePromptFile(workspaceRoot, "blank");
    fs.writeFileSync(blank, "   \n\n");
    process.env[PROMPT_ENV] = blank;
    assert.equal(takeDetachedPrompt(), null, "whitespace is not a task either");
  });
});

test("job state outlives a reboot", () => {
  const previousData = process.env.CLAUDE_PLUGIN_DATA;
  const previousHome = process.env.XDG_DATA_HOME;
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-datahome-"));
  delete process.env.CLAUDE_PLUGIN_DATA;
  process.env.XDG_DATA_HOME = dataHome;
  try {
    // Transcripts and event streams used to sit in the temp directory, where a
    // reboot took them — and the run that has to be explained after the fact is
    // exactly the one whose log is gone.
    const configured = state.resolveStateDir("/some/workspace");
    assert.ok(
      configured.startsWith(path.join(dataHome, "pi-plugin", "state")),
      `state belongs under the data home, got ${configured}`
    );
    assert.ok(
      !configured.startsWith(path.join(os.tmpdir(), "pi-companion")),
      "and never back in the temp bucket a reboot clears"
    );

    delete process.env.XDG_DATA_HOME;
    assert.ok(
      state.resolveStateDir("/some/workspace").startsWith(
        path.join(os.homedir(), ".local", "share", "pi-plugin", "state")
      ),
      "with no data home configured it lands next to the journal"
    );
  } finally {
    restore("CLAUDE_PLUGIN_DATA", previousData);
    restore("XDG_DATA_HOME", previousHome);
    fs.rmSync(dataHome, { recursive: true, force: true });
  }
});

test("evicting a job clears the task text it was handed", () => {
  withWorkspace((workspaceRoot) => {
    state.writeJobFile(workspaceRoot, "gone", { id: "gone", status: "completed" });
    state.upsertJob(workspaceRoot, { id: "gone", status: "completed" });
    const file = state.resolvePromptFile(workspaceRoot, "gone");
    fs.writeFileSync(file, "the task text");

    state.updateState(workspaceRoot, (current) => {
      current.jobs = current.jobs.filter((job) => job.id !== "gone");
    });

    assert.equal(fs.existsSync(file), false, "a killed child must not leave the task behind forever");
  });
});
