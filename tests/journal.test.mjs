import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  jobToRow,
  openDatabase,
  pruneJournalText,
  pruneJournalTextIfDue,
  queryRun,
  queryRuns,
  recordJob,
  DEFAULT_TEXT_TTL_DAYS
} from "../plugins/pi/scripts/lib/db.mjs";
import { capText, forJournal, redactSecrets } from "../plugins/pi/scripts/lib/redact.mjs";

function withJournal(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-text-"));
  const handle = openDatabase(path.join(dir, "jobs.db"));
  try {
    return run(handle, dir);
  } finally {
    handle?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a key pasted into a task does not reach the journal verbatim", () => {
  const text = [
    "check why sk-abcdefghijklmnopqrstuvwx is rejected",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
    'api_key = "supersecretvalue"',
    "git clone https://user:hunter2@example.com/repo.git",
    "token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
  ].join("\n");

  const clean = redactSecrets(text);
  assert.doesNotMatch(clean, /sk-abcdefghij/);
  assert.doesNotMatch(clean, /abcdefghijklmnopqrstuvwxyz012345/);
  assert.doesNotMatch(clean, /supersecretvalue/);
  assert.doesNotMatch(clean, /hunter2/);
  assert.doesNotMatch(clean, /eyJhbGciOiJIUzI1NiJ9\./);
  // The surrounding text still has to be readable, or the journal is useless.
  assert.match(clean, /check why .* is rejected/);
});

test("a secret with no recognisable shape is stored, and that is a known limit", () => {
  // Documented rather than pretended away: pattern matching cannot tell a
  // random password from any other word.
  assert.equal(redactSecrets("the password is correcthorse"), "the password is correcthorse");
});

test("stored text is capped and says where it was cut", () => {
  const long = "x".repeat(100);
  assert.equal(capText(long, 100), long, "a field at the limit is untouched");
  const capped = capText(long, 40);
  assert.match(capped, /truncated for the journal, 60 more characters/);
  assert.equal(forJournal(null), null);
});

test("a run records what it was asked, what it answered, and how to repeat it", () => {
  withJournal((handle) => {
    recordJob(handle, {
      id: "delegate-1",
      kind: "delegate",
      title: "fix the flaky test",
      workspaceRoot: "/repo",
      model: "ollama-pro/glm-5.2",
      status: "completed",
      createdAt: new Date().toISOString(),
      prompt: "fix the flaky test in tests/foo",
      text: "Fixed it: the clock was mocked twice.",
      rerunSettings: { preset: "agent", model: "ollama-pro/glm-5.2" }
    });

    const run = queryRun(handle, "delegate-1");
    assert.equal(run.prompt, "fix the flaky test in tests/foo");
    assert.equal(run.result_text, "Fixed it: the clock was mocked twice.");
    assert.deepEqual(JSON.parse(run.settings), { preset: "agent", model: "ollama-pro/glm-5.2" });

    // An abbreviated id is how every other command refers to a job.
    assert.equal(queryRun(handle, "ate-1").id, "delegate-1");
    assert.equal(queryRun(handle, "nothing-like-this"), null);
  });
});

test("the run list narrows by workspace and model", () => {
  withJournal((handle) => {
    const base = { kind: "delegate", status: "completed", createdAt: new Date().toISOString() };
    recordJob(handle, { ...base, id: "a", workspaceRoot: "/one", model: "ollama-pro/glm-5.2", prompt: "one" });
    recordJob(handle, { ...base, id: "b", workspaceRoot: "/two", model: "anthropic/opus-5", prompt: "two" });

    assert.deepEqual(queryRuns(handle, { workspace: "/one" }).map((row) => row.id), ["a"]);
    assert.deepEqual(queryRuns(handle, { model: "glm" }).map((row) => row.id), ["a"]);
    assert.equal(queryRuns(handle, {}).length, 2);
  });
});

