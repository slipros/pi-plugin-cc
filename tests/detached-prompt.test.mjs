import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.PI_PLUGIN_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-detached-")), "jobs.db");

const { takeDetachedPrompt } = await import("../plugins/pi/scripts/pi-companion.mjs");
const state = await import("../plugins/pi/scripts/lib/state.mjs");

const PROMPT_ENV = "PI_PLUGIN_PROMPT_FILE";
const CHARS_ENV = "PI_PLUGIN_PROMPT_CHARS";
const COMPANION = fileURLToPath(new URL("../plugins/pi/scripts/pi-companion.mjs", import.meta.url));

function withWorkspace(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-detached-"));
  const workspaceRoot = path.join(dataDir, "repo");
  fs.mkdirSync(workspaceRoot);
  const previousData = process.env.CLAUDE_PLUGIN_DATA;
  const previousPrompt = process.env[PROMPT_ENV];
  const previousChars = process.env[CHARS_ENV];
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    return run(workspaceRoot);
  } finally {
    restore("CLAUDE_PLUGIN_DATA", previousData);
    restore(PROMPT_ENV, previousPrompt);
    restore(CHARS_ENV, previousChars);
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

test("an unusable handoff stops the run instead of starting it on the title alone", () => {
  withWorkspace((workspaceRoot) => {
    // Falling back to the command line is what let a brief go missing quietly:
    // with --stdin the command line carries only the title, and the agent ran,
    // billed, and reported that it had no task.
    state.ensureStateDir(workspaceRoot);
    process.env[PROMPT_ENV] = state.resolvePromptFile(workspaceRoot, "never-written");
    assert.throws(() => takeDetachedPrompt(), /handoff lost.*could not be read/i, "a missing file is a lost task");

    const blank = state.resolvePromptFile(workspaceRoot, "blank");
    fs.writeFileSync(blank, "   \n\n");
    process.env[PROMPT_ENV] = blank;
    assert.throws(() => takeDetachedPrompt(), /handoff lost.*no task text/i, "whitespace is not a task either");
  });
});

test("a handoff shorter than what the parent wrote is refused", () => {
  withWorkspace((workspaceRoot) => {
    state.ensureStateDir(workspaceRoot);
    const file = state.resolvePromptFile(workspaceRoot, "cut");
    fs.writeFileSync(file, "Задача B18f — текст ниже.");
    process.env[PROMPT_ENV] = file;
    process.env[CHARS_ENV] = "4170";
    assert.throws(() => takeDetachedPrompt(), /holds 25 characters, the parent wrote 4170/);
  });
});

test("the handoff is not inherited by what the detached run starts", () => {
  withWorkspace((workspaceRoot) => {
    state.ensureStateDir(workspaceRoot);
    const brief = "Задача 12.\n\nподробности";
    const file = state.resolvePromptFile(workspaceRoot, "inherited");
    fs.writeFileSync(file, brief);
    process.env[PROMPT_ENV] = file;
    process.env[CHARS_ENV] = String(brief.length);

    assert.equal(takeDetachedPrompt(), brief);
    // An agent running `pia` inside the run would see these and look for a file
    // that was already consumed — and now that is an error, not a no-op.
    assert.equal(process.env[PROMPT_ENV], undefined);
    assert.equal(process.env[CHARS_ENV], undefined);
  });
});

for (const [command, args] of [
  ["delegate", ["delegate", "--stdin", "Задача B24 — текст ниже."]],
  ["continue", ["continue", "--stdin", "Дозаход по задаче — текст ниже."]],
  ["rerun", ["rerun", "delegate-nonexistent", "--stdin"]]
]) {
  test(`${command} --stdin with nothing piped in refuses to start`, () => {
    // The shape that lost two reviews: `cat <path of a finished session> | pia
    // delegate --stdin "title"` — cat fails, stdin is empty, and the title
    // alone used to become the task.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-stdin-"));
    try {
      const result = spawnSync(process.execPath, [COMPANION, ...args], {
        cwd: dataDir,
        input: "",
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_PLUGIN_DATA: dataDir,
          PI_PLUGIN_DB: path.join(dataDir, "jobs.db"),
          [PROMPT_ENV]: "",
          [CHARS_ENV]: ""
        }
      });
      assert.equal(result.status, 1, `exit code; stderr: ${result.stderr}`);
      assert.match(result.stderr, /--stdin was given, but stdin was empty/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

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
