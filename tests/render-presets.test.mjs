import assert from "node:assert/strict";
import test from "node:test";

import { renderModelsReport } from "../plugins/pi/scripts/lib/render.mjs";

const MODELS = [{ id: "some/model", context: 128000, maxOutput: 8192, thinking: true, images: false }];

function report(presets) {
  return renderModelsReport({ models: MODELS, presets, prompts: [], defaults: {}, search: null });
}

test("preset description leads its line, so choosing does not require opening a system prompt", () => {
  const out = report({
    qa: {
      description: "проверяет готовую работу, пишет только тестовый код",
      model: "some/model",
      systemPrompt: "qa-prompt"
    }
  });

  const line = out.split("\n").find((l) => l.startsWith("- `qa`"));
  assert.ok(line, "preset line is rendered");
  assert.match(line, /^- `qa` — проверяет готовую работу, пишет только тестовый код/);
  // Технические подробности остаются, но после описания — они уточняют выбор,
  // а не заменяют его.
  assert.match(line, /model `some\/model`/);
  assert.match(line, /prompt `qa-prompt`/);
});

test("preset without description keeps the previous shape", () => {
  const out = report({ plain: { model: "some/model" } });

  const line = out.split("\n").find((l) => l.startsWith("- `plain`"));
  assert.equal(line, "- `plain` — model `some/model`");
});

test("preset with neither description nor overrides still renders", () => {
  const out = report({ bare: {} });

  const line = out.split("\n").find((l) => l.startsWith("- `bare`"));
  assert.equal(line, "- `bare` — no overrides");
});
