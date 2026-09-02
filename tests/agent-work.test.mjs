import assert from "node:assert/strict";
import test from "node:test";

import {
  countLines,
  createAgentWorkState,
  mergeAgentWork,
  noteToolEnd,
  noteToolStart,
  summarizeAgentWork
} from "../plugins/pi/scripts/lib/agent-work.mjs";

test("a trailing newline does not invent a line", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines(null), 0);
});

test("a written file counts its content, not its result", () => {
  const state = createAgentWorkState();
  noteToolStart(state, "write", { path: "main.go", content: "package main\n\nfunc main() {}\n" });
  noteToolEnd(state, "write", { path: "main.go" }, "ok");

  const summary = summarizeAgentWork(state);
  assert.equal(summary.linesWritten, 3);
  assert.equal(summary.filesWritten, 1);
  assert.equal(summary.linesRead, 0, "a write tool's answer is not reading");
});

test("an edit counts what it wrote and what it replaced", () => {
  const state = createAgentWorkState();
  noteToolStart(state, "edit", {
    path: "main.go",
    old_string: "a\nb\nc",
    new_string: "a\nb"
  });

  const summary = summarizeAgentWork(state);
  assert.equal(summary.linesWritten, 2);
  assert.equal(summary.linesReplaced, 3);
  assert.equal(summary.filesWritten, 1);
});

test("a batch of edits is counted whole", () => {
  const state = createAgentWorkState();
  noteToolStart(state, "multi_edit", {
    path: "main.go",
    edits: [
      { old_string: "x", new_string: "y\nz" },
      { old_string: "p\nq", new_string: "r" }
    ]
  });

  const summary = summarizeAgentWork(state);
  assert.equal(summary.linesWritten, 3);
  assert.equal(summary.linesReplaced, 3);
});

test("reading counts what came back, because that is what entered the context", () => {
  const state = createAgentWorkState();
  noteToolStart(state, "read", { path: "main.go" });
  noteToolEnd(state, "read", { path: "main.go" }, "line one\nline two\nline three\n");

  const summary = summarizeAgentWork(state);
  assert.equal(summary.linesRead, 3);
  assert.equal(summary.filesRead, 1);
});

test("a read is counted whatever shape the answer comes in", () => {
  // The rpc engine wraps the answer in content blocks; counting only plain
  // strings scored every read as zero lines while the file count rose.
  const blocks = createAgentWorkState();
  noteToolStart(blocks, "read", { path: "a.go" });
  noteToolEnd(blocks, "read", { path: "a.go" }, { content: [{ type: "text", text: "a\nb\nc\n" }] });
  assert.equal(summarizeAgentWork(blocks).linesRead, 3);

  const output = createAgentWorkState();
  noteToolStart(output, "read", { path: "b.go" });
  noteToolEnd(output, "read", { path: "b.go" }, { output: "x\ny\n" });
  assert.equal(summarizeAgentWork(output).linesRead, 2);
});

test("a failed read put nothing in the context and counts as nothing", () => {
  const state = createAgentWorkState();
  noteToolStart(state, "read", { path: "missing.go" });
  noteToolEnd(state, "read", { path: "missing.go" }, "ENOENT: no such file", true);

  const summary = summarizeAgentWork(state);
  assert.equal(summary.linesRead, 0);
  assert.equal(summary.filesRead, 0);
  assert.equal(summary.readErrors, 1, "the failure is still counted, as a read failure");
});

test("a file read twice is one file and one re-read", () => {
  const state = createAgentWorkState();
  for (const _ of [0, 1, 2]) {
    noteToolStart(state, "read", { path: "main.go" });
    noteToolEnd(state, "read", { path: "main.go" }, "a\nb\n");
  }

  const summary = summarizeAgentWork(state);
  assert.equal(summary.filesRead, 1);
  assert.equal(summary.rereads, 2);
  assert.equal(summary.linesRead, 6, "every read costs context again");
});

test("shell output is not counted as reading — mixing it in would make the ratio unreadable", () => {
  const state = createAgentWorkState();
  noteToolStart(state, "bash", { command: "cat main.go" });
  noteToolEnd(state, "bash", { command: "cat main.go" }, "a\nb\nc\n");
  noteToolStart(state, "grep", { pattern: "func" });
  noteToolEnd(state, "grep", { pattern: "func" }, "main.go:1:func main\n");

  assert.equal(summarizeAgentWork(state).linesRead, 0);
});

test("the file a tool names is found whatever this pi calls the argument", () => {
  const state = createAgentWorkState();
  noteToolStart(state, "write", { file_path: "a.go", content: "x\n" });
  noteToolStart(state, "write", { filePath: "b.go", text: "y\n" });
  noteToolStart(state, "write", { file: "c.go", contents: "z\n" });

  const summary = summarizeAgentWork(state);
  assert.equal(summary.filesWritten, 3);
  assert.equal(summary.linesWritten, 3);
});

