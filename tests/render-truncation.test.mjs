import assert from "node:assert/strict";
import test from "node:test";

import { renderRunResult, renderStatusReport, truncationWarning } from "../plugins/pi/scripts/lib/render.mjs";

/**
 * Как обрыв на потолке выглядит для того, кто читает вывод.
 *
 * Фаза джоба — одно слово в середине строки, а слева от неё стоит иконка,
 * которую и читают. Пока обрезанный прогон нёс галочку, слово никого не
 * спасало; ровно за этим фаза и заведена.
 */

const snapshot = (job) => ({ global: false, jobs: [{ id: "pi-1", kind: "delegate", status: "completed", ...job }] });

test("a truncated job carries a warning instead of a tick", () => {
  const report = renderStatusReport(snapshot({ phase: "truncated" }));
  assert.match(report, /⚠️/);
  assert.doesNotMatch(report, /✅/, "галочка на недоделанной работе — это то, что чинится");
  assert.match(report, /the work is probably unfinished/i, "и словами, а не только значком");
});

test("a finished job is unchanged", () => {
  const report = renderStatusReport(snapshot({ phase: "done" }));
  assert.match(report, /✅/);
  assert.match(report, /phase: done/);
});

test("the run report says the answer was cut off, where the answer is read", () => {
  const report = renderRunResult({
    title: "delegate",
    job: { id: "pi-1", kind: "delegate", workspaceRoot: "/tmp/x" },
    settings: {},
    execution: { text: "Now let me wire this up:", stopReason: "length", errors: [] }
  });

  assert.match(report, /## Problems/, "секция появляется, даже если других ошибок нет");
  assert.match(report, /output ceiling/i);
});

test("a run that recovered says so, and the answer is the joined text", () => {
  const note = truncationWarning({ stopReason: "stop", recoveredTruncations: 2 });
  assert.match(note, /2 time\(s\)/);
  assert.match(note, /joined/, "читателю сказано, почему в ответе шов");
});

test("a clean run gets no note at all", () => {
  assert.equal(truncationWarning({ stopReason: "stop" }), null);
  assert.equal(truncationWarning({}), null);
});

test("the note distinguishes a rescued run from one that gave up", () => {
  const gaveUp = truncationWarning({ stopReason: "length", recoveredTruncations: 3 });
  assert.match(gaveUp, /did not get past it/, "попытки были и не помогли");
  assert.match(truncationWarning({ stopReason: "length" }), /whatever the exit code says/);
});
