import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { runCommand } from "./process.mjs";

/**
 * Resolve the directory that identifies the current workspace.
 * Git repositories are keyed by their root so jobs started from a
 * subdirectory land in the same state bucket.
 */
export function resolveWorkspaceRoot(cwd = process.cwd()) {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.status === 0) {
    const root = result.stdout.trim();
    if (root && fs.existsSync(root)) {
      return path.resolve(root);
    }
  }
  return path.resolve(cwd);
}

/**
 * Resolve where the pi agent actually runs.
 *
 * Two directories are involved in a run and `--cwd` splits them: the workspace
 * that owns the job records stays where the command was typed, so `status` and
 * `watch` keep finding the job, while the agent's own working directory — the
 * one bind mounted into a sandbox and the one git commands see — moves.
 *
 * A missing directory is an error rather than a silently created one: the
 * common cause is a typo, and starting an agent in the wrong tree is worse
 * than not starting it.
 */
export function resolveRunRoot(target, { cwd = process.cwd() } = {}) {
  if (!target) {
    return resolveWorkspaceRoot(cwd);
  }
  const resolved = path.resolve(cwd, String(target).replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(resolved)) {
    throw new Error(`--cwd ${target}: no such directory (${resolved}).`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`--cwd ${target}: not a directory (${resolved}).`);
  }
  return resolveWorkspaceRoot(resolved);
}
