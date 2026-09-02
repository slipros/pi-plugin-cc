import assert from "node:assert/strict";
import test from "node:test";

import {
  countLines,
  createFileWorkState,
  mergeFileWork,
  noteToolEnd,
  noteToolStart,
  summarizeFileWork
} from "../plugins/pi/scripts/lib/file-work.mjs";

test("a trailing newline does not invent a line", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines(null), 0);
});

test("a written file counts its content, not its result", () => {
  const state = createFileWorkState();
  noteToolStart(state, "write", { path: "main.go", content: "package main\n\nfunc main() {}\n" });
  noteToolEnd(state, "write", { path: "main.go" }, "ok");

  const summary = summarizeFileWork(state);
  assert.equal(summary.linesWritten, 3);
  assert.equal(summary.filesWritten, 1);
  assert.equal(summary.linesRead, 0, "a write tool's answer is not reading");
});

test("an edit counts what it wrote and what it replaced", () => {
  const state = createFileWorkState();
  noteToolStart(state, "edit", {
    path: "main.go",
    old_string: "a\nb\nc",
    new_string: "a\nb"
  });

  const summary = summarizeFileWork(state);
  assert.equal(summary.linesWritten, 2);
  assert.equal(summary.linesReplaced, 3);
  assert.equal(summary.filesWritten, 1);
});

test("a batch of edits is counted whole", () => {
  const state = createFileWorkState();
  noteToolStart(state, "multi_edit", {
    path: "main.go",
    edits: [
      { old_string: "x", new_string: "y\nz" },
      { old_string: "p\nq", new_string: "r" }
    ]
  });

  const summary = summarizeFileWork(state);
  assert.equal(summary.linesWritten, 3);
  assert.equal(summary.linesReplaced, 3);
});

test("reading counts what came back, because that is what entered the context", () => {
  const state = createFileWorkState();
  noteToolStart(state, "read", { path: "main.go" });
  noteToolEnd(state, "read", { path: "main.go" }, "line one\nline two\nline three\n");

  const summary = summarizeFileWork(state);
  assert.equal(summary.linesRead, 3);
  assert.equal(summary.filesRead, 1);
});

test("a read is counted whatever shape the answer comes in", () => {
  // The rpc engine wraps the answer in content blocks; counting only plain
  // strings scored every read as zero lines while the file count rose.
  const blocks = createFileWorkState();
  noteToolStart(blocks, "read", { path: "a.go" });
  noteToolEnd(blocks, "read", { path: "a.go" }, { content: [{ type: "text", text: "a\nb\nc\n" }] });
  assert.equal(summarizeFileWork(blocks).linesRead, 3);

  const output = createFileWorkState();
  noteToolStart(output, "read", { path: "b.go" });
  noteToolEnd(output, "read", { path: "b.go" }, { output: "x\ny\n" });
  assert.equal(summarizeFileWork(output).linesRead, 2);
});

test("a failed read put nothing in the context and counts as nothing", () => {
  const state = createFileWorkState();
  noteToolStart(state, "read", { path: "missing.go" });
  noteToolEnd(state, "read", { path: "missing.go" }, "ENOENT: no such file", true);

  assert.deepEqual(summarizeFileWork(state), {
    linesRead: 0,
    linesWritten: 0,
    linesReplaced: 0,
    filesRead: 0,
    filesWritten: 0,
    rereads: 0
  });
});

test("a file read twice is one file and one re-read", () => {
  const state = createFileWorkState();
  for (const _ of [0, 1, 2]) {
    noteToolStart(state, "read", { path: "main.go" });
    noteToolEnd(state, "read", { path: "main.go" }, "a\nb\n");
  }

  const summary = summarizeFileWork(state);
  assert.equal(summary.filesRead, 1);
  assert.equal(summary.rereads, 2);
  assert.equal(summary.linesRead, 6, "every read costs context again");
});

test("shell output is not counted as reading — mixing it in would make the ratio unreadable", () => {
  const state = createFileWorkState();
  noteToolStart(state, "bash", { command: "cat main.go" });
  noteToolEnd(state, "bash", { command: "cat main.go" }, "a\nb\nc\n");
  noteToolStart(state, "grep", { pattern: "func" });
  noteToolEnd(state, "grep", { pattern: "func" }, "main.go:1:func main\n");

  assert.equal(summarizeFileWork(state).linesRead, 0);
});

test("the file a tool names is found whatever this pi calls the argument", () => {
  const state = createFileWorkState();
  noteToolStart(state, "write", { file_path: "a.go", content: "x\n" });
  noteToolStart(state, "write", { filePath: "b.go", text: "y\n" });
  noteToolStart(state, "write", { file: "c.go", contents: "z\n" });

  const summary = summarizeFileWork(state);
  assert.equal(summary.filesWritten, 3);
  assert.equal(summary.linesWritten, 3);
});

test("two halves of a resumed run add up", () => {
  const merged = mergeFileWork(
    { linesRead: 10, linesWritten: 4, linesReplaced: 2, filesRead: 2, filesWritten: 1, rereads: 1 },
    { linesRead: 5, linesWritten: 6, linesReplaced: 0, filesRead: 1, filesWritten: 1, rereads: 0 }
  );
  assert.deepEqual(merged, {
    linesRead: 15,
    linesWritten: 10,
    linesReplaced: 2,
    filesRead: 3,
    filesWritten: 2,
    rereads: 1
  });
});

test("an absent state summarises to zeroes rather than throwing", () => {
  assert.deepEqual(summarizeFileWork(null), {
    linesRead: 0,
    linesWritten: 0,
    linesReplaced: 0,
    filesRead: 0,
    filesWritten: 0,
    rereads: 0
  });
  assert.doesNotThrow(() => noteToolStart(null, "write", { content: "x" }));
  assert.doesNotThrow(() => noteToolEnd(null, "read", {}, "x"));
});
