import assert from "node:assert/strict";
import test from "node:test";

import { budgetExceeded, describeBudget, normalizeBudget, totalTokensOf } from "../plugins/pi/scripts/lib/budget.mjs";
import { resolveRunSettings } from "../plugins/pi/scripts/lib/config.mjs";

test("a run without ceilings costs nothing to check", () => {
  assert.equal(normalizeBudget(null), null);
  assert.equal(normalizeBudget({}), null);
  // Every field absent means the same as no budget at all, so the hot path can
  // skip the comparison entirely rather than comparing against nulls.
  assert.equal(normalizeBudget({ maxCostUsd: null, maxTokens: null }), null);
  assert.equal(budgetExceeded(null, { usage: { cost: 1000 }, turns: 1000 }), null);
});

test("a ceiling that cannot be met is refused instead of silently ignored", () => {
  // `0` reads as "allow nothing", which can only be a mistake, and treating it
  // as "unlimited" would be the opposite of what it says.
  assert.throws(() => normalizeBudget({ maxTurns: 0 }), /positive number/);
  assert.throws(() => normalizeBudget({ maxCostUsd: -1 }), /positive number/);
  assert.throws(() => normalizeBudget({ maxTokens: "many" }), /positive number/);
});

test("each ceiling stops the run on its own dimension", () => {
  const budget = normalizeBudget({ maxCostUsd: 0.5, maxTokens: 1000, maxTurns: 3 });

  assert.equal(budgetExceeded(budget, { usage: { cost: 0.5 }, turns: 3 }), null, "the limit itself is still allowed");
  assert.match(budgetExceeded(budget, { usage: { cost: 0.51 }, turns: 1 }), /cost \$0\.5100 passed/);
  assert.match(budgetExceeded(budget, { usage: { input: 900, output: 200 }, turns: 1 }), /1100 tokens passed/);
  assert.match(budgetExceeded(budget, { usage: {}, turns: 4 }), /4 turns passed/);
});

test("cached tokens count against the token ceiling", () => {
  // They are billed and they fill the context; a budget that ignored them would
  // be wrong by an order of magnitude on a long run — cache reads are the bulk
  // of the traffic here.
  assert.equal(totalTokensOf({ input: 10, output: 20, cacheRead: 300, cacheWrite: 40 }), 370);
  assert.equal(totalTokensOf(null), 0);
});

test("a preset carries the budget and a flag caps another dimension without erasing it", () => {
  const config = {
    defaults: {},
    presets: { agent: { model: "m", budget: { maxCostUsd: 2 } } },
    commands: {},
    sandboxProfiles: {}
  };

  const fromPreset = resolveRunSettings(config, "delegate", { preset: "agent" });
  assert.deepEqual(fromPreset.budget, { maxCostUsd: 2, maxTokens: null, maxTurns: null });

  const withFlag = resolveRunSettings(config, "delegate", { preset: "agent", budget: { maxTurns: 5 } });
  assert.deepEqual(
    withFlag.budget,
    { maxCostUsd: 2, maxTokens: null, maxTurns: 5 },
    "--max-turns caps turns; the preset's cost ceiling is still in force"
  );
});

test("the budget is described for the report", () => {
  assert.equal(describeBudget(normalizeBudget({ maxCostUsd: 1.5, maxTurns: 10 })), "$1.5 · 10 turns");
  assert.equal(describeBudget(null), null);
});
