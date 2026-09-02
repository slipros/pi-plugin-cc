import fs from "node:fs";
import path from "node:path";

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

/**
 * What the tree looked like before the agent touched it.
 *
 * A run reports what the agent *said*, and until now nothing recorded what it
 * *did*: the answer arrived with no way to see the edits short of running git
 * by hand and guessing which changes were the agent's. The snapshot is two
 * cheap facts — the commit the run started from and the files that were already
 * modified — which is enough to subtract the caller's own work-in-progress from
 * whatever the tree looks like afterwards.
 *
 * @returns {{head: string|null, branch: string, dirty: string[]}|null} null when
 *   the run root is not a git repository, which is a normal case here.
 */
export function captureTreeSnapshot(cwd) {
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"]).status !== 0) {
    return null;
  }
  return {
    head: gitOutput(cwd, ["rev-parse", "HEAD"]).trim() || null,
    branch: getCurrentBranch(cwd),
    // Paths only: the exact status letters change as work continues, and all
    // this has to answer later is "was this file already dirty before the run".
    dirty: parseStatusPaths(gitOutput(cwd, ["status", "--porcelain", "--untracked-files=all"]))
  };
}

function parseStatusPaths(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    // A rename is reported as `old -> new`; the new path is the one that exists.
    .map((entry) => (entry.includes(" -> ") ? entry.split(" -> ").pop().trim() : entry));
}

/**
 * What changed in the tree while the run was going.
 *
 * Commits made by the agent, files it touched, and the files that were already
 * dirty when it started — kept apart, because "the agent wrote this" and "this
 * was already like that" are different claims and only the first one is the
 * run's doing.
 *
 * Note what this cannot know: anything the caller edited in the same tree while
 * the run was going shows up as the agent's work. In a worktree or a sandbox
 * that does not happen; in a shared checkout it can.
 */
/**
 * Lines added and removed, as numbers rather than a sentence.
 *
 * `--shortstat` already says this in English, and every reader that wants to
 * compare runs has to parse it back out. Binary files report `-` for both
 * counts and are skipped: they have no lines to add up.
 *
 * What this cannot see: files the run created and never staged. `git diff`
 * knows nothing about untracked paths, so a run that leaves new files
 * uncommitted under-reports here — hence `untracked` beside it, which is the
 * honest size of that gap.
 */
function parseNumstat(text) {
  let added = 0;
  let deleted = 0;
  for (const line of String(text ?? "").split("\n")) {
    const [plus, minus] = line.split("\t");
    if (plus === undefined || minus === undefined || plus === "-" || minus === "-") {
      continue;
    }
    const a = Number(plus);
    const d = Number(minus);
    if (Number.isFinite(a) && Number.isFinite(d)) {
      added += a;
      deleted += d;
    }
  }
  return { added, deleted };
}

export function summarizeTreeChanges(cwd, before) {
  if (!before) {
    return null;
  }
  const head = gitOutput(cwd, ["rev-parse", "HEAD"]).trim() || null;
  const commits = before.head && head && before.head !== head
    ? gitOutput(cwd, ["log", "--oneline", "--no-decorate", `${before.head}..HEAD`])
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];

  const now = parseStatusPaths(gitOutput(cwd, ["status", "--porcelain", "--untracked-files=all"]));
  const wasDirty = new Set(before.dirty ?? []);
  const committed = before.head && head && before.head !== head
    ? gitOutput(cwd, ["diff", "--name-only", `${before.head}..HEAD`]).split("\n").map((line) => line.trim()).filter(Boolean)
    : [];

  const files = [...new Set([...committed, ...now.filter((file) => !wasDirty.has(file))])].sort();
  const stat = before.head ? gitOutput(cwd, ["diff", "--shortstat", before.head]).trim() : "";
  // The same diff as numbers: what the run actually delivered, against what its
  // tools reported writing. The two disagree when a run rewrites the same lines
  // over and over — work that costs tokens and leaves nothing behind.
  const { added, deleted } = before.head
    ? parseNumstat(gitOutput(cwd, ["diff", "--numstat", before.head]))
    : { added: 0, deleted: 0 };
  const untracked = listUntrackedFiles(cwd).filter((file) => !wasDirty.has(file));

  return {
    base: before.head,
    head,
    branch: getCurrentBranch(cwd),
    commits,
    files,
    // Files the caller had already changed before the run started. Listed
    // separately so a reader is never told the agent wrote them.
    preexisting: [...wasDirty].filter((file) => now.includes(file)).sort(),
    stat,
    added,
    deleted,
    // New files that never reached the index: they are real work, and `added`
    // above does not count a line of them.
    untracked: untracked.length,
    // Everything since the run started, commits and working tree together.
    diffCommand: before.head ? `git diff ${before.head.slice(0, 12)}` : null
  };
}

