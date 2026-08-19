import assert from "node:assert/strict";
import test from "node:test";

import { isTruncationReason } from "../plugins/pi/scripts/lib/finish-reason.mjs";

// Один словарь на четыре модуля: прокси, телеметрию, прогон и запись джоба.
// Пока каждый сравнивал причину со строкой "length" сам, восстановление и
// фаза truncated молча не работали ни для одного не-OpenAI провайдера.
test("the ceiling is recognised in the spellings providers actually use", () => {
  assert.equal(isTruncationReason("length"), true, "OpenAI");
  assert.equal(isTruncationReason("max_tokens"), true, "Anthropic");
  assert.equal(isTruncationReason("MAX_TOKENS"), true, "Google");
  assert.equal(isTruncationReason("max_output_tokens"), true);
  assert.equal(isTruncationReason("  Length  "), true, "пробелы и регистр — не смысл");
});

test("anything else is a normal ending", () => {
  for (const reason of ["stop", "tool_calls", "content_filter", "end_turn", "", null, undefined, 0, {}]) {
    assert.equal(isTruncationReason(reason), false, `${JSON.stringify(reason)} — не обрыв на потолке`);
  }
});
