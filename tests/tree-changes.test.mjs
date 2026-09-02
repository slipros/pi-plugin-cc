import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { captureTreeSnapshot, summarizeTreeChanges } from "../plugins/pi/scripts/lib/git.mjs";

function withRepository(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tree-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "agent@example.com");
  git("config", "user.name", "agent");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(root, "main.go"), "package main\n\nfunc main() {}\n");
  git("add", "main.go");
  git("commit", "-qm", "init");
  try {
    return run(root, git);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("what reached the tree is counted in lines, not only described in a sentence", () => {
  withRepository((root) => {
    const before = captureTreeSnapshot(root);
    fs.writeFileSync(path.join(root, "main.go"), "package main\n\nfunc main() {\n\tprintln(1)\n}\n");

    const changes = summarizeTreeChanges(root, before);
    assert.equal(changes.added, 3);
    assert.equal(changes.deleted, 1);
    assert.match(changes.stat, /insertion/);
  });
});

test("a committed change counts the same as an uncommitted one", () => {
  withRepository((root, git) => {
    const before = captureTreeSnapshot(root);
    fs.appendFileSync(path.join(root, "main.go"), "\n// tail\n");
    git("add", "main.go");
    git("commit", "-qm", "work");

    const changes = summarizeTreeChanges(root, before);
    assert.equal(changes.added, 2);
    assert.equal(changes.deleted, 0);
    assert.equal(changes.commits.length, 1);
  });
});

test("new files that never reached the index are reported apart, because the diff cannot see them", () => {
  withRepository((root) => {
    const before = captureTreeSnapshot(root);
    fs.writeFileSync(path.join(root, "extra.go"), "package main\n// new\n");

    const changes = summarizeTreeChanges(root, before);
    assert.equal(changes.added, 0, "git diff knows nothing about untracked paths");
    assert.equal(changes.untracked, 1, "and the gap is stated rather than hidden");
    assert.ok(changes.files.includes("extra.go"));
  });
});

test("a file the caller had already dirtied is not counted as untracked work of the run", () => {
  withRepository((root) => {
    fs.writeFileSync(path.join(root, "mine.txt"), "left here before the run\n");
    const before = captureTreeSnapshot(root);

    const changes = summarizeTreeChanges(root, before);
    assert.equal(changes.untracked, 0);
    assert.deepEqual(changes.preexisting, ["mine.txt"]);
  });
});