/** The actual patch for what the run changed, bounded so it cannot flood a reply. */
export function collectTreeDiff(cwd, before, { maxBytes = DEFAULT_MAX_CONTEXT_BYTES } = {}) {
  if (!before?.head) {
    return { text: "", truncated: false };
  }
  const parts = [
    section("Commits", gitOutput(cwd, ["log", "--oneline", "--no-decorate", `${before.head}..HEAD`])),
    section("Diff stat", gitOutput(cwd, ["diff", "--stat", before.head])),
    section("Diff", gitOutput(cwd, ["diff", before.head]))
  ];
  const untracked = listUntrackedFiles(cwd).filter((file) => !(before.dirty ?? []).includes(file));
  if (untracked.length) {
    // Untracked files are invisible to `git diff`, and a new file is exactly
    // what an agent writing code produces most of.
    parts.push(section("New untracked files", untracked.join("\n")));
  }
  return truncate(parts.filter(Boolean).join("\n\n"), maxBytes);
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
 *
 * A run root that is not itself a repository is the case this has to be careful
 * about: `includeIf "gitdir:…"` keys on the repository being worked in, so with
 * no repository under the cursor not one of those rules fires and git answers
 * with the personal address from the global file. That answer looks valid and
 * is wrong — it is the address a corporate forge rejects, discovered on the
 * first push after the commits are already made. So when the directory is
 * outside a repository, the tree is asked instead: the nearest `.gitconfig` at
 * or above it that names a full identity wins, which is the same "one identity
 * per project tree" the `includeIf` rules express, read directly.
 */
export function resolveCommitIdentity(cwd) {
  if (runCommand("git", ["rev-parse", "--git-dir"], { cwd }).status !== 0) {
    const fromTree = identityFromEnclosingConfig(cwd);
    if (fromTree) {
      return fromTree;
    }
  }
  const name = runCommand("git", ["config", "user.name"], { cwd });
  const email = runCommand("git", ["config", "user.email"], { cwd });
  if (name.status !== 0 || email.status !== 0) {
    return null;
  }
  const identity = { name: name.stdout.trim(), email: email.stdout.trim() };
  return identity.name && identity.email ? identity : null;
}

/**
 * Walk up from `cwd` and read the first `.gitconfig` that names both halves of
 * an identity.
 *
 * Nearest wins, which is how the `includeIf` chain is written too: the general
 * rule sits above and the narrower tree below overrides it. Half an identity is
 * not an answer — git refuses to commit with a name and no address — so a file
 * that only sets one of them is passed over rather than merged, keeping the
 * result to a single deliberate source.
 */
function identityFromEnclosingConfig(cwd) {
  let directory = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(directory, ".gitconfig");
    if (fs.existsSync(candidate)) {
      const read = (key) => {
        const result = runCommand("git", ["config", "-f", candidate, "--get", key], { cwd: directory });
        return result.status === 0 ? result.stdout.trim() : "";
      };
      const identity = { name: read("user.name"), email: read("user.email") };
      if (identity.name && identity.email) {
        return identity;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

/**
 * The bind mount a sandboxed run needs when its working directory is a git
 * worktree, or null when it is an ordinary repository.
 *
 * A worktree keeps no repository of its own: its `.git` is a file holding the
 * absolute host path of the real one. The sandbox mounts the working directory
 * at /workspace and nothing else, so that path resolves to nothing inside and
 * every git command dies with `not a git repository`. Mounting the shared
 * `.git` at the very path the file names fixes it — the worktree's own back
 * reference into the container is never followed, so it can stay dangling.
 *
 * The mount has to be writable: git puts the index, HEAD and the reflog of each
 * worktree under `.git/worktrees/<name>/`, so a read-only one fails at `git add`.
 */
export function resolveWorktreeMount(cwd) {
  const dotGit = path.join(cwd, ".git");
  if (!fs.existsSync(dotGit) || !fs.statSync(dotGit).isFile()) {
    // A directory means an ordinary repository, which needs nothing extra;
    // a missing .git means this is not a repository at all.
    return null;
  }
  const commonDir = gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  if (!commonDir || !fs.existsSync(commonDir)) {
    return null;
  }
  return [`${commonDir}:${commonDir}`, ...hostExecutionGuards(commonDir)];
}

/**
 * Read-only covers over the parts of a shared .git that run code on the host.
 *
 * The repository has to be writable — git keeps the index, HEAD and new objects
 * there — but two of its contents are executed outside the container: hooks run
 * on the next commit made from the host, and config carries `core.pager`,
 * `core.fsmonitor` and aliases, which run on almost any git command. Mounting
 * them read-only leaves commits working while closing the only path by which a
 * sandboxed agent could reach the host through this mount. Verified: commit,
 * add and branch operations pass; writing a hook or `git config` is refused.
 */
function hostExecutionGuards(commonDir) {
  const guards = [];
  const hooks = path.join(commonDir, "hooks");
  if (fs.existsSync(hooks)) {
    guards.push(`${hooks}:${hooks}:ro`);
  }
  const config = path.join(commonDir, "config");
  if (fs.existsSync(config)) {
    guards.push(`${config}:${config}:ro`);
  }
  return guards;
}
