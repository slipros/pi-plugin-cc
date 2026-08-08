import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function binaryAvailable(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  return runCommand(probe, [command]).status === 0;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Terminate a process and, when it leads its own process group, everything it
 * spawned. Sends SIGTERM first, then escalates to SIGKILL.
 *
 * `group` must only be true for processes started with `detached: true`;
 * otherwise the negative pid would signal the caller's own process group.
 */
export async function terminateProcessTree(pid, { graceMs = 3000, group = false } = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || !processAlive(pid)) {
    return false;
  }

  const signal = (target, name) => {
    try {
      process.kill(target, name);
      return true;
    } catch {
      return false;
    }
  };

  if (!group || !signal(-pid, "SIGTERM")) {
    signal(pid, "SIGTERM");
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!group || !signal(-pid, "SIGKILL")) {
    signal(pid, "SIGKILL");
  }
  return !processAlive(pid);
}
