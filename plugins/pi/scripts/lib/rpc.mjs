import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

import { createInboxWatcher } from "./inbox.mjs";
import { attachJsonlReader, parseJsonLine } from "./jsonl.mjs";
import { applyPiEvent, buildPiArgs, createTurnState, PI_BINARY, redactArgs } from "./pi.mjs";

const SETTLE_GRACE_MS = 1500;
const SHUTDOWN_GRACE_MS = 5000;

/**
 * Run one job against a live `pi --mode rpc` session.
 *
 * Unlike the one-shot json mode, the process stays up for the whole job, which
 * is what makes mid-flight steering possible: control messages appended to the
 * job inbox are forwarded as `steer` / `follow_up` / `abort` commands.
 */
export async function runPiRpcTurn({
  cwd,
  prompt,
  timeoutMs = 1_800_000,
  onProgress = null,
  onSpawn = null,
  eventsFile = null,
  inboxFile = null,
  settleGraceMs = SETTLE_GRACE_MS,
  env = process.env,
  ...options
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("Refusing to start pi with an empty prompt.");
  }

  const args = buildPiArgs({ ...options, mode: "rpc" });
  const state = createTurnState();
  const report = (event) => {
    if (event && onProgress) {
      onProgress(event);
    }
  };

  report({ phase: "starting", message: `Running ${PI_BINARY} ${redactArgs(args)}` });

  const child = spawn(PI_BINARY, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });
  onSpawn?.(child.pid ?? null);

  let stderr = "";
  let settledAt = null;
  let aborted = false;
  let closing = false;
  let lastControlAt = 0;
  const delivered = [];

  const send = (command) => {
    if (child.stdin.destroyed || child.stdin.writableEnded) {
      return false;
    }
    child.stdin.write(`${JSON.stringify(command)}\n`);
    return true;
  };

  const appendEvent = (event) => {
    if (!eventsFile) {
      return;
    }
    try {
      fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, "utf8");
    } catch {
      // A broken transcript must never take the job down.
    }
  };

  attachJsonlReader(child.stdout, (line) => {
    const event = parseJsonLine(line);
    if (!event) {
      return;
    }

    if (event.type === "response") {
      if (event.command === "get_state" && event.data?.sessionId) {
        state.sessionId = String(event.data.sessionId);
      }
      if (event.success === false) {
        const detail = event.error ?? event.message ?? "unknown error";
        state.errors.push(`pi rejected "${event.command}": ${detail}`);
        report({ phase: "working", message: `pi rejected ${event.command}: ${detail}` });
      }
      return;
    }

    appendEvent(event);

    if (event.type === "agent_settled") {
      settledAt = Date.now();
    } else if (event.type === "agent_start" || event.type === "turn_start") {
      settledAt = null;
    }

    report(applyPiEvent(state, event));
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const closed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve(code == null ? (signal ? 1 : 0) : code));
  });

  send({ type: "get_state", id: "state-1" });
  send({ type: "prompt", message: String(prompt), id: "prompt-1" });

  /**
   * A control message that arrives while pi is working is steering; one that
   * arrives in the settle window re-opens the run as a new prompt, which is
   * what "nudge the agent" means once it has already stopped.
   */
  const handleControl = (entry) => {
    lastControlAt = Date.now();

    if (entry.kind === "abort") {
      aborted = true;
      send({ type: "abort" });
      report({ phase: "working", message: "Abort requested; stopping pi." });
      delivered.push({ ...entry, deliveredAs: "abort" });
      return;
    }

    const isSettled = settledAt !== null;
    const command = isSettled
      ? { type: "prompt", message: entry.message, id: entry.id }
      : entry.kind === "follow_up"
        ? { type: "follow_up", message: entry.message }
        : { type: "steer", message: entry.message };

    if (send(command)) {
      settledAt = null;
      delivered.push({ ...entry, deliveredAs: command.type });
      report({
        phase: "working",
        message: `Delivered ${command.type}: ${entry.message.slice(0, 120)}`
      });
    }
  };

  const inbox = inboxFile ? createInboxWatcher(inboxFile, handleControl) : null;

  let timedOut = false;
  const hardTimer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timeoutMs)
      : null;

  // Close the session once pi has settled and nothing new arrived in the
  // grace window; an abort short-circuits the wait.
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      inbox?.drain();
      const quietFor = Date.now() - Math.max(settledAt ?? 0, lastControlAt);
      if (settledAt !== null && (aborted || quietFor >= settleGraceMs)) {
        clearInterval(poll);
        resolve();
      }
    }, 200);
    poll.unref?.();

    closed.then(() => {
      clearInterval(poll);
      resolve();
    });
  });

  closing = true;
  inbox?.stop();

  if (!child.killed) {
    try {
      child.stdin.end();
    } catch {
      // Already gone.
    }
  }

  const exitStatus = await Promise.race([
    closed,
    new Promise((resolve) =>
      setTimeout(() => {
        killTree(child);
        resolve(closed);
      }, SHUTDOWN_GRACE_MS).unref?.()
    )
  ]).catch((error) => {
    throw error;
  });

  if (hardTimer) {
    clearTimeout(hardTimer);
  }

  const text = state.assistantTexts.at(-1) ?? "";
  const errors = [...state.errors];
  if (timedOut) {
    errors.push(`pi exceeded the ${Math.round(timeoutMs / 1000)}s timeout and was terminated.`);
  }
  if (aborted) {
    errors.push("The run was aborted before pi finished.");
  }
  if (!text && !errors.length) {
    errors.push("pi produced no assistant output.");
  }
  if (stderr.trim() && (errors.length || exitStatus !== 0)) {
    errors.push(stderr.trim());
  }

  return {
    text,
    sessionId: state.sessionId,
    usage: state.usage,
    model: state.model,
    stopReason: state.stopReason,
    toolCalls: state.toolCalls,
    toolErrors: state.toolErrors,
    queue: state.queue,
    steering: delivered,
    aborted,
    exitStatus: errors.length ? 1 : (exitStatus ?? 0),
    stderr: stderr.trim(),
    errors,
    timedOut,
    closing,
    command: `${PI_BINARY} ${redactArgs(args)}`
  };
}

function killTree(child) {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
