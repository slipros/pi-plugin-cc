import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const STATE_VERSION = 1;
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";

/** Name of the machine-wide terminal-event log inside the state root. */
const FLEET_EVENTS_FILE_NAME = "fleet-events.jsonl";
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
  return path.join(stateRoot(), `${slug}-${hash}`);
}

export function resolveJobsDir(workspaceRoot) {
  return path.join(resolveStateDir(workspaceRoot), JOBS_DIR_NAME);
}

/**
 * The directory every workspace bucket lives under.
 *
 * Under the data home rather than the temp directory: transcripts, prompts and
 * event streams are what a finished run is read by, and on a machine that
 * clears `/tmp` on boot they were gone by the next morning — the log of the run
 * that has to be explained is exactly the one no longer there. The journal
 * (`jobs.db`) already lives here, so both halves of a run's history now age out
 * together, by the eviction rule above rather than by a reboot.
 */
function stateRoot() {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  if (dataDir) {
    return path.join(dataDir, "state");
  }
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "pi-plugin", "state");
}

/**
 * The fleet event log: one line per run that reached a terminal state.
 *
 * Deliberately outside the per-workspace buckets. A supervisor watching for
 * "an agent finished" has to hear about every run on the machine, and the
 * bucket is exactly what it cannot be sure of — a `cd` between two Bash calls
 * files the job under a directory the watcher never looks at. One log, one
 * watcher, no bucket to guess.
 */
export function fleetEventsPath() {
  return path.join(stateRoot(), FLEET_EVENTS_FILE_NAME);
}

/**
 * Every job this machine knows about, across workspaces.
 *
 * State is bucketed per workspace so two checkouts never share history, which
 * also means no single command could ever see the whole fleet: a run started
 * from another repository was invisible here, and the only way to find a
 * forgotten background job was to remember where it was launched from. Each
 * record carries its own `workspaceRoot`, so the buckets can be read as one
 * list without losing where each job belongs.
 *
 * Unreadable buckets are skipped rather than fatal — a half-written state file
 * in some other workspace must not break a status call in this one.
 */
export function listJobsEverywhere() {
  const root = stateRoot();
  let buckets = [];
  try {
    buckets = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }

  const jobs = [];
  for (const bucket of buckets) {
    const stateFile = path.join(root, bucket.name, STATE_FILE_NAME);
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      for (const job of Array.isArray(parsed.jobs) ? parsed.jobs : []) {
        jobs.push({ ...job, bucket: bucket.name });
      }
    } catch {
      continue;
    }
  }
  return jobs;
}

/**
 * Job state holds transcripts, prompts and full command lines, and it lives in
 * a world-readable temp directory. 0700 keeps it to its owner; on a shared
 * machine the default 0755 handed all of it to anyone who could `cat`.
 */
const STATE_DIR_MODE = 0o700;

export function ensureStateDir(workspaceRoot) {
  fs.mkdirSync(resolveJobsDir(workspaceRoot), { recursive: true, mode: STATE_DIR_MODE });
  // `mode` only applies to directories this call creates, and umask can trim it
  // further; tightening explicitly also fixes directories made by older
  // versions, which were left readable by everyone on the machine.
  for (const directory of [resolveStateDir(workspaceRoot), resolveJobsDir(workspaceRoot)]) {
    try {
      fs.chmodSync(directory, STATE_DIR_MODE);
    } catch {
      // Not ours to tighten (someone else created it first) — the run goes on.
    }
  }
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
 * The task text handed to a detached background run.
 *
 * A background start re-executes this file in a child whose stdin is closed, so
 * anything the caller piped in exists only in the parent. Writing it here is
 * what carries it across the handoff; the child consumes the file and deletes
 * it, and the eviction sweep clears whatever a killed child left behind.
 */
export function resolvePromptFile(workspaceRoot, jobId) {
  return path.join(resolveJobsDir(workspaceRoot), `${jobId}.prompt.txt`);
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
      removeIfExists(resolvePromptFile(workspaceRoot, job.id));
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
  sweepStaleTemporaries(filePath);
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

  // A holder whose section runs longer than the staleness threshold used to be
  // declared dead and have its lock stolen — eviction over a slow filesystem is
  // enough. Touching the directory while working says "still alive", so only a
  // holder that actually died looks stale.
  const heartbeat = held
    ? setInterval(() => {
        try {
          const now = new Date();
          fs.utimesSync(lockPath, now, now);
        } catch {
          // Lock already gone; nothing to keep alive.
        }
      }, Math.max(200, Math.floor(LOCK_TIMEOUT_MS / 4)))
    : null;
  heartbeat?.unref?.();

  try {
    return fn(held);
  } finally {
    clearInterval(heartbeat ?? undefined);
    if (held) {
      try {
        fs.rmdirSync(lockPath);
      } catch {
        // Already gone: another process reclaimed it as stale.
      }
    }
  }
}

/** Leftovers from a process killed between writing and renaming. */
function sweepStaleTemporaries(filePath) {
  try {
    const dir = path.dirname(filePath);
    const prefix = `${path.basename(filePath)}.`;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) {
        continue;
      }
      const candidate = path.join(dir, entry);
      if (Date.now() - fs.statSync(candidate).mtimeMs > LOCK_TIMEOUT_MS * 10) {
        fs.unlinkSync(candidate);
      }
    }
  } catch {
    // Housekeeping only.
  }
}

export function updateState(workspaceRoot, mutate) {
  ensureStateDir(workspaceRoot);
  return withStateLock(workspaceRoot, (held) => {
    const state = loadState(workspaceRoot);
    mutate(state);
    // Without the lock another writer may be mid-update, and this view of the
    // job list is not authoritative enough to delete anyone's files by. The
    // write still happens — losing a status update is survivable, losing
    // another run's results is not.
    return saveState(workspaceRoot, state, { evict: held });
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