test("two halves of a resumed run add up", () => {
  const merged = mergeAgentWork(
    { linesRead: 10, linesWritten: 4, linesReplaced: 2, filesRead: 2, filesWritten: 1, rereads: 1 },
    { linesRead: 5, linesWritten: 6, linesReplaced: 0, filesRead: 1, filesWritten: 1, rereads: 0 }
  );
  assert.equal(merged.linesRead, 15);
  assert.equal(merged.linesWritten, 10);
  assert.equal(merged.linesReplaced, 2);
  assert.equal(merged.filesRead, 3);
  assert.equal(merged.filesWritten, 2);
  assert.equal(merged.rereads, 1);
});

test("the first edit of a resumed run is the earlier one, and a half that never edited has no say", () => {
  assert.equal(mergeAgentWork({ firstEditMs: 9000 }, { firstEditMs: 2000 }).firstEditMs, 2000);
  assert.equal(mergeAgentWork({ firstEditMs: null }, { firstEditMs: 2000 }).firstEditMs, 2000);
  assert.equal(mergeAgentWork({ firstEditMs: null }, { firstEditMs: null }).firstEditMs, null);
});

test("a loop is the longest either half saw, not their sum", () => {
  assert.equal(mergeAgentWork({ repeatCallRun: 3 }, { repeatCallRun: 3 }).repeatCallRun, 3);
  assert.equal(mergeAgentWork({ repeatCallRun: 2 }, { repeatCallRun: 5 }).repeatCallRun, 5);
});

test("tool failures are told apart by the kind of work that failed", () => {
  const state = createAgentWorkState();
  noteToolStart(state, "edit", { path: "a.go", old_string: "x", new_string: "y" });
  noteToolEnd(state, "edit", { path: "a.go" }, "no match for old_string", true);
  noteToolStart(state, "read", { path: "gone.go" });
  noteToolEnd(state, "read", { path: "gone.go" }, "ENOENT", true);
  noteToolStart(state, "bash", { command: "make test" });
  noteToolEnd(state, "bash", { command: "make test" }, "exit 1", true);
  noteToolStart(state, "grep", { pattern: "x" });
  noteToolEnd(state, "grep", { pattern: "x" }, "bad regex", true);

  const summary = summarizeAgentWork(state);
  assert.equal(summary.editErrors, 1, "an edit that found nothing means writing against unread code");
  assert.equal(summary.readErrors, 1);
  assert.equal(summary.shellErrors, 1);
  assert.equal(summary.otherErrors, 1);
});

test("shell calls are counted apart, because they are the blind spot of the line counts", () => {
  const state = createAgentWorkState();
  noteToolStart(state, "bash", { command: "cat a.go" });
  noteToolStart(state, "read", { path: "b.go" });
  noteToolStart(state, "bash", { command: "sed -i s/x/y/ a.go" });

  const summary = summarizeAgentWork(state);
  assert.equal(summary.toolCalls, 3);
  assert.equal(summary.shellCalls, 2);
});

test("time to the first edit is measured, and a run that only read has none", () => {
  const editing = createAgentWorkState();
  noteToolStart(editing, "read", { path: "a.go" }, { now: 1_000, runStartedAt: 1_000 });
  noteToolStart(editing, "read", { path: "b.go" }, { now: 4_000, runStartedAt: 1_000 });
  noteToolStart(editing, "edit", { path: "a.go", old_string: "x", new_string: "y" }, { now: 9_500, runStartedAt: 1_000 });
  noteToolStart(editing, "edit", { path: "b.go", old_string: "p", new_string: "q" }, { now: 20_000, runStartedAt: 1_000 });
  assert.equal(summarizeAgentWork(editing).firstEditMs, 8_500, "the first edit, not the last");

  const readOnly = createAgentWorkState();
  noteToolStart(readOnly, "read", { path: "a.go" }, { now: 1_000, runStartedAt: 1_000 });
  assert.equal(summarizeAgentWork(readOnly).firstEditMs, null);
});

test("the same call three times running is a loop; the same call with work between it is not", () => {
  const looping = createAgentWorkState();
  for (const _ of [0, 1, 2]) {
    noteToolStart(looping, "bash", { command: "go test ./..." });
  }
  assert.equal(summarizeAgentWork(looping).repeatCallRun, 3);

  const working = createAgentWorkState();
  noteToolStart(working, "bash", { command: "go test ./..." });
  noteToolStart(working, "edit", { path: "a.go", old_string: "x", new_string: "y" });
  noteToolStart(working, "bash", { command: "go test ./..." });
  assert.equal(summarizeAgentWork(working).repeatCallRun, 1, "a retry after a change is not a loop");
});

test("an absent state summarises to zeroes rather than throwing", () => {
  const empty = summarizeAgentWork(null);
  assert.equal(empty.linesRead, 0);
  assert.equal(empty.toolCalls, 0);
  assert.equal(empty.editErrors, 0);
  assert.equal(empty.firstEditMs, null);
  assert.doesNotThrow(() => noteToolStart(null, "write", { content: "x" }));
  assert.doesNotThrow(() => noteToolEnd(null, "read", {}, "x"));
});
