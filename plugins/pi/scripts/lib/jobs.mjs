import fs from "node:fs";
import process from "node:process";

import { recordJobSafely } from "./db.mjs";
import { wasTruncated } from "./pi.mjs";
import {
  ensureStateDir,
  listJobs,
  listJobsEverywhere,
  nowIso,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  upsertJob,
  writeJobFile
} from "./state.mjs";

export const SESSION_ID_ENV = "PI_COMPANION_SESSION_ID";
export const DEFAULT_MAX_STATUS_JOBS = 8;
const MAX_PROGRESS_LINES = 5;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) =>
    String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? ""))
  );
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  ensureStateDir(workspaceRoot);
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  appendLogLine(logFile, `Starting ${title}.`);
  return logFile;
}

export function appendLogLine(logFile, message) {
  // One event per line keeps the progress preview readable.
  const text = String(message ?? "").replace(/\s*\n\s*/g, " ").trim();
  if (!logFile || !text) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${text}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

/**
 * Progress sink: mirrors events into the job log, the job record and,
 * optionally, stderr so a foreground run shows life.
 */
export function createProgressReporter({ workspaceRoot, jobId, logFile, stderr = false }) {
  let lastPhase = null;
  let lastUsageKey = null;

  return (event) => {
    if (!event) {
      return;
    }
    const message = String(event.message ?? "").trim();
    const phase = event.phase ?? null;

    appendLogLine(logFile, message);
    if (stderr && message) {
      process.stderr.write(`[pi] ${message}\n`);
    }

    // Usage only moves when the model answers, so keying on the counters keeps
    // this to one write per assistant turn instead of one per tool call.
    const usage = event.usage && Object.keys(event.usage).length ? event.usage : null;
    const usageKey = usage ? `${usage.input ?? 0}/${usage.output ?? 0}/${usage.cacheRead ?? 0}` : null;
    const usageChanged = usageKey !== null && usageKey !== lastUsageKey;
    const phaseChanged = Boolean(phase) && phase !== lastPhase;

    if (!phaseChanged && !usageChanged) {
      return;
    }
    if (phaseChanged) {
      lastPhase = phase;
    }
    if (usageChanged) {
      lastUsageKey = usageKey;
    }

    const patch = {
      id: jobId,
      ...(phaseChanged ? { phase } : {}),
      ...(usageChanged ? { usage } : {})
    };
    upsertJob(workspaceRoot, patch);
    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (fs.existsSync(jobFile)) {
      writeJobFile(workspaceRoot, jobId, { ...readJobFile(jobFile), ...patch });
    }
  };
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

export function readJobProgressPreview(logFile, limit = MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }
  try {
    return fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .map(stripLogPrefix)
      .filter(Boolean)
      .slice(-limit);
  } catch {
    return [];
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function formatElapsed(fromIso, toIso = null) {
  const from = Date.parse(fromIso ?? "");
  if (Number.isNaN(from)) {
    return null;
  }
  const to = toIso ? Date.parse(toIso) : Date.now();
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A job whose process disappeared without writing a terminal state is stale;
 * surface it as failed instead of pretending it is still running.
 */
export function enrichJob(job) {
  // `pending` counts too: a detached background start records the job before
  // the child takes over, so a child that dies on startup would otherwise sit
  // as "pending" forever instead of showing up as gone.
  const tracked = job.status === "running" || job.status === "pending";
  const alive = tracked ? processAlive(job.pid) : false;
  const status = tracked && job.pid && !alive ? "orphaned" : job.status;
  return {
    ...job,
    status,
    elapsed: formatElapsed(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    progress: readJobProgressPreview(job.logFile)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  try {
    return readJobFile(jobFile);
  } catch {
    return null;
  }
}

function matchJob(jobs, reference) {
  if (!reference) {
    return null;
  }
  const needle = String(reference).trim();
  return (
    jobs.find((job) => job.id === needle) ??
    jobs.find((job) => job.id.endsWith(needle)) ??
    jobs.find((job) => job.sessionId === needle) ??
    null
  );
}

/**
 * Narrow a job list the way the status flags describe.
 *
 * `--running` is the one that matters for a fleet: with several repositories
 * delegating at once, the answer to "what is still going" was buried under
 * whatever each workspace had finished earlier that day.
 */
export function filterJobs(jobs, { status = null, preset = null, model = null } = {}) {
  const wanted = status ? new Set(String(status).split(",").map((entry) => entry.trim()).filter(Boolean)) : null;
  return jobs.filter((job) => {
    if (wanted && !wanted.has(String(job.status))) {
      return false;
    }
    if (preset && String(job.preset ?? "") !== String(preset)) {
      return false;
    }
    // Substring, because a model is recorded as `provider/model` and nobody
    // wants to type the provider to filter by the model.
    if (model && !String(job.model ?? "").includes(String(model))) {
      return false;
    }
    return true;
  });
}

export function buildStatusSnapshot(
  workspaceRoot,
  { jobId = null, all = false, global: everywhere = false, status = null, preset = null, model = null } = {}
) {
  const source = everywhere ? listJobsEverywhere() : listJobs(workspaceRoot);
  const jobs = sortJobsNewestFirst(source).map(enrichJob);

  if (jobId) {
    const job = matchJob(jobs, jobId);
    if (!job) {
      throw new Error(`No pi job matches "${jobId}".`);
    }
    return { jobs: [job], filtered: false, total: jobs.length, global: everywhere };
  }

  const matching = filterJobs(jobs, { status, preset, model });
  const visible = all ? matching : matching.slice(0, DEFAULT_MAX_STATUS_JOBS);
  return {
    jobs: visible,
    filtered: visible.length < matching.length,
    total: matching.length,
    global: everywhere
  };
}

export function resolveResultJob(workspaceRoot, jobId = null) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).map(enrichJob);
  if (!jobs.length) {
    throw new Error("No pi jobs have been recorded for this workspace yet.");
  }

  if (jobId) {
    const job = matchJob(jobs, jobId);
    if (!job) {
      throw new Error(`No pi job matches "${jobId}".`);
    }
    return { job, stored: readStoredJob(workspaceRoot, job.id) };
  }

  const finished = jobs.find((job) => ["completed", "failed", "cancelled"].includes(job.status));
  if (!finished) {
    const running = jobs[0];
    throw new Error(
      `No finished pi job yet. Job ${running.id} is ${running.status}; check /pi:status for progress.`
    );
  }
  return { job: finished, stored: readStoredJob(workspaceRoot, finished.id) };
}

/**
 * Statuses `cancel` can still act on.
 *
 * `pending` is a background run whose detached child has not taken over yet,
 * and `orphaned` one whose wrapper died with the container still up — both are
 * live from the machine's point of view, and leaving them out meant `cancel`
 * with no argument said "nothing to cancel" while a container kept running and
 * held its slot in the pool.
 */
const CANCELABLE_STATUSES = new Set(["running", "pending", "orphaned"]);

export function isCancelable(job) {
  return CANCELABLE_STATUSES.has(String(job?.status));
}

/** Every job that could be stopped, in this workspace or across all of them. */
export function listCancelableJobs(workspaceRoot, { global: everywhere = false } = {}) {
  const source = everywhere ? listJobsEverywhere() : listJobs(workspaceRoot);
  return sortJobsNewestFirst(source).map(enrichJob).filter(isCancelable);
}

export function resolveCancelableJob(workspaceRoot, jobId = null) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).map(enrichJob);
  const cancelable = jobs.filter(isCancelable);

  if (jobId) {
    const job = matchJob(jobs, jobId);
    if (!job) {
      throw new Error(`No pi job matches "${jobId}".`);
    }
    return job;
  }

  if (!cancelable.length) {
    throw new Error("No running pi job to cancel.");
  }
  if (cancelable.length > 1) {
    throw new Error(
      `Multiple pi jobs are running (${cancelable
        .map((job) => job.id)
        .join(", ")}). Pass the job id you want to cancel.`
    );
  }
  return cancelable[0];
}

export function createJobRecord(base, env = process.env) {
  const sessionId = env[SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { claudeSessionId: sessionId } : {})
  };
}

/**
 * Execute a job while keeping its on-disk record in sync, so /pi:status and
 * /pi:result stay meaningful for background runs and crashes alike.
 */
export async function runTrackedJob(job, runner) {
  const running = {
    ...job,
    status: "running",
    phase: "starting",
    startedAt: nowIso(),
    pid: process.pid
  };
  writeJobFile(job.workspaceRoot, job.id, running);
  upsertJob(job.workspaceRoot, running);
  // The journal is written at the two moments that matter — a run appearing and
  // a run ending — rather than on every progress event: it exists for history,
  // while live status is read from the JSON record.
  recordJobSafely(running);

  try {
    const execution = await runner();
    // A non-zero exit with an answer already produced is not the same failure as
    // a run that produced nothing: opencode-go ends streams without a
    // finish_reason and pi exits non-zero, while the agent has delivered a full
    // response and the tokens are recorded. Counting those as failures put the
    // provider at 0% success in a comparison it had actually completed.
    const delivered = Boolean(String(execution.text ?? "").trim()) || Number(execution.usage?.output ?? 0) > 0;
    // Only a stream that ended without saying why counts as cosmetic. Any other
    // error — a 500 from the provider, a rejected command, a write that failed —
    // is a real failure even if the model had already said something, and
    // recording it as success poisoned exactly the comparisons degraded exists
    // for. External kills (OOM, `sandbox clean`, docker restart) arrive as a
    // signal with no error text, and those stay failures too.
    const cosmetic =
      (execution.errors ?? []).length > 0 &&
      (execution.errors ?? []).every((message) => /finish_reason|stream ended/i.test(String(message)));
    const degraded = execution.exitStatus !== 0 && delivered && cosmetic && !execution.timedOut && !execution.aborted;
    const status = execution.exitStatus === 0 || degraded ? "completed" : execution.aborted ? "cancelled" : "failed";
    // A run whose LAST answer was cut off at the output ceiling has not
    // finished, whatever its exit code says. The truncated response ends mid
    // tool call; the agent discards the call and keeps the text, so the run
    // settles on a sentence of intent — "now let me wire this up" — and exits
    // zero with the work undone. Every such run in one epic's journal reported
    // success: nine of them were genuinely unfinished, and the ones that were
    // caught were caught by hand. A truncation earlier in the run is a
    // different thing — it costs tokens and a retry, and the run goes on —
    // which is why only the last one is judged here.
    //
    // Judged on what the agent itself reported (`wasTruncated` prefers
    // `stopReason`), not on the proxy's tally: the proxy exists only in a
    // sandboxed run, so reading it alone left every unsandboxed run — the
    // default — with a tick on work that stopped mid-sentence.
    const truncated = status === "completed" && wasTruncated(execution);
    const completedAt = nowIso();
    const record = {
      ...running,
      status,
      phase: status === "completed" ? (truncated ? "truncated" : "done") : "failed",
      pid: null,
      completedAt,
      sessionId: execution.sessionId ?? null,
      model: execution.model ?? running.model ?? null,
      usage: execution.usage ?? null,
      // Counters and timings the journal has columns for. Without them the
      // table stored zeroes for every run and could answer nothing about how a
      // model actually behaves — only how many tokens it moved.
      turns: execution.turns ?? 0,
      toolCalls: Array.isArray(execution.toolCalls) ? execution.toolCalls.length : (execution.toolCalls ?? 0),
      toolErrors: execution.toolErrors ?? 0,
      timing: execution.timing ?? null,
      peakContext: execution.peakContext ?? 0,
      thinkingChars: execution.thinkingChars ?? 0,
      // How many times the run continued itself past the output ceiling. A run
      // rescued repeatedly finished, but it says something about the model that
      // a clean run does not.
      recoveredTruncations: execution.recoveredTruncations ?? 0,
      degraded,
      // What the run did to the working tree, measured while it still looked
      // the way the agent left it.
      changes: execution.changes ?? null,
      summary: execution.summary ?? null,
      rendered: execution.rendered ?? null,
      errors: execution.errors ?? []
    };
    writeJobFile(job.workspaceRoot, job.id, record);
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status,
      phase: record.phase,
      pid: null,
      completedAt,
      sessionId: record.sessionId,
      model: record.model,
      summary: record.summary
    });
    // The answer goes to the journal but not into the job file: the rendered
    // report there already contains it, and storing both doubles every record.
    // Same for the proxy roll-up and the slot wait — numbers for the reports,
    // not state anyone reads back from a job file.
    recordJobSafely({
      ...record,
      text: execution.text ?? null,
      proxyStats: execution.proxyStats ?? null,
      slotWaitMs: execution.slotWaitMs ?? 0,
      thinkP50Chars: execution.thinkP50Chars ?? 0,
      thinkMaxChars: execution.thinkMaxChars ?? 0,
      turnsIdle: execution.turnsIdle ?? 0,
      loopNudges: execution.loopNudges ?? 0
    });
    appendLogBlock(job.logFile, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...(readStoredJob(job.workspaceRoot, job.id) ?? running),
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt,
      errorMessage: message
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt,
      errorMessage: message
    });
    recordJobSafely({ ...running, status: "failed", phase: "failed", completedAt, errorMessage: message });
    appendLogLine(job.logFile, `Failed: ${message}`);
    throw error;
  }
}
