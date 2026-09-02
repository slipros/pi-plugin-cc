import fs from "node:fs";
import path from "node:path";

import { parseJsonLine } from "./jsonl.mjs";
import { fleetEventsPath, nowIso } from "./state.mjs";

/**
 * The "a run ended" channel.
 *
 * A detached run outlives the turn that started it, and nothing inside the
 * caller's process is left to notice its end: the supervisor has to keep a
 * live waiter per job, and every one of those is a separate thing that can be
 * killed, race, or simply not be armed. Losing it is silent — a channel that
 * has died and a job that is still working look identical from the outside.
 *
 * So the run announces itself instead. Every terminal outcome appends one line
 * here, unconditionally: not a hook the user has to configure (an unconfigured
 * announcement is the one nobody hears), and not per job. One machine-wide log
 * means one long-lived watcher covers the whole fleet, across workspaces and
 * across waves, and it never has to be re-armed after a run completes.
 *
 * The log is a convenience channel, never the source of truth: job records and
 * the journal already hold what happened. That is what lets a lost or rotated
 * line be a non-event — `status` still answers correctly.
 */

/** Rotate once the log passes this size; a supervisor reads the tail, not the history. */
const MAX_LOG_BYTES = 512 * 1024;

/** Lines kept when rotating. Enough to cover a long epic's worth of waves. */
const KEEP_LINES = 400;

/**
 * Cap on the free-text fields.
 *
 * An event is a signal, not a transcript: the answer already lives in the job
 * record, and one run with a long summary should not be able to push a wave's
 * worth of endings out of a rotated log.
 */
const MAX_TEXT_CHARS = 200;

function clip(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value);
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS - 1)}…` : text;
}

const STATUS_ICONS = {
  completed: "✅",
  failed: "❌",
  cancelled: "🚫",
  orphaned: "⚠️"
};

/** Terminal states worth announcing. `orphaned` is here because a run that died is news. */
export const ANNOUNCED_STATUSES = new Set(["completed", "failed", "cancelled", "orphaned"]);

function rotateIfLarge(filePath) {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return;
  }
  if (size <= MAX_LOG_BYTES) {
    return;
  }
  try {
    const kept = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean).slice(-KEEP_LINES);
    fs.writeFileSync(filePath, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
  } catch {
    // A failed rotation is not worth failing a finished run over.
  }
}

/**
 * Announce a run that reached a terminal state.
 *
 * Never throws and never blocks: it is called from the last moments of a job,
 * after the result is already on disk, where an exception would turn a finished
 * run into a crashed one.
 */
export function recordFleetEvent(job = {}, { status = job.status, at = nowIso() } = {}) {
  if (!job.id || !ANNOUNCED_STATUSES.has(String(status))) {
    return null;
  }
  const event = {
    at,
    id: job.id,
    status: String(status),
    kind: job.kind ?? null,
    phase: job.phase ?? null,
    title: clip(job.title),
    preset: job.preset ?? null,
    model: job.model ?? null,
    elapsed: job.elapsed ?? null,
    workspaceRoot: job.workspaceRoot ?? null,
    runRoot: job.runRoot ?? null,
    summary: clip(job.summary)
  };
  try {
    const filePath = fleetEventsPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    rotateIfLarge(filePath);
    fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    return event;
  }
  return event;
}

/**
 * Read the log from a line cursor.
 *
 * The cursor is a line count rather than a byte offset so a rotation cannot
 * leave a follower reading from the middle of a line; a shrunken file simply
 * replays what is left, which is the safe direction to be wrong in.
 */
export function readFleetEvents({ from = 0, filePath = fleetEventsPath() } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { events: [], nextLine: from };
  }
  const lines = raw.split("\n").filter(Boolean);
  const start = from > lines.length ? 0 : from;
  const events = [];
  for (const line of lines.slice(start)) {
    const parsed = parseJsonLine(line);
    if (parsed?.id && parsed.status) {
      events.push(parsed);
    }
  }
  return { events, nextLine: lines.length };
}

/**
 * One event as one line.
 *
 * Written to stand alone: a watcher turns each line into a single notification
 * with nothing around it, so the id, the outcome and where it ran all have to
 * be in the line itself. The phase carries the truncation warning for the same
 * reason `status` does — an exit-zero run cut off at the output ceiling must
 * not read as a clean finish.
 */
export function formatFleetEvent(event = {}) {
  const truncated = event.phase === "truncated";
  const icon = truncated ? "⚠️" : (STATUS_ICONS[event.status] ?? "•");
  const where = event.runRoot ?? event.workspaceRoot ?? null;
  const parts = [
    `${icon} ${event.id}`,
    truncated ? `${event.status} (truncated — the answer hit the output ceiling)` : event.status,
    event.elapsed ? `elapsed: ${event.elapsed}` : null,
    event.preset ? `preset: ${event.preset}` : null,
    event.model ? `model: ${event.model}` : null,
    where ? `cwd: ${where}` : null,
    event.title ? `«${event.title}»` : null
  ].filter(Boolean);
  return parts.join(" · ");
}

/** Key identifying one announcement, so the same ending is not reported twice. */
export function eventKey(event = {}) {
  return `${event.id}:${event.status}`;
}

/**
 * Endings nobody could announce.
 *
 * `recordFleetEvent` runs inside the job's own process, which covers every
 * outcome that process lives to see — but not the one where it is killed
 * outright. Those runs surface as `orphaned` (a tracked pid that is gone), and
 * a poll is the only thing that can notice them, so the follower converts them
 * into the same event everything else arrives as.
 */
export function orphanEvents(jobs = [], seen = new Set()) {
  const events = [];
  for (const job of jobs) {
    if (job?.status !== "orphaned" || !job.id) {
      continue;
    }
    const event = {
      at: nowIso(),
      id: job.id,
      status: "orphaned",
      kind: job.kind ?? null,
      phase: job.phase ?? null,
      title: clip(job.title),
      preset: job.preset ?? null,
      model: job.model ?? null,
      elapsed: job.elapsed ?? null,
      workspaceRoot: job.workspaceRoot ?? null,
      runRoot: job.runRoot ?? null,
      summary: clip(job.summary)
    };
    if (seen.has(eventKey(event))) {
      continue;
    }
    events.push(event);
  }
  return events;
}