test("retention clears the text of old runs but keeps their numbers", () => {
  withJournal((handle) => {
    const old = new Date(Date.now() - (DEFAULT_TEXT_TTL_DAYS + 5) * 86_400_000).toISOString();
    recordJob(handle, {
      id: "ancient",
      kind: "delegate",
      status: "completed",
      createdAt: old,
      startedAt: old,
      completedAt: old,
      usage: { input: 1000, output: 500, cost: 0.25 },
      prompt: "something from last quarter",
      text: "an answer from last quarter"
    });
    recordJob(handle, {
      id: "recent",
      kind: "delegate",
      status: "completed",
      createdAt: new Date().toISOString(),
      prompt: "today's task",
      text: "today's answer"
    });

    assert.equal(pruneJournalText(handle), 1);

    const aged = queryRun(handle, "ancient");
    assert.equal(aged.prompt, null);
    assert.equal(aged.result_text, null);
    // Statistics are built from these; expiring them would rewrite history.
    assert.equal(aged.input, 1000);
    assert.equal(aged.cost, 0.25);

    assert.equal(queryRun(handle, "recent").prompt, "today's task");
  });
});

test("the automatic prune runs at most once a day", () => {
  withJournal((handle) => {
    const old = new Date(Date.now() - (DEFAULT_TEXT_TTL_DAYS + 1) * 86_400_000).toISOString();
    recordJob(handle, { id: "old-1", kind: "delegate", status: "completed", createdAt: old, prompt: "gone soon" });

    assert.equal(pruneJournalTextIfDue(handle), 1);

    recordJob(handle, { id: "old-2", kind: "delegate", status: "completed", createdAt: old, prompt: "still here" });
    assert.equal(pruneJournalTextIfDue(handle), 0, "a second sweep on the same day does nothing");
    assert.equal(queryRun(handle, "old-2").prompt, "still here");

    // A day later it sweeps again.
    assert.equal(pruneJournalTextIfDue(handle, { now: Date.now() + 25 * 3600 * 1000 }), 1);
  });
});

test("the journal file is not readable by everyone on the machine", () => {
  withJournal((handle, dir) => {
    recordJob(handle, { id: "x", kind: "delegate", status: "completed", createdAt: new Date().toISOString() });
    const file = path.join(dir, "jobs.db");
    // It holds prompts and answers — the contents of whatever repository the
    // run touched — and lived at 0644 in a 0755 directory before.
    assert.equal(fs.statSync(file).mode & 0o077, 0, "group and other must have no access");
    assert.equal(fs.statSync(dir).mode & 0o077, 0);
  });
});

test("a job with no text still maps onto the row", () => {
  const row = jobToRow({ id: "plain", kind: "delegate", createdAt: new Date().toISOString() });
  assert.equal(row.prompt, null);
  assert.equal(row.result_text, null);
  assert.equal(row.settings, null);
});

test("file work survives the second write of the same run", () => {
  // A run is recorded twice: once when it starts, once when it ends. The
  // upsert keeps counters from going backwards with MAX(), and MAX(NULL, 5) in
  // SQLite is NULL — so a column without DEFAULT 0 (file work, and the failure
  // profile beside it) has to be merged with COALESCE instead. It was not, and
  // every measured run landed in the journal empty.
  withJournal((handle) => {
    recordJob(handle, {
      id: "delegate-two-writes",
      kind: "delegate",
      status: "running",
      createdAt: new Date().toISOString()
    });
    recordJob(handle, {
      id: "delegate-two-writes",
      kind: "delegate",
      status: "completed",
      createdAt: new Date().toISOString(),
      agentWork: {
        linesRead: 412,
        linesWritten: 87,
        linesReplaced: 31,
        filesRead: 9,
        filesWritten: 4,
        rereads: 2
      }
    });

    const run = queryRun(handle, "delegate-two-writes");
    assert.equal(run.lines_read, 412);
    assert.equal(run.lines_written, 87);
    assert.equal(run.lines_replaced, 31);
    assert.equal(run.files_read, 9);
    assert.equal(run.files_written, 4);
    assert.equal(run.rereads, 2);
  });
});

test("a run that predates the measurement stores null, not a measured zero", () => {
  withJournal((handle) => {
    recordJob(handle, {
      id: "delegate-old",
      kind: "delegate",
      status: "completed",
      createdAt: new Date().toISOString()
    });

    const run = queryRun(handle, "delegate-old");
    assert.equal(run.lines_read, null);
    assert.equal(run.files_written, null);
  });
});
