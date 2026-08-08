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
 * Terminate a job process and any children it spawned.
 * Sends SIGTERM to the process group first, then escalates to SIGKILL.
 */
export async function terminateProcessTree(pid, { graceMs = 3000 } = {}) {
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

  // Negative pid targets the process group created with detached spawn.
  signal(-pid, "SIGTERM") || signal(pid, "SIGTERM");

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  signal(-pid, "SIGKILL") || signal(pid, "SIGKILL");
  return !processAlive(pid);
}
