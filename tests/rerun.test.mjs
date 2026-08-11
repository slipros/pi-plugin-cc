import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.PI_PLUGIN_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-rerun-")), "jobs.db");

const { composeRerunPrompt } = await import("../plugins/pi/scripts/pi-companion.mjs");

test("repeating a run verbatim sends exactly what it was given", () => {
  assert.equal(composeRerunPrompt("fix the flaky test"), "fix the flaky test");
  assert.equal(composeRerunPrompt("fix the flaky test", {}), "fix the flaky test");
});

test("an addition is a separate instruction, not a continuation of the last sentence", () => {
  assert.equal(
    composeRerunPrompt("fix the flaky test", { append: ["do not touch the migrations"] }),
    "fix the flaky test\n\ndo not touch the migrations"
  );
  assert.equal(
    composeRerunPrompt("task", { append: ["first", "second"] }),
    "task\n\nfirst\n\nsecond",
    "several --append flags stack in the order they were given"
  );
});

test("a replacement keeps the settings and drops the recorded text", () => {
  // The point of the flag: same preset, model and ceilings, different task.
  assert.equal(composeRerunPrompt("the old task", { replacement: "a different task" }), "a different task");
  assert.equal(
    composeRerunPrompt("the old task", { replacement: "a different task", append: ["and be brief"] }),
    "a different task\n\nand be brief"
  );
});

test("a run whose text has aged out can still be repeated with a supplied one", () => {
  // Retention clears the prompt but keeps the settings, so this is the case
  // where a replacement is the only way to run it again at all.
  assert.equal(composeRerunPrompt(null, { replacement: "the task, typed again" }), "the task, typed again");
  assert.equal(composeRerunPrompt(null, { append: ["only an addition"] }), "only an addition");
});

test("nothing recorded and nothing supplied is refused, not sent as an empty prompt", () => {
  assert.equal(composeRerunPrompt(null), null);
  assert.equal(composeRerunPrompt("   ", { append: ["  "] }), null);
});
