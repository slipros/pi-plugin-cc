import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { attachJsonlReader, parseJsonLine } from "../plugins/pi/scripts/lib/jsonl.mjs";

// `end` fires on a later tick than `data`, so collection has to await it.
function collect(chunks) {
  const stream = new PassThrough();
  const lines = [];
  attachJsonlReader(stream, (line) => lines.push(line));
  return new Promise((resolve) => {
    stream.on("end", () => resolve(lines));
    for (const chunk of chunks) {
      stream.write(chunk);
    }
    stream.end();
  });
}

test("records split across chunk boundaries are reassembled", async () => {
  assert.deepEqual(await collect(['{"type":"a"}\n{"ty', 'pe":"b"}\n']), ['{"type":"a"}', '{"type":"b"}']);
});

test("a trailing record without a newline is still emitted", async () => {
  assert.deepEqual(await collect(['{"type":"a"}']), ['{"type":"a"}']);
});

test("CRLF input is accepted", async () => {
  assert.deepEqual(await collect(['{"type":"a"}\r\n']), ['{"type":"a"}']);
});

test("U+2028 inside a JSON string does not split the record", async () => {
  // readline would break this record in two; the reader must split on LF only.
  const payload = JSON.stringify({ text: "before\u2028after" });
  assert.ok(payload.includes("\u2028"), "the separator must survive stringify");

  const lines = await collect([`${payload}\n`]);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).text, "before\u2028after");
});

test("multi-byte characters split across chunks survive", async () => {
  const buffer = Buffer.from('{"text":"д"}\n', "utf8");
  assert.deepEqual(await collect([buffer.subarray(0, 10), buffer.subarray(10)]), ['{"text":"д"}']);
});

test("blank lines are skipped", async () => {
  assert.deepEqual(await collect(["\n\n{\"a\":1}\n\n"]), ['{"a":1}']);
});

test("parseJsonLine returns null for malformed input", () => {
  assert.deepEqual(parseJsonLine('{"a":1}'), { a: 1 });
  assert.equal(parseJsonLine("not json"), null);
});
