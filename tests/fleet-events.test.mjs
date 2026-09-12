import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  eventBelongsToOwner,
  eventKey,
  formatFleetEvent,
  orphanEvents,
  readFleetEvents,
  recordFleetEvent
} from "../plugins/pi/scripts/lib/fleet-events.mjs";
import { fleetEventsPath } from "../plugins/pi/scripts/lib/state.mjs";

/** Every test gets its own data home, so the log under test is the only one. */
function withDataDir(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-events-"));
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    return run(dataDir);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("a finished run is announced and reads back", () => {
  withDataDir(() => {
    recordFleetEvent({
      id: "delegate-a",
      status: "completed",
      title: "task 07",
      preset: "go-developer",
      elapsed: "12m 3s",
      workspaceRoot: "/repo"
    });

    const { events, nextLine } = readFleetEvents();
    assert.equal(events.length, 1);
    assert.equal(nextLine, 1);
    assert.equal(events[0].id, "delegate-a");
    assert.equal(events[0].status, "completed");
    assert.ok(events[0].at, "the event carries when it happened");
  });
});

test("failure and cancellation are announced too — a channel that only reports success cannot be trusted", () => {
  withDataDir(() => {
    recordFleetEvent({ id: "delegate-f", status: "failed" });
    recordFleetEvent({ id: "delegate-c", status: "cancelled" });
    recordFleetEvent({ id: "delegate-o", status: "orphaned" });

    const statuses = readFleetEvents().events.map((event) => event.status);
    assert.deepEqual(statuses, ["failed", "cancelled", "orphaned"]);
  });
});

test("a run that has not ended is not announced", () => {
  withDataDir(() => {
    assert.equal(recordFleetEvent({ id: "delegate-a", status: "running" }), null);
    assert.equal(recordFleetEvent({ id: "delegate-a", status: "pending" }), null);
    assert.equal(recordFleetEvent({ status: "completed" }), null);
    assert.deepEqual(readFleetEvents().events, []);
  });
});

test("the cursor returns only what arrived since", () => {
  withDataDir(() => {
    recordFleetEvent({ id: "delegate-a", status: "completed" });
    const first = readFleetEvents();

    recordFleetEvent({ id: "delegate-b", status: "failed" });
    const second = readFleetEvents({ from: first.nextLine });

    assert.equal(second.events.length, 1);
    assert.equal(second.events[0].id, "delegate-b");
    assert.equal(second.nextLine, 2);
  });
});

test("a cursor past the end of a rotated log replays what is left instead of going silent", () => {
  withDataDir(() => {
    recordFleetEvent({ id: "delegate-a", status: "completed" });
    // Rotation cuts the file down; a follower holding a line count from before
    // it would otherwise sit past the end and never report anything again.
    fs.writeFileSync(fleetEventsPath(), "", "utf8");
    recordFleetEvent({ id: "delegate-b", status: "completed" });

    const { events } = readFleetEvents({ from: 5 });
    assert.equal(events.length, 1);
    assert.equal(events[0].id, "delegate-b");
  });
});

test("a broken line is skipped, not fatal", () => {
  withDataDir(() => {
    recordFleetEvent({ id: "delegate-a", status: "completed" });
    fs.appendFileSync(fleetEventsPath(), "{not json\n", "utf8");
    recordFleetEvent({ id: "delegate-b", status: "completed" });

    const ids = readFleetEvents().events.map((event) => event.id);
    assert.deepEqual(ids, ["delegate-a", "delegate-b"]);
  });
});

test("announcing never throws, however broken the destination", () => {
  withDataDir((dataDir) => {
    // A file where the state directory should be: the run is already over and
    // its result is on disk, so a failed announcement must not become an error.
    fs.writeFileSync(path.join(dataDir, "state"), "not a directory", "utf8");
    const event = recordFleetEvent({ id: "delegate-a", status: "completed" });
    assert.equal(event.id, "delegate-a");
    assert.deepEqual(readFleetEvents().events, []);
  });
});

test("the log rotates instead of growing without bound", () => {
  withDataDir(() => {
    const filePath = fleetEventsPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const filler = `${JSON.stringify({ at: "x", id: "old", status: "completed", pad: "y".repeat(200) })}\n`;
    fs.writeFileSync(filePath, filler.repeat(3000), "utf8");
    assert.ok(fs.statSync(filePath).size > 512 * 1024);

    recordFleetEvent({ id: "delegate-new", status: "completed" });

    assert.ok(fs.statSync(filePath).size < 512 * 1024, "the log was trimmed");
    const events = readFleetEvents().events;
    assert.equal(events.at(-1).id, "delegate-new", "the newest event survives rotation");
  });
});

test("a long summary is clipped rather than carried whole", () => {
  withDataDir(() => {
    recordFleetEvent({ id: "delegate-a", status: "completed", summary: "s".repeat(5000) });
    const [event] = readFleetEvents().events;
    assert.ok(event.summary.length <= 200, `summary was ${event.summary.length} chars`);
    assert.ok(event.summary.endsWith("…"));
  });
});

test("a truncated run does not read as a clean finish", () => {
  const line = formatFleetEvent({
    id: "delegate-a",
    status: "completed",
    phase: "truncated",
    elapsed: "3m"
  });
  assert.ok(line.startsWith("⚠️"), `expected a warning icon, got: ${line}`);
  assert.match(line, /truncated/);
  assert.ok(!line.includes("✅"));
});

test("an event line stands on its own: id, outcome and where it ran", () => {
  const line = formatFleetEvent({
    id: "delegate-a",
    status: "failed",
    elapsed: "1m 2s",
    preset: "go-qa",
    model: "deepseek/deepseek-v4-pro",
    runRoot: "/repo/etl",
    title: "task 07"
  });
  assert.match(line, /❌/);
  assert.match(line, /delegate-a/);
  assert.match(line, /failed/);
  assert.match(line, /go-qa/);
  assert.match(line, /\/repo\/etl/);
  assert.match(line, /task 07/);
});

test("only dead runs become orphan events, and only once", () => {
  const jobs = [
    { id: "alive", status: "running" },
    { id: "done", status: "completed" },
    { id: "dead", status: "orphaned", title: "task 09" }
  ];

  const first = orphanEvents(jobs);
  assert.deepEqual(first.map((event) => event.id), ["dead"]);
  assert.equal(first[0].status, "orphaned");

  const seen = new Set(first.map(eventKey));
  assert.deepEqual(orphanEvents(jobs, seen), []);
});

test("an announcement carries the session that started the run", () => {
  withDataDir(() => {
    recordFleetEvent({ id: "delegate-a", status: "completed", claudeSessionId: "sess-alpha" });
    assert.equal(readFleetEvents().events[0].owner, "sess-alpha");
  });
});

test("re-recording an orphan event keeps its owner — otherwise a death becomes everybody's", () => {
  withDataDir(() => {
    const [orphan] = orphanEvents([
      { id: "delegate-dead", status: "orphaned", claudeSessionId: "sess-alpha" }
    ]);
    assert.equal(orphan.owner, "sess-alpha");

    // The follower writes what the sweep found back into the log so a second
    // follower does not report the same death: that round trip must not strip
    // the owner and turn one session's run into a fleet-wide notification.
    recordFleetEvent(orphan);
    assert.equal(readFleetEvents().events[0].owner, "sess-alpha");
  });
});

test("a supervisor hears its own runs and unowned ones, never another supervisor's", () => {
  const mine = { id: "a", owner: "sess-alpha" };
  const theirs = { id: "b", owner: "sess-beta" };
  const nobodys = { id: "c", owner: null };

  assert.equal(eventBelongsToOwner(mine, "sess-alpha"), true);
  assert.equal(eventBelongsToOwner(theirs, "sess-alpha"), false);
  // Started by hand or by a hook: it belongs to nobody, so it is announced to
  // everybody rather than to no one.
  assert.equal(eventBelongsToOwner(nobodys, "sess-alpha"), true);
  // A watcher that cannot name itself hears the whole fleet: too much is a
  // better failure than a channel that has gone silent.
  assert.equal(eventBelongsToOwner(theirs, null), true);
});
