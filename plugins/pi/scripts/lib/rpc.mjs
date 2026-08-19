import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { budgetExceeded } from "./budget.mjs";
import { createInboxWatcher } from "./inbox.mjs";
import { attachJsonlReader, parseJsonLine } from "./jsonl.mjs";
import { runCommand } from "./process.mjs";
import {
  applyPiEvent,
  buildPiArgs,
  CONTINUATION_PROMPT,
  createTurnState,
  PI_BINARY,
  redactArgs,
  summarizeTiming,
  truncationRetryLimit
} from "./pi.mjs";
import { MASKED_MODEL, MASKED_PROVIDER, startCredentialProxy } from "./credential-proxy.mjs";
import { openGitProxy, withGitProxy } from "./git-proxy.mjs";
import { settleProxyPorts } from "./proxy-bind.mjs";
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
/**
 * Bring up the credential proxy for a sandboxed run, if the provider allows it.
 *
 * Never fatal: a proxy that cannot start means the run proceeds the old way,
 * with the provider's own credential mounted, rather than not running at all.
 */
/** Provider the run really used, for records that must not show the mask. */
function proxyProviderOf(sandbox) {
  return sandbox?.provider ?? "unknown";
}

async function openCredentialProxy(sandbox, onProgress, model, jobId = null) {
  // `proxyCredentials: false` in a profile opts out — for a provider whose
  // endpoint does something the plain forwarder here does not reproduce.
  if (!isSandboxed(sandbox) || !sandbox.auth || !sandbox.provider || sandbox.proxyCredentials === false) {
    return null;
  }
  try {
    const homeDir = os.homedir();
    const auth = JSON.parse(fs.readFileSync(path.join(homeDir, ".pi", "agent", "auth.json"), "utf8"));
    const proxy = await startCredentialProxy({
      homeDir,
      provider: sandbox.provider,
      model,
      authEntry: auth?.[sandbox.provider],
      onWarning: (message) => onProgress?.({ phase: "working", message }),
      // Ties the per-request telemetry to the run; without it the proxy
      // measures nothing rather than writing rows nothing can be joined to.
      jobId
    });
    if (proxy) {
      onProgress?.({ phase: "starting", message: `Credentials stay on the host: ${sandbox.provider} goes through a run-scoped proxy.` });
    }
    if (!proxy) {
      // Falling back means the provider's own credential goes into the
      // container. That is a downgrade of the boundary and has to be audible,
      // not a silent difference between two runs that look identical.
      onProgress?.({
        phase: "starting",
        message: `Credential proxy unavailable for ${sandbox.provider}; mounting that provider's credential instead.`
      });
    }
    return proxy;
  } catch (error) {
    onProgress?.({
      phase: "starting",
      message: `Credential proxy could not start (${error instanceof Error ? error.message : String(error)}); falling back to mounting credentials.`
    });
    return null;
  }
}

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
  budget = null,
  ...options
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("Refusing to start pi with an empty prompt.");
  }
  const truncationRetries = truncationRetryLimit(env);

  // A profile may cap how many of its containers run at once, because the
  // provider behind it caps sessions. Queue here, before the container is
  // started, so the wait costs time instead of a failed run.
  // Credentials stay on the host: the container gets a token for a proxy that
  // lives exactly as long as this run. Falls back to the previous behaviour for
  // providers whose endpoint cannot be resolved.
  const proxy = await openCredentialProxy(sandbox, onProgress, options.model ?? null, jobId);
  if (proxy) {
    sandbox = {
      ...sandbox,
      credentialProxy: { url: proxy.url, token: proxy.token, providerEntry: proxy.providerEntry }
    };
    // pi is told to use the masked names; the proxy maps them back. Reported
    // usage still names the real model, which is what the journal records.
    options = { ...options, provider: MASKED_PROVIDER, model: MASKED_MODEL };
  }
  // Same bargain for forge credentials: the container gets a run token and a
  // loopback URL, and the token that can read the repositories stays here.
  const gitProxy = await openGitProxy(sandbox, onProgress);
  sandbox = withGitProxy(sandbox, gitProxy);
  // Both proxies bind loopback, and the hop that carries the container's
  // connections there needs a moment to notice them.
  // Registered the moment both exist, because everything between here and the
  // end of the run can throw: a queue that gives up waiting for a slot, a
  // container that fails to spawn, a budget that stops the turn. Any of those
  // used to leave the listener alive with a live forge token behind it.
  const closeProxies = async () => {
    // Read before close, reported to the run header: a push the agent tried is
    // otherwise invisible — it fails inside the container and the host only sees
    // a 403 count that goes nowhere. Same for a run token someone else probed.
    const git = gitProxy?.stats?.();
    if (git && (git.blocked || git.rejected)) {
      const parts = [];
      if (git.blocked) parts.push(`${git.blocked} push/dumb-http request(s) refused`);
      if (git.rejected) parts.push(`${git.rejected} request(s) with a wrong run token`);
      onProgress?.({ phase: "working", message: `Git proxy blocked ${parts.join(", ")}.` });
    }
    await proxy?.close();
    await gitProxy?.close();
  };
  await settleProxyPorts(proxy, gitProxy);
  const piArgs = buildPiArgs({ ...options, mode: "rpc" });
  // The body runs inside a closure so the proxies are closed on every exit
  // from here on, not only the one that reaches the end: a slot wait that
  // gives up, a container that fails to spawn and a rejected turn all used to
  // leave a listener alive with a live forge token behind it.
  const runTurn = async () => {
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
    // `spawn` returns before the docker client has even exec'd, so releasing here
    // would restore the very race the reservation exists for. The reservation
    // expires on its own; releasing it early is only an optimisation, and it can
    // wait until the container is actually visible.
    const releaseSlotWhenVisible = () => {
      if (!launch.containerName) {
        slot.release?.();
        return;
      }
      const deadline = Date.now() + 15_000;
      const poll = setInterval(() => {
        const visible = runCommand("docker", ["ps", "--filter", `name=${launch.containerName}`, "--format", "{{.Names}}"]);
        if (Date.now() >= deadline || String(visible.stdout ?? "").includes(launch.containerName)) {
          clearInterval(poll);
          slot.release?.();
        }
      }, 500);
      poll.unref?.();
    };
    releaseSlotWhenVisible();

    let stderr = "";
    let settledAt = null;
    let aborted = false;
    let budgetStop = null;
    let closing = false;
    let lastControlAt = 0;
    // Recovery after an answer cut off at the output ceiling. The failure is not
    // cosmetic: the truncated answer loses its tool call, so if that was the
    // last turn the agent stops mid-work and the run still exits successfully.
    // Everything needed to carry on is already here — this is the live channel
    // of that very session — so the run asks itself to continue instead of
    // ending and waiting for someone to notice.
    let lastStopReason = null;
    let recoveries = 0;
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

      if (event.type === "message_end" && event.message?.role === "assistant") {
        lastStopReason = event.message.stopReason ?? null;
      }

      if (event.type === "agent_settled") {
        settledAt = Date.now();
        // Bounded on purpose: a model stuck repeating itself hits the ceiling
        // every time, and each attempt costs a full ceiling of tokens. When the
        // attempts run out the run ends as truncated, which is what the job
        // phase and its warning icon are for.
        if (lastStopReason === "length" && recoveries < truncationRetries && !closing && !aborted && !budgetStop) {
          recoveries += 1;
          report({
            phase: "working",
            message: `Ответ обрезан на потолке вывода — работа не доведена. Продолжаю сессию (попытка ${recoveries} из ${truncationRetries}).`
          });
          if (send({ type: "prompt", message: CONTINUATION_PROMPT, id: `recover-${recoveries}` })) {
            lastStopReason = null;
            settledAt = null;
          }
        }
      } else if (event.type === "agent_start" || event.type === "turn_start") {
        settledAt = null;
      }

      const update = applyPiEvent(state, event);
      // The accumulated usage rides along with every progress event, so a job
      // that is still running can report what it has spent so far — until now
      // the number only existed in this process and landed on disk at the end.
      report(update ? { ...update, usage: state.usage } : null);

      // Checked on the same numbers the caller sees, right after they change: the
      // ceiling can only be enforced once the message that crossed it is paid for,
      // so the earliest useful moment is here. `abort` is the same command
      // steering uses — pi wraps up the turn instead of being killed, which keeps
      // whatever the agent has already produced.
      if (!budgetStop && !aborted) {
        const exceeded = budgetExceeded(budget, { usage: state.usage, turns: state.turns });
        if (exceeded) {
          budgetStop = exceeded;
          send({ type: "abort" });
          report({ phase: "working", message: `Budget reached: ${exceeded}. Stopping pi.` });
        }
      }
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
        if (settledAt !== null && (aborted || budgetStop || quietFor >= settleGraceMs)) {
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
    if (budgetStop) {
      errors.push(`Stopped by the run budget: ${budgetStop}.`);
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
      stopReason: state.stopReason,
      // The agent was told a masked name, so its reported model is that mask.
      // Statistics are about what actually answered, and only the host knows it.
      model: proxy?.realModel ? `${proxyProviderOf(sandbox)}/${proxy.realModel}` : state.model,
      turns: state.turns,
      toolCalls: state.toolCalls,
      toolErrors: state.toolErrors,
      timing: summarizeTiming(state.timing),
      peakContext: state.peakContext ?? 0,
      thinkingChars: state.thinkingChars ?? 0,
      // Already measured by the slot queue and thrown away until now: the time
      // this run spent waiting for a container of its own pool, which is time no
      // model spent working.
      slotWaitMs: slot.waitedMs ?? 0,
      // Per-request telemetry the proxy collected, rolled up for the job row.
      proxyStats: proxy?.stats?.() ?? null,
      queue: state.queue,
      steering: delivered,
      aborted,
      budgetStop,
      thinkingLevel: state.thinkingLevel ?? null,
      exitStatus: errors.length ? 1 : (exitStatus ?? 0),
      stderr: stderr.trim(),
      errors,
      timedOut,
      closing,
      containerName: launch.containerName,
      command: `${launch.command} ${redactArgs(launch.args)}`
    };
  };

  try {
    return await runTurn();
  } finally {
    await closeProxies();
  }
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
