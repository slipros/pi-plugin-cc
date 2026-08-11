import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { captureTreeSnapshot, collectTreeDiff, summarizeTreeChanges } from "../plugins/pi/scripts/lib/git.mjs";
import { renderChangesSection } from "../plugins/pi/scripts/lib/render.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function withRepo(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tree-"));
  try {
    git(dir, "init", "--quiet", "--initial-branch", "main");
    git(dir, "config", "user.email", "agent@example.com");
    git(dir, "config", "user.name", "agent");
    fs.writeFileSync(path.join(dir, "README.md"), "start\n");
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "initial");
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a snapshot outside a git repository is absent, not an error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-not-a-repo-"));
  try {
    assert.equal(captureTreeSnapshot(dir), null);
    assert.equal(summarizeTreeChanges(dir, null), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an untouched tree reports no changes", () => {
  withRepo((dir) => {
    const before = captureTreeSnapshot(dir);
    const changes = summarizeTreeChanges(dir, before);

    assert.deepEqual(changes.files, []);
    assert.deepEqual(changes.commits, []);
    assert.deepEqual(renderChangesSection(changes), [], "nothing to show means no section at all");
  });
});

test("files the agent wrote are reported, committed or not", () => {
  withRepo((dir) => {
    const before = captureTreeSnapshot(dir);

    fs.writeFileSync(path.join(dir, "added.txt"), "new file\n");
    fs.appendFileSync(path.join(dir, "README.md"), "edited\n");
    git(dir, "add", "README.md");
    git(dir, "commit", "--quiet", "-m", "agent commit");

    const changes = summarizeTreeChanges(dir, before);
    assert.deepEqual(changes.files, ["README.md", "added.txt"]);
    assert.equal(changes.commits.length, 1);
    assert.match(changes.commits[0], /agent commit/);
    assert.match(changes.stat, /1 file changed/);
    assert.match(changes.diffCommand, /^git diff [0-9a-f]{12}$/);

    const rendered = renderChangesSection(changes).join("\n");
    assert.match(rendered, /## Changes/);
    assert.match(rendered, /added\.txt/);
  });
});

test("work already in progress before the run is not attributed to the agent", () => {
  withRepo((dir) => {
    // The caller's own uncommitted edit, made before anything was delegated.
    fs.appendFileSync(path.join(dir, "README.md"), "mine\n");
    const before = captureTreeSnapshot(dir);

    fs.writeFileSync(path.join(dir, "agent.txt"), "written by the agent\n");
    const changes = summarizeTreeChanges(dir, before);

    assert.deepEqual(changes.files, ["agent.txt"], "the pre-existing edit is not the run's doing");
    assert.deepEqual(changes.preexisting, ["README.md"]);
    assert.match(renderChangesSection(changes).join("\n"), /Already modified before the run/);
  });
});

test("the diff carries the patch and the files git diff cannot see", () => {
  withRepo((dir) => {
    const before = captureTreeSnapshot(dir);
    fs.appendFileSync(path.join(dir, "README.md"), "tracked change\n");
    fs.writeFileSync(path.join(dir, "brand-new.txt"), "untracked\n");

    const diff = collectTreeDiff(dir, before);
    assert.match(diff.text, /tracked change/, "the patch of a tracked file");
    assert.match(diff.text, /New untracked files/);
    assert.match(diff.text, /brand-new\.txt/, "a new file is invisible to git diff and has to be listed");
    assert.equal(diff.truncated, false);
  });
});

test("a huge diff is truncated rather than pasted whole into a reply", () => {
  withRepo((dir) => {
    const before = captureTreeSnapshot(dir);
    fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(5000));
    git(dir, "add", "big.txt");

    const diff = collectTreeDiff(dir, before, { maxBytes: 500 });
    assert.equal(diff.truncated, true);
    assert.match(diff.text, /truncated/);
  });
});
