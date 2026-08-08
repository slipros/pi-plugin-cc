import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeThinking,
  parseModelTable,
  resolveModelSelection
} from "../plugins/pi/scripts/lib/models.mjs";

const TABLE = `provider     model              context  max-out  thinking  images
opencode-go  glm-5.2            1M       131.1K   yes       no
opencode-go  kimi-k3            1.0M     131.1K   yes       yes
anthropic    claude-sonnet-5    1M       64K      yes       yes
`;

test("parseModelTable skips the header and keeps every column", () => {
  const models = parseModelTable(TABLE);
  assert.equal(models.length, 3);
  assert.deepEqual(models[0], {
    provider: "opencode-go",
    model: "glm-5.2",
    id: "opencode-go/glm-5.2",
    context: "1M",
    maxOutput: "131.1K",
    thinking: true,
    images: false
  });
  assert.equal(models[1].images, true);
});

test("parseModelTable tolerates empty output", () => {
  assert.deepEqual(parseModelTable(""), []);
  assert.deepEqual(parseModelTable(undefined), []);
});

test("normalizeThinking accepts known levels and rejects the rest", () => {
  assert.equal(normalizeThinking("HIGH"), "high");
  assert.equal(normalizeThinking(""), null);
  assert.equal(normalizeThinking(null), null);
  assert.throws(() => normalizeThinking("turbo"), /Unsupported thinking level/);
});

test("resolveModelSelection matches a fully qualified id", () => {
  const models = parseModelTable(TABLE);
  const selection = resolveModelSelection(models, { model: "opencode-go/kimi-k3" });
  assert.equal(selection.matched.id, "opencode-go/kimi-k3");
  assert.equal(selection.provider, "opencode-go");
  assert.equal(selection.warning, null);
});

test("resolveModelSelection matches a bare model id and keeps a thinking suffix", () => {
  const models = parseModelTable(TABLE);
  const selection = resolveModelSelection(models, { model: "claude-sonnet-5:high" });
  assert.equal(selection.matched.id, "anthropic/claude-sonnet-5");
  assert.equal(selection.model, "claude-sonnet-5:high");
  assert.equal(selection.provider, "anthropic");
});

test("resolveModelSelection warns for an unknown model but still passes it through", () => {
  const models = parseModelTable(TABLE);
  const selection = resolveModelSelection(models, { model: "gpt-9" });
  assert.equal(selection.model, "gpt-9");
  assert.equal(selection.matched, null);
  assert.match(selection.warning, /not in the local pi catalogue/);
});

test("resolveModelSelection reports ambiguity instead of guessing", () => {
  const models = parseModelTable(TABLE);
  const selection = resolveModelSelection(models, { model: "5" });
  assert.equal(selection.matched, null);
  assert.match(selection.warning, /matches \d+ catalogue entries/);
});

test("resolveModelSelection stays inert without a requested model", () => {
  const selection = resolveModelSelection(parseModelTable(TABLE), {});
  assert.deepEqual(selection, { model: null, provider: null, matched: null, warning: null });
});
