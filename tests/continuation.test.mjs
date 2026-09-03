import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.PI_PLUGIN_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-continue-")), "jobs.db");

const { continuationFlags, rerunRecipe } = await import("../plugins/pi/scripts/pi-companion.mjs");

const SETTINGS = { presetName: "go-developer", model: "glm", thinking: "high", timeoutMs: 3_600_000 };

test("the recipe records the equipment the caller asked for", () => {
  const recipe = rerunRecipe(SETTINGS, {
    mount: ["~/docs/epic:/epic"],
    "system-prompt": "developer",
    "exclude-tools": "ask_question",
    skill: ["/pi-skills/git-commit"]
  });
  assert.deepEqual(recipe.mounts, ["~/docs/epic:/epic"]);
  assert.equal(recipe.systemPrompt, "developer");
  assert.equal(recipe.excludeTools, "ask_question");
  assert.deepEqual(recipe.skills, ["/pi-skills/git-commit"]);
  assert.equal(recipe.preset, "go-developer");
});

test("equipment nobody asked for is not recorded as empty", () => {
  const recipe = rerunRecipe(SETTINGS, {});
  assert.ok(!("mounts" in recipe), "an empty --mount list would override a preset with nothing");
  assert.ok(!("skills" in recipe));
  assert.ok(!("systemPrompt" in recipe));
});

test("a continuation inherits the mounts of the run that owns the session", () => {
  // The defect this stands on: the report was written into /epic, which the
  // continuation did not mount, and it died with the container.
  const merged = continuationFlags({}, rerunRecipe(SETTINGS, { mount: ["~/docs/epic:/epic"] }));
  assert.deepEqual(merged.mount, ["~/docs/epic:/epic"]);
  assert.equal(merged.preset, "go-developer");
});

test("a continuation keeps the agent it was given, prompt and tools included", () => {
  const recipe = rerunRecipe(SETTINGS, {
    "system-prompt": "reviewer",
    "append-system-prompt": ["## Go"],
    tools: "read,grep",
    "git-name": "pi agent",
    "git-email": "pi@example.dev"
  });
  const merged = continuationFlags({}, recipe);
  assert.equal(merged["system-prompt"], "reviewer");
  assert.deepEqual(merged["append-system-prompt"], ["## Go"]);
  assert.equal(merged.tools, "read,grep");
  assert.equal(merged["git-name"], "pi agent");
  assert.equal(merged["git-email"], "pi@example.dev");
});

test("a flag on the continuation outranks the recorded contour", () => {
  const recipe = rerunRecipe(SETTINGS, { mount: ["~/a:/a"], "system-prompt": "developer" });
  const merged = continuationFlags({ mount: ["~/b:/b"], "system-prompt": "reviewer", model: "other" }, recipe);
  assert.deepEqual(merged.mount, ["~/b:/b"]);
  assert.equal(merged["system-prompt"], "reviewer");
  assert.equal(merged.model, "other");
});

test("the recorded timeout comes back as seconds, and --timeout still wins", () => {
  assert.equal(continuationFlags({}, rerunRecipe(SETTINGS, {})).timeout, "3600");
  assert.equal(continuationFlags({ timeout: "600" }, rerunRecipe(SETTINGS, {})).timeout, "600");
});
