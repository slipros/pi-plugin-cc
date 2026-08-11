import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * The "your run is done" hook.
 *
 * A background run outlives the turn that started it, and until now nothing
 * announced its end: the answer sat in a job record until somebody thought to
 * ask. `onFinish` is a shell command the host runs once the job reaches a
 * terminal state — a desktop notification, a message into a queue, a script
 * that opens the result.
 *
 * It runs on the host with the caller's permissions, which is why it may only
 * come from the user config or a command-line flag. `config.mjs` strips it from
 * a project layer: a repository (or the sandboxed agent editing that
 * repository through the mounted workspace) must never be able to install one.
 */

/** Seconds a hook may take before it is treated as stuck and killed. */
const HOOK_TIMEOUT_MS = 10_000;

/** Job facts a hook can read. Values are strings; absent ones are left unset. */
export function hookEnvironment(job = {}) {
  const entries = {
    PI_JOB_ID: job.id,
    PI_JOB_KIND: job.kind,
    PI_JOB_STATUS: job.status,
    PI_JOB_TITLE: job.title,
    PI_JOB_WORKSPACE: job.workspaceRoot,
    PI_JOB_RUN_ROOT: job.runRoot,
    PI_JOB_MODEL: job.model,
    PI_JOB_SUMMARY: job.summary,
    PI_JOB_ELAPSED: job.elapsed,
    PI_JOB_LOG: job.logFile
  };
  return Object.fromEntries(
    Object.entries(entries)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => [key, String(value)])
  );
}

/**
 * Run the hook and report what happened.
 *
 * Never throws: the run is already over and its result is already on disk, so a
 * broken hook is worth a line in the log and nothing more. The command is
 * passed to a shell on purpose — it is the user's own line from their own
 * config, and `PI_JOB_* ` variables are what make it useful.
 *
 * @returns {{ran: boolean, status?: number, timedOut?: boolean, error?: string}}
 */
export function runFinishHook(command, job = {}, { env = process.env, timeoutMs = HOOK_TIMEOUT_MS } = {}) {
  const line = String(command ?? "").trim();
  if (!line) {
    return { ran: false };
  }
  try {
    const result = spawnSync(line, {
      shell: true,
      timeout: timeoutMs,
      env: { ...env, ...hookEnvironment(job) },
      encoding: "utf8",
      // The hook's own output does not belong in the report the caller reads;
      // it is captured so a failing hook can say why.
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.error) {
      return { ran: true, error: result.error.message, timedOut: result.error.code === "ETIMEDOUT" };
    }
    return {
      ran: true,
      status: result.status ?? 0,
      ...(result.status ? { error: String(result.stderr ?? "").trim().slice(0, 500) } : {})
    };
  } catch (error) {
    return { ran: true, error: error instanceof Error ? error.message : String(error) };
  }
}
