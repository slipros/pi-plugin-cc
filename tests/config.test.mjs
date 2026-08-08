import assert from "node:assert/strict";
import test from "node:test";

import { BUILT_IN_CONFIG, resolveRunSettings } from "../plugins/pi/scripts/lib/config.mjs";

const CONFIG = {
  ...BUILT_IN_CONFIG,
  defaults: { ...BUILT_IN_CONFIG.defaults, model: "default-model", thinking: "low" },
  presets: {
    deep: { model: "preset-model", thinking: "high", role: "fixer" },
    audit: { model: "audit-model", readOnly: true }
  },
  commands: {
    delegate: { preset: "deep" },
    review: { role: "reviewer", readOnly: true }
  }
};

test("command defaults pick up their configured preset", () => {
  const settings = resolveRunSettings(CONFIG, "delegate");
  assert.equal(settings.presetName, "deep");
  assert.equal(settings.model, "preset-model");
  assert.equal(settings.thinking, "high");
  assert.equal(settings.role, "fixer");
});

test("explicit flags beat the preset and the defaults", () => {
  const settings = resolveRunSettings(CONFIG, "delegate", { model: "flag-model", thinking: "max" });
  assert.equal(settings.model, "flag-model");
  assert.equal(settings.thinking, "max");
  assert.equal(settings.role, "fixer", "unspecified values still fall back to the preset");
});

test("global defaults apply when nothing else sets a value", () => {
  const settings = resolveRunSettings({ ...CONFIG, commands: { review: {} } }, "review");
  assert.equal(settings.model, "default-model");
  assert.equal(settings.thinking, "low");
  assert.equal(settings.readOnly, false);
});

test("review is read-only by configuration and --write can turn that off", () => {
  assert.equal(resolveRunSettings(CONFIG, "review").readOnly, true);
  assert.equal(resolveRunSettings(CONFIG, "review", { readOnly: false }).readOnly, false);
});

test("a preset can turn read-only on for a delegation", () => {
  const settings = resolveRunSettings(CONFIG, "delegate", { preset: "audit" });
  assert.equal(settings.readOnly, true);
  assert.equal(settings.model, "audit-model");
});

test("append-system-prompt values from every layer are concatenated", () => {
  const config = {
    ...CONFIG,
    presets: { deep: { ...CONFIG.presets.deep, appendSystemPrompt: ["from-preset"] } },
    commands: { delegate: { preset: "deep", appendSystemPrompt: ["from-command"] } }
  };
  const settings = resolveRunSettings(config, "delegate", { appendSystemPrompt: ["from-flag"] });
  assert.deepEqual(settings.appendSystemPrompt, ["from-command", "from-preset", "from-flag"]);
});

test("an unknown preset fails loudly and lists what exists", () => {
  assert.throws(() => resolveRunSettings(CONFIG, "delegate", { preset: "nope" }), /deep, audit/);
});

test("timeout falls back to the built-in default", () => {
  assert.equal(resolveRunSettings(CONFIG, "review").timeoutMs, BUILT_IN_CONFIG.defaults.timeoutMs);
  assert.equal(resolveRunSettings(CONFIG, "review", { timeoutMs: 5000 }).timeoutMs, 5000);
});
