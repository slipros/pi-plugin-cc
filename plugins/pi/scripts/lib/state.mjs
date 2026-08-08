import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const STATE_VERSION = 1;
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

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

export function loadState(workspaceRoot) {
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return { version: STATE_VERSION, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] };
  } catch {
    return defaultState();
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

export function saveState(workspaceRoot, state) {
  const previousJobs = loadState(workspaceRoot).jobs;
  ensureStateDir(workspaceRoot);

  const jobs = [...(state.jobs ?? [])]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);

  const retained = new Set(jobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retained.has(job.id)) {
      continue;
    }
    removeIfExists(resolveJobFile(workspaceRoot, job.id));
    removeIfExists(job.logFile);
  }

  const next = { version: STATE_VERSION, jobs };
  fs.writeFileSync(resolveStateFile(workspaceRoot), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function updateState(workspaceRoot, mutate) {
  const state = loadState(workspaceRoot);
  mutate(state);
  return saveState(workspaceRoot, state);
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
