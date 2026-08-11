import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

import { createInboxWatcher } from "./inbox.mjs";
import { attachJsonlReader, parseJsonLine } from "./jsonl.mjs";
import { applyPiEvent, buildPiArgs, createTurnState, PI_BINARY, redactArgs, summarizeTiming } from "./pi.mjs";
import { awaitSandboxSlot, isSandboxed, removeSandboxContainer, resolveLaunch } from "./sandbox.mjs";

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
  sandbox = null,
  jobId = null,
  ...options
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("Refusing to start pi with an empty prompt.");
  }

  const piArgs = buildPiArgs({ ...options, mode: "rpc" });
  // A profile may cap how many of its containers run at once, because the
  // provider behind it caps sessions. Queue here, before the container is
  // started, so the wait costs time instead of a failed run.
  const slot = await awaitSandboxSlot(sandbox, { timeoutMs, onProgress });
  const launch = resolveLaunch({ sandbox, binary: PI_BINARY, piArgs, cwd, jobId, env });
  const state = createTurnState();
  const report = (event) => {
    if (event && onProgress) {
      onProgress(event);
    }
  };

  report({ phase: "starting", message: `Running ${launch.command} ${redactArgs(launch.args)}` });

  const child = spawn(launch.command, launch.args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });
  onSpawn?.({ pid: child.pid ?? null, containerName: launch.containerName });
  // The container exists now, so docker ps can see it and the reservation
  // that covered the gap is no longer needed.
  slot.release?.();

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
      // pi stamps a message with the time it was created, which makes
      // message_start and message_end carry the same value; the arrival time is
      // the only thing in the journal that can date an event afterwards.
      fs.appendFileSync(eventsFile, `${JSON.stringify({ ...event, receivedAt: Date.now() })}\n`, "utf8");
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
      if (event.command === "get_state" && event.data) {
        if (event.data.sessionId) {
          state.sessionId = String(event.data.sessionId);
        }
        // The effective thinking level, which is what pi resolved from flags,
        // settings and the model — not necessarily what the caller asked for.
        if (event.data.thinkingLevel) {
          state.thinkingLevel = String(event.data.thinkingLevel);
        }
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

    const update = applyPiEvent(state, event);
    // The accumulated usage rides along with every progress event, so a job
    // that is still running can report what it has spent so far — until now
    // the number only existed in this process and landed on disk at the end.
    report(update ? { ...update, usage: state.usage } : null);
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  // A spawn failure is a normal outcome here, not an exception to propagate: it
  // resolves like any other bad exit so the job gets a terminal record. Left as
  // a rejection it became an unhandled one — the waiter below only attaches a
  // fulfilment handler — and the process died with the job stuck at "running".
  let spawnError = null;
  const closed = new Promise((resolve) => {
    child.on("error", (error) => {
      spawnError = error;
      resolve(1);
    });
    child.on("close", (code, signal) => resolve(code == null ? (signal ? 1 : 0) : code));
  });

  // Writing the prompt can fail after the fact if pi exits first (EPIPE on a
  // 200KB review diff, for instance). Without a handler that is an unhandled
  // 'error' event on the socket, which takes the whole process down.
  child.stdin.on("error", (error) => {
    if (!closing) {
      state.errors.push(`Could not write to pi: ${error.message}`);
    }
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

  // Killing the `docker run` client leaves the container running, so a
  // sandboxed job has to be stopped on the docker side as well.
  const stop = () => {
    killTree(child);
    if (isSandboxed(sandbox)) {
      removeSandboxContainer(launch.containerName);
    }
  };

  let timedOut = false;
  const hardTimer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, timeoutMs)
      : null;

  // Close the session once pi has settled and nothing new arrived in the
  // grace window; an abort short-circuits the wait.
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      // A process that never started has nothing to settle: waiting for the
      // grace window would burn the whole timeout before reporting the failure.
      if (spawnError) {
        clearInterval(poll);
        resolve();
        return;
      }
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
        stop();
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
  if (spawnError) {
    errors.push(`Could not start ${launch.command}: ${spawnError.message}`);
  }
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
    turns: state.turns,
    toolCalls: state.toolCalls,
    toolErrors: state.toolErrors,
    timing: summarizeTiming(state.timing),
    peakContext: state.peakContext ?? 0,
    thinkingChars: state.thinkingChars ?? 0,
    queue: state.queue,
    steering: delivered,
    aborted,
    thinkingLevel: state.thinkingLevel ?? null,
    exitStatus: errors.length ? 1 : (exitStatus ?? 0),
    stderr: stderr.trim(),
    errors,
    timedOut,
    closing,
    containerName: launch.containerName,
    command: `${launch.command} ${redactArgs(launch.args)}`
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
