import { runCommand } from "./process.mjs";

const DEFAULT_MAX_CONTEXT_BYTES = 200_000;

function git(cwd, args) {
  return runCommand("git", args, { cwd });
}

function gitOutput(cwd, args) {
  const result = git(cwd, args);
  return result.status === 0 ? result.stdout : "";
}

export function ensureGitRepository(cwd) {
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"]).status !== 0) {
    throw new Error("This command needs to run inside a git repository.");
  }
}

export function getCurrentBranch(cwd) {
  return gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim() || "HEAD";
}

export function detectDefaultBranch(cwd) {
  const symbolic = gitOutput(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).trim();
  if (symbolic) {
    const name = symbolic.split("/").pop();
    if (name) {
      return `origin/${name}`;
    }
  }
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (git(cwd, ["rev-parse", "--verify", "--quiet", candidate]).status === 0) {
      return candidate;
    }
  }
  return null;
}

export function getWorkingTreeState(cwd) {
  const status = gitOutput(cwd, ["status", "--short", "--untracked-files=all"]).trim();
  const staged = gitOutput(cwd, ["diff", "--shortstat", "--cached"]).trim();
  const unstaged = gitOutput(cwd, ["diff", "--shortstat"]).trim();
  return { status, staged, unstaged, dirty: Boolean(status) };
}

/**
 * Decide what a review should look at.
 *
 * scope=auto reviews the working tree when it is dirty and falls back to the
 * branch diff against the default branch otherwise.
 */
export function resolveReviewTarget(cwd, { scope = "auto", base = null } = {}) {
  const workingTree = getWorkingTreeState(cwd);
  const branch = getCurrentBranch(cwd);

  if (scope === "working-tree" || (scope === "auto" && !base && workingTree.dirty)) {
    if (!workingTree.dirty) {
      throw new Error("The working tree is clean. Use --base <ref> to review a branch instead.");
    }
    return { scope: "working-tree", base: null, branch, description: "uncommitted working-tree changes" };
  }

  const resolvedBase = base ?? detectDefaultBranch(cwd);
  if (!resolvedBase) {
    throw new Error(
      "Could not determine a base branch. Pass --base <ref> or make some changes in the working tree."
    );
  }
  if (git(cwd, ["rev-parse", "--verify", "--quiet", resolvedBase]).status !== 0) {
    throw new Error(`Base ref "${resolvedBase}" does not exist.`);
  }

  const diffStat = gitOutput(cwd, ["diff", "--shortstat", `${resolvedBase}...HEAD`]).trim();
  if (!diffStat && !workingTree.dirty) {
    throw new Error(`No changes between ${resolvedBase} and HEAD, and the working tree is clean.`);
  }

  return {
    scope: "branch",
    base: resolvedBase,
    branch,
    description: `changes on ${branch} compared to ${resolvedBase}`
  };
}

function truncate(text, limit) {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, limit)}\n\n[... truncated, ${text.length - limit} more bytes ...]`,
    truncated: true
  };
}

function section(title, body) {
  const trimmed = String(body ?? "").trim();
  return trimmed ? `## ${title}\n\n\`\`\`\n${trimmed}\n\`\`\`` : null;
}

function listUntrackedFiles(cwd) {
  return gitOutput(cwd, ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Build the diff context handed to the reviewing agent.
 * Read-only agents cannot run git themselves, so the diff travels in the prompt.
 */
export function collectReviewContext(cwd, target, { maxBytes = DEFAULT_MAX_CONTEXT_BYTES } = {}) {
  const parts = [];

  if (target.scope === "working-tree") {
    const workingTree = getWorkingTreeState(cwd);
    parts.push(section("git status", workingTree.status));
    parts.push(section("Staged diff (git diff --cached)", gitOutput(cwd, ["diff", "--cached"])));
    parts.push(section("Unstaged diff (git diff)", gitOutput(cwd, ["diff"])));

    const untracked = listUntrackedFiles(cwd);
    if (untracked.length) {
      parts.push(section("Untracked files", untracked.join("\n")));
    }
  } else {
    parts.push(
      section("Commits", gitOutput(cwd, ["log", "--oneline", "--no-decorate", `${target.base}..HEAD`]))
    );
    parts.push(section("Diff stat", gitOutput(cwd, ["diff", "--stat", `${target.base}...HEAD`])));
    parts.push(section("Diff", gitOutput(cwd, ["diff", `${target.base}...HEAD`])));

    const workingTree = getWorkingTreeState(cwd);
    if (workingTree.dirty) {
      parts.push(section("Additional uncommitted changes", workingTree.status));
    }
  }

  const combined = parts.filter(Boolean).join("\n\n");
  return truncate(combined, maxBytes);
}

/**
 * The commit identity git itself would use in this directory.
 *
 * Resolved on the host, by asking git in the run root, so `includeIf
 * "gitdir:…"` rules apply — the mechanism that gives one identity per project
 * tree. Inside a container the same rules could never match: the repository is
 * at /workspace there, and the path a rule keys on no longer exists.
 */
export function resolveCommitIdentity(cwd) {
  const name = runCommand("git", ["config", "user.name"], { cwd });
  const email = runCommand("git", ["config", "user.email"], { cwd });
  if (name.status !== 0 || email.status !== 0) {
    return null;
  }
  const identity = { name: name.stdout.trim(), email: email.stdout.trim() };
  return identity.name && identity.email ? identity : null;
}
