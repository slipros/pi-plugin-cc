import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const STATE_VERSION = 1;
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
/** Bounds on the state lock: long enough for a slow disk, short enough to not stall a run. */
const LOCK_TIMEOUT_MS = 2000;
const LOCK_POLL_MS = 15;

export function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return { version: STATE_VERSION, jobs: [] };
}

/**
 * Job state lives outside the user's repository, bucketed per workspace so two
 * checkouts of the same project never share job history.
 */
export function resolveStateDir(workspaceRoot) {
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonical = workspaceRoot;
  }

  const slug =
    (path.basename(workspaceRoot) || "workspace")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  const stateRoot = dataDir ? path.join(dataDir, "state") : path.join(os.tmpdir(), "pi-companion");
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveJobsDir(workspaceRoot) {
  return path.join(resolveStateDir(workspaceRoot), JOBS_DIR_NAME);
}

export function ensureStateDir(workspaceRoot) {
  fs.mkdirSync(resolveJobsDir(workspaceRoot), { recursive: true });
}

export function resolveStateFile(workspaceRoot) {
  return path.join(resolveStateDir(workspaceRoot), STATE_FILE_NAME);
}

export function resolveJobFile(workspaceRoot, jobId) {
  return path.join(resolveJobsDir(workspaceRoot), `${jobId}.json`);
}

export function resolveJobLogFile(workspaceRoot, jobId) {
  return path.join(resolveJobsDir(workspaceRoot), `${jobId}.log`);
}

/**
 * Where a detached background run sends its own stdout and stderr. Separate
 * from the job log: this file holds whatever the process says before (or
 * instead of) becoming a tracked job, which is exactly what has to be readable
 * when a background start fails.
 */
export function resolveDetachedLogFile(workspaceRoot, jobId) {
  return path.join(resolveJobsDir(workspaceRoot), `${jobId}.detached.log`);
}

/** Raw pi event stream for a job, replayed by `watch`. */
export function eventsPath(workspaceRoot, jobId) {
  return path.join(resolveJobsDir(workspaceRoot), `${jobId}.events.jsonl`);
}

/**
 * Read the job list.
 *
 * `readable: false` means the file exists but could not be parsed — which is
 * not the same as "there are no jobs", and the difference matters: treating a
 * half-written file as an empty list is what made a concurrent writer delete
 * every other job's results.
 */
export function loadState(workspaceRoot) {
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return { ...defaultState(), readable: true };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return { version: STATE_VERSION, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [], readable: true };
  } catch {
    return { ...defaultState(), readable: false };
  }
}

function removeIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best effort cleanup; a stale artifact must never break a command.
    }
  }
}

export function saveState(workspaceRoot, state, { evict = true } = {}) {
  const previous = loadState(workspaceRoot);
  ensureStateDir(workspaceRoot);

  const jobs = [...(state.jobs ?? [])]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);

  // Evicting means deleting another job's results, so it only happens when the
  // list it is compared against was read intact and the write is not a partial
  // view. A caller that could not read the previous state skips eviction: the
  // worst case is a stale file left behind, against losing a live job's output.
  if (evict && previous.readable) {
    const retained = new Set(jobs.map((job) => job.id));
    for (const job of previous.jobs) {
      if (retained.has(job.id)) {
        continue;
      }
      removeIfExists(resolveJobFile(workspaceRoot, job.id));
      removeIfExists(job.logFile);
      removeIfExists(resolveDetachedLogFile(workspaceRoot, job.id));
      removeIfExists(eventsPath(workspaceRoot, job.id));
      removeIfExists(inboxPathFor(workspaceRoot, job.id));
    }
  }

  const next = { version: STATE_VERSION, jobs };
  writeFileAtomic(resolveStateFile(workspaceRoot), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Companion file of a job, named the way lib/inbox.mjs expects it. */
function inboxPathFor(workspaceRoot, jobId) {
  return path.join(resolveJobsDir(workspaceRoot), `${jobId}.inbox.jsonl`);
}

/**
 * Write through a temporary file in the same directory, then rename.
 *
 * `writeFileSync` truncates first, so a reader that arrives mid-write sees a
 * broken file; rename is atomic, so it sees either the old content or the new.
 */
function writeFileAtomic(filePath, contents) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, "utf8");
    fs.renameSync(temporary, filePath);
  } catch (error) {
    removeIfExists(temporary);
    throw error;
  }
}

/** Sleep without going async: every state write is on a synchronous path. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding the state lock.
 *
 * `mkdir` is atomic on every platform that matters, which makes it the cheapest
 * mutex available to a short-lived CLI process. Waiting is bounded and failure
 * to acquire is not fatal: a background run must not die because a sibling is
 * writing. Without the lock, two processes read-modify-write the same file and
 * the slower one silently drops whatever the faster one added.
 */
function withStateLock(workspaceRoot, fn) {
  const lockPath = `${resolveStateFile(workspaceRoot)}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let held = false;

  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockPath);
      held = true;
      break;
    } catch {
      // A lock older than the timeout belonged to a process that died holding
      // it; nothing else would keep it that long.
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > LOCK_TIMEOUT_MS) {
          fs.rmdirSync(lockPath);
          continue;
        }
      } catch {
        // The holder released it between our attempt and this check.
      }
      sleepSync(LOCK_POLL_MS);
    }
  }

  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.rmdirSync(lockPath);
      } catch {
        // Already gone: another process reclaimed it as stale.
      }
    }
  }
}

export function updateState(workspaceRoot, mutate) {
  ensureStateDir(workspaceRoot);
  return withStateLock(workspaceRoot, () => {
    const state = loadState(workspaceRoot);
    mutate(state);
    return saveState(workspaceRoot, state);
  });
}

export function upsertJob(workspaceRoot, patch) {
  return updateState(workspaceRoot, (state) => {
    const timestamp = nowIso();
    const index = state.jobs.findIndex((job) => job.id === patch.id);
    if (index === -1) {
      state.jobs.unshift({ createdAt: timestamp, updatedAt: timestamp, ...patch });
      return;
    }
    state.jobs[index] = { ...state.jobs[index], ...patch, updatedAt: timestamp };
  });
}

export function listJobs(workspaceRoot) {
  return loadState(workspaceRoot).jobs;
}

export function generateJobId(prefix = "pi") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function writeJobFile(workspaceRoot, jobId, payload) {
  ensureStateDir(workspaceRoot);
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}
