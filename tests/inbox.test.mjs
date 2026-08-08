import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createInboxWatcher,
  inboxPath,
  pushControlMessage,
  readControlMessages
} from "../plugins/pi/scripts/lib/inbox.mjs";

function withWorkspace(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-inbox-"));
  const workspaceRoot = path.join(dataDir, "repo");
  fs.mkdirSync(workspaceRoot);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    return run(workspaceRoot);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("messages are appended and read back in order", () => {
  withWorkspace((workspaceRoot) => {
    pushControlMessage(workspaceRoot, "job-1", { kind: "steer", message: "look at auth" });
    pushControlMessage(workspaceRoot, "job-1", { kind: "follow_up", message: "then write tests" });

    const { messages, nextLine } = readControlMessages(inboxPath(workspaceRoot, "job-1"));
    assert.deepEqual(
      messages.map((entry) => [entry.kind, entry.message]),
      [
        ["steer", "look at auth"],
        ["follow_up", "then write tests"]
      ]
    );
    assert.equal(nextLine, 2);
  });
});

test("reading from a cursor returns only new messages", () => {
  withWorkspace((workspaceRoot) => {
    pushControlMessage(workspaceRoot, "job-1", { kind: "steer", message: "first" });
    const file = inboxPath(workspaceRoot, "job-1");
    const first = readControlMessages(file);

    pushControlMessage(workspaceRoot, "job-1", { kind: "steer", message: "second" });
    const second = readControlMessages(file, first.nextLine);

    assert.equal(second.messages.length, 1);
    assert.equal(second.messages[0].message, "second");
  });
});

test("an abort needs no text but other kinds do", () => {
  withWorkspace((workspaceRoot) => {
    assert.ok(pushControlMessage(workspaceRoot, "job-1", { kind: "abort" }));
    assert.throws(() => pushControlMessage(workspaceRoot, "job-1", { kind: "steer", message: "  " }), /needs text/);
    assert.throws(() => pushControlMessage(workspaceRoot, "job-1", { kind: "shout", message: "hi" }), /Unsupported control message/);
  });
});

test("a missing inbox reads as empty rather than failing", () => {
  withWorkspace((workspaceRoot) => {
    assert.deepEqual(readControlMessages(inboxPath(workspaceRoot, "nope")), { messages: [], nextLine: 0 });
  });
});

test("corrupt lines are skipped, valid ones still arrive", () => {
  withWorkspace((workspaceRoot) => {
    pushControlMessage(workspaceRoot, "job-1", { kind: "steer", message: "good" });
    fs.appendFileSync(inboxPath(workspaceRoot, "job-1"), "not json\n", "utf8");
    const { messages } = readControlMessages(inboxPath(workspaceRoot, "job-1"));
    assert.equal(messages.length, 1);
  });
});

test("the watcher ignores pre-existing messages and delivers new ones", async () => {
  await withWorkspace(async (workspaceRoot) => {
    pushControlMessage(workspaceRoot, "job-1", { kind: "steer", message: "before the watcher" });

    const seen = [];
    const watcher = createInboxWatcher(inboxPath(workspaceRoot, "job-1"), (entry) => seen.push(entry.message), {
      intervalMs: 50
    });

    try {
      assert.deepEqual(watcher.drain(), [], "history is not replayed");
      pushControlMessage(workspaceRoot, "job-1", { kind: "steer", message: "after the watcher" });
      assert.equal(watcher.drain().length, 1);
      assert.deepEqual(seen, ["after the watcher"]);
      assert.deepEqual(watcher.drain(), [], "each message is delivered once");
    } finally {
      watcher.stop();
    }
  });
});

test("a stopped watcher stops delivering", () => {
  withWorkspace((workspaceRoot) => {
    const watcher = createInboxWatcher(inboxPath(workspaceRoot, "job-1"), () => {}, { intervalMs: 50 });
    watcher.stop();
    pushControlMessage(workspaceRoot, "job-1", { kind: "steer", message: "ignored" });
    assert.deepEqual(watcher.drain(), []);
  });
});
