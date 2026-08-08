import fs from "node:fs";
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
