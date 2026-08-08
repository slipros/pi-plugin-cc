import fs from "node:fs";
import path from "node:path";

import { parseJsonLine } from "./jsonl.mjs";
import { ensureStateDir, nowIso, resolveJobsDir } from "./state.mjs";

/**
 * Control channel for a running job.
 *
 * A separate Claude Code turn (or a human in another terminal) appends a line
 * here; the process that owns the pi run polls the file and forwards the
 * message into the live RPC session. A plain append-only file is used instead
 * of a socket so the channel survives restarts, works the same on every
 * platform, and stays trivially inspectable.
 */

export const CONTROL_KINDS = new Set(["steer", "follow_up", "abort"]);

export function inboxPath(workspaceRoot, jobId) {
  return path.join(resolveJobsDir(workspaceRoot), `${jobId}.inbox.jsonl`);
}

export function pushControlMessage(workspaceRoot, jobId, { kind, message = "" }) {
  if (!CONTROL_KINDS.has(kind)) {
    throw new Error(`Unsupported control message "${kind}". Use one of: ${[...CONTROL_KINDS].join(", ")}.`);
  }
  if (kind !== "abort" && !String(message).trim()) {
    throw new Error(`A "${kind}" message needs text.`);
  }

  ensureStateDir(workspaceRoot);
  const entry = {
    id: `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind,
    message: String(message).trim(),
    createdAt: nowIso()
  };
  fs.appendFileSync(inboxPath(workspaceRoot, jobId), `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export function readControlMessages(filePath, fromLine = 0) {
  if (!fs.existsSync(filePath)) {
    return { messages: [], nextLine: fromLine };
  }

  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  const messages = [];
  for (const line of lines.slice(fromLine)) {
    const parsed = parseJsonLine(line);
    if (parsed && CONTROL_KINDS.has(parsed.kind)) {
      messages.push(parsed);
    }
  }
  return { messages, nextLine: lines.length };
}

/**
 * Poll the inbox for new control messages.
 * Polling (rather than fs.watch) keeps behaviour identical across platforms
 * and network filesystems; steering is delivered on turn boundaries anyway.
 */
export function createInboxWatcher(filePath, onMessage, { intervalMs = 400 } = {}) {
  let cursor = readControlMessages(filePath).nextLine;
  let stopped = false;

  const drain = () => {
    if (stopped) {
      return [];
    }
    const { messages, nextLine } = readControlMessages(filePath, cursor);
    cursor = nextLine;
    for (const message of messages) {
      onMessage(message);
    }
    return messages;
  };

  const timer = setInterval(drain, intervalMs);
  timer.unref?.();

  return {
    drain,
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}
