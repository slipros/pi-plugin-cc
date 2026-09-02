import assert from "node:assert/strict";
import test from "node:test";

import { formatAgentWork, formatToolProfile } from "../plugins/pi/scripts/lib/render.mjs";

test("a run that touched nothing gets no line at all", () => {
  assert.equal(formatAgentWork(null), null);
  assert.equal(formatAgentWork({ linesRead: 0, linesWritten: 0, linesReplaced: 0 }), null);
  assert.equal(formatToolProfile(null), null);
  assert.equal(formatToolProfile({ toolCalls: 0 }), null);
});

test("the file line carries both halves of the work", () => {
  const line = formatAgentWork({
    linesRead: 412,
    linesWritten: 87,
    linesReplaced: 31,
    filesRead: 9,
    filesWritten: 4,
    rereads: 2
  });
  assert.match(line, /read 412 line\(s\) in 9 file\(s\)/);
  assert.match(line, /wrote 87 \(replacing 31\) in 4 file\(s\)/);
  assert.match(line, /2 re-read/);
});

test("a clean run is not padded with zeroes", () => {
  const line = formatToolProfile({
    toolCalls: 12,
    shellCalls: 0,
    editErrors: 0,
    readErrors: 0,
    shellErrors: 0,
    firstEditMs: null,
    repeatCallRun: 1
  });
  assert.equal(line, "12 tool call(s)");
});

test("a troubled run says what went wrong", () => {
  const line = formatToolProfile({
    toolCalls: 20,
    shellCalls: 10,
    editErrors: 3,
    readErrors: 1,
    shellErrors: 2,
    firstEditMs: 42_000,
    repeatCallRun: 4
  });
  assert.match(line, /50% shell/);
  assert.match(line, /3 edit\(s\) matched nothing/);
  assert.match(line, /1 read\(s\) missed/);
  assert.match(line, /2 command\(s\) failed/);
  assert.match(line, /first edit after 42s/);
  assert.match(line, /4 identical calls in a row/);
});

test("two identical calls in a row are a retry, not a loop worth reporting", () => {
  const line = formatToolProfile({ toolCalls: 5, repeatCallRun: 2 });
  assert.ok(!line.includes("identical"), line);
});

test("an edit as the very first action reports zero seconds, not nothing", () => {
  // `firstEditMs: 0` is a measurement — the run changed a file before reading
  // anything — and a falsy check would drop exactly the case worth seeing.
  const line = formatToolProfile({ toolCalls: 3, firstEditMs: 0 });
  assert.match(line, /first edit after 0s/);
});
