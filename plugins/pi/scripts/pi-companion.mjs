#!/usr/bin/env node

/**
 * Companion CLI behind the /pi:* slash commands.
 *
 * Every command is a thin wrapper around one non-interactive `pi` run whose
 * lifecycle is tracked on disk, so background jobs stay inspectable through
 * /pi:status, /pi:result and /pi:cancel.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { allPresetCapabilities } from "./lib/capabilities.mjs";
import { loadConfig, resolveRunSettings, userConfigPath, workspaceIsTrusted } from "./lib/config.mjs";
import {
  captureTreeSnapshot,
  collectReviewContext,
  collectTreeDiff,
  ensureGitRepository,
  getCurrentBranch,
  resolveCommitIdentity,
  resolveReviewTarget,
  resolveWorktreeMount,
  summarizeTreeChanges
} from "./lib/git.mjs";
import { resolveGitProxyHosts } from "./lib/git-proxy.mjs";
import {
  appendLogLine,
  buildStatusSnapshot,
  createJobLogFile,
  createJobRecord,
  createProgressReporter,
  enrichJob,
  isCancelable,
  listCancelableJobs,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  runTrackedJob,
  sortJobsNewestFirst
} from "./lib/jobs.mjs";
import { listModels, normalizeThinking, resolveModelSelection } from "./lib/models.mjs";
import { runFinishHook } from "./lib/notify.mjs";
import { formatFleetEvent, eventKey, orphanEvents, readFleetEvents, recordFleetEvent } from "./lib/fleet-events.mjs";
import { getPiAvailability, PI_BINARY, runPiTurn } from "./lib/pi.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { buildSystemPrompt, interpolate, listNamedPrompts, loadTaskTemplate } from "./lib/prompts.mjs";
import { inboxPath, pushControlMessage } from "./lib/inbox.mjs";
import { parseJsonLine } from "./lib/jsonl.mjs";
import { runPiRpcTurn } from "./lib/rpc.mjs";
import {
  cacheState,
  collectSessions,
  findSession,
  isSessionReference,
  resolveCacheTtlMs,
  staleSessionMessage
} from "./lib/sessions.mjs";
import { renderTranscriptEvent } from "./lib/transcript.mjs";
import {
  attachMounts,
  buildSandboxImage,
  cleanupCredentialSlices,
  containerNameForJob,
  describeSandbox,
  describeSlotUsage,
  isSandboxed,
  listSandboxContainers,
  normalizeSandbox,
  removeSandboxContainer,
  listSandboxImages,
  sandboxDockerfile,
  sandboxPreflight,
  sandboxRunWarnings,
  sandboxStatus,
  DEFAULT_SANDBOX_IMAGE
} from "./lib/sandbox.mjs";
import {
  ensureStateDir,
  eventsPath,
  generateJobId,
  listJobs,
  listJobsEverywhere,
  nowIso,
  resolveDetachedLogFile,
  resolvePromptFile,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  renderBackgroundStart,
  renderCancelAllReport,
  renderCancelReport,
  renderModelsReport,
  renderPresetsReport,
  renderRunDetail,
  renderRunResult,
  renderRunsReport,
  renderSessionsReport,
  renderSandboxReport,
  renderSetupReport,
  renderStatsReport,
  renderStatusReport,
  renderStoredJobResult,
  renderWaitReport
} from "./lib/render.mjs";
import { resolveRunRoot, resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  databasePath,
  openDatabase,
  pruneJournalText,
  queryRun,
  queryRuns,
  queryStats,
  queryTotals,
  recordJobSafely,
  DEFAULT_TEXT_TTL_DAYS
} from "./lib/db.mjs";

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// Set on the detached copy of this process, so it runs the job instead of
// handing it off again, and both halves agree on the job id.
const DETACHED_ENV = "PI_PLUGIN_DETACHED";
const DETACHED_JOB_ENV = "PI_PLUGIN_JOB_ID";
// Where the parent left the task text for the detached copy to pick up.
const DETACHED_PROMPT_ENV = "PI_PLUGIN_PROMPT_FILE";
// The session a detached `continue` was already told to resume: the child
// re-executes the command line, and "last" would resolve against a job list
// that now includes the child's own pending record.
const DETACHED_SESSION_ENV = "PI_PLUGIN_CONTINUE_SESSION";

/**
 * Incremental reader over a job's event file.
 *
 * `--follow` polls several times a second, and re-reading the whole transcript
 * each time is quadratic in its size: a long run writes megabytes, and every
 * tick re-parsed all of it. This keeps a byte offset and only decodes what was
 * appended since, while still counting lines — the cursor is public API, so it
 * stays a line number.
 *
 * The tail of a partial line is held back until its newline arrives: a poll can
 * land mid-write, and half a JSON object is not an event.
 */
export function createEventReader(file) {
  let offset = 0;
  let line = 0;
  let base = 0;
  // Held as bytes, not text: a multi-byte character split across two reads was
  // decoded twice as halves and came out as U+FFFD, quietly corrupting every
  // non-ASCII transcript larger than the read size.
  let partial = Buffer.alloc(0);
  let events = [];

  const pull = () => {
    let handle;
    try {
      handle = fs.openSync(file, "r");
    } catch {
      return;
    }
    try {
      const size = fs.fstatSync(handle).size;
      // A shorter file is a different file: the run restarted, or state was
      // cleaned. Start over rather than decode from a meaningless offset.
      if (size < offset) {
        offset = 0;
        line = 0;
        base = 0;
        partial = Buffer.alloc(0);
        events = [];
      }
      while (offset < size) {
        const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, size - offset));
        const read = fs.readSync(handle, buffer, 0, buffer.length, offset);
        if (read <= 0) {
          break;
        }
        offset += read;
        const chunk = Buffer.concat([partial, buffer.subarray(0, read)]);
        let start = 0;
        for (let index = 0; index < chunk.length; index += 1) {
          if (chunk[index] !== 0x0a) {
            continue;
          }
          const piece = chunk.toString("utf8", start, index);
          start = index + 1;
          if (!piece) {
            continue;
          }
          line += 1;
          const event = parseJsonLine(piece);
          // Unparsable lines still advance the cursor, so the events array is
          // indexed by line number rather than by its own length — mixing the
          // two shifted the replay window by one per broken line.
          events.push(event ?? null);
        }
        partial = chunk.subarray(start);
      }
    } finally {
      fs.closeSync(handle);
    }
  };

  return {
    read(fromLine) {
      pull();
      // Buffered events start at `base`; anything before the caller's cursor is
      // already seen. What is handed over is then released — a follow loop runs
      // for hours, and keeping every event alive would grow without bound.
      const out = events.slice(Math.max(0, fromLine - base)).filter(Boolean);
      base = line;
      events = [];
      return { events: out, nextLine: line };
    }
  };
}

/**
 * Statuses a job never leaves. Everything else — `running`, and `pending` while
 * the detached child starts up — means the run is still going, which is what
 * `watch --follow` has to keep waiting on.
 */
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "orphaned"]);

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(String(status));
}

/** How long `watch --follow` waits for a job id to appear in the journal. */
const JOB_APPEARANCE_GRACE_MS = 30_000;

/**
 * `wait` without `--for`. Long enough to outlast a normal run, short enough
 * that a caller cannot be blocked forever by a job whose wrapper died silently.
 */
const DEFAULT_WAIT_SECONDS = 3600;

/** Job records change at the pace of the filesystem, not of the model. */
const WAIT_POLL_MS = 500;

/** Runs shown by `events` without `--tail`. */
const DEFAULT_EVENT_TAIL = 20;

/**
 * How often `events --follow` sweeps for runs whose process died.
 * Nothing is polled for the announced endings — those arrive as log lines the
 * moment they are written; this interval only bounds how late a killed run is
 * noticed.
 */
const DEFAULT_EVENT_POLL_SECONDS = 20;

/** How often `events --follow` re-reads the log itself. Cheap: one small file. */
const EVENT_LOG_POLL_MS = 1000;

const RUN_FLAGS = {
  booleans: [
    "background",
    "wait",
    "read-only",
    "write",
    "json",
    "fresh",
    // Continue a session whose provider cache has aged out, paying for the
    // whole history again on purpose.
    "stale-ok",
    "stdin",
    "no-tools",
    "no-builtin-tools",
    "no-extensions",
    "no-skills"
  ],
  strings: [
    "model",
    "provider",
    "thinking",
    "preset",
    "system-prompt",
    "tools",
    "exclude-tools",
    "session",
    "timeout",
    "max-cost",
    "max-tokens",
    "max-turns",
    "notify",
    // `rerun <id> --prompt "…"` replaces the recorded task and keeps its settings.
    "prompt",
    // `review --job <id>` reviews what that run changed.
    "job",
    "base",
    "scope",
    "engine",
    "sandbox",
    "cwd",
    "git-name",
    "git-email"
  ],
  collect: ["append-system-prompt", "extension", "skill", "mount", "append"],
  aliases: {
    m: "model",
    p: "provider",
    t: "thinking",
    "readonly": "read-only",
    "append-system": "append-system-prompt",
    resume: "session",
    e: "extension",
    v: "mount"
  }
};

/** Every flag any command understands, for the unknown-flag guard in main(). */
const KNOWN_FLAGS = new Set([
  ...RUN_FLAGS.booleans,
  ...RUN_FLAGS.strings,
  ...RUN_FLAGS.collect,
  ...Object.keys(RUN_FLAGS.aliases),
  ...Object.values(RUN_FLAGS.aliases),
  "all",
  "global",
  "running",
  "status",
  "by",
  "days",
  "limit",
  "follow",
  "follow-up",
  "for",
  "since",
  "tail",
  "stats",
  "image",
  "no-cache",
  "dockerfile",
  "pi-version",
  "job",
  "diff",
  "prune",
  "full",
  "kind",
  "poll",
  "workspace"
]);

/**
 * A numeric flag has to be a number: `--timeout 30m` used to become NaN, which
 * silently removed both the run's time limit and the bound on waiting for a
 * sandbox slot, leaving the run to hang indefinitely.
 */
function positiveNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive number, got "${value}".`);
  }
  return parsed;
}

/** `--model`, `-m`, `--model=x` and `-m=x` all name the same flag. */
function canonicalFlag(token) {
  const text = String(token).replace(/^--?/, "");
  const name = text.split("=")[0];
  return RUN_FLAGS.aliases[name] ?? name;
}

function usage() {
  // The name we were called by. A hint that prints the path to the script when
  // it was invoked through the short shim teaches the long form exactly where
  // the reader is looking for the short one.
  const self = process.env.PI_INVOKED_AS || "pi-companion.mjs";
  return [
    "Usage:",
    `  ${self} setup [--json]`,
    `  ${self} models [search] [--stats [--days N]] [--json]`,
    `  ${self} presets [--json]`,
    `  ${self} delegate [flags] <prompt>`,
    `  ${self} review [flags] [focus text]`,
    `  ${self} status [job-id] [--all] [--global] [--running]`,
    "                          [--status <s,s>] [--preset <name>] [--model <id>] [--json]",
    `  ${self} result [job-id] [--diff] [--json]`,
    `  ${self} wait [job-id...] [--all] [--for <seconds>] [--json]`,
    `  ${self} events [--follow [--for <s>]] [--tail <n>] [--poll <s>] [--workspace] [--json]`,
    `  ${self} runs [run-id] [--all] [--limit N] [--days N] [--model <id>]`,
    "                        [--preset <name>] [--kind delegate|review] [--prune] [--json]",
    `  ${self} rerun <run-id> [--append <text>] [--prompt <text>|--stdin] [run flags]`,
    `  ${self} continue [session-id|job-id|last] [run flags] <what to do next>`,
    `  ${self} sessions [session-id] [--all] [--global] [--json]`,
    `  ${self} cancel [job-id] [--all [--global]] [--json]`,
    `  ${self} steer [job-id] [--follow-up] <message>`,
    `  ${self} watch [job-id] [--follow [--for <s>]] [--since <cursor>] [--tail <n>] [--json]`,
    `  ${self} stats [--by day|model|preset|workspace|kind|status] [--days N|--all] [--json]`,
    `  ${self} sandbox [status|build [name|--all]|clean] [--image <tag>]`,
    "                            [--dockerfile <name|path>] [--pi-version <v>]",
    "",
    "Run flags:",
    "  --model <id>            model id or pattern (provider/model[:thinking])",
    "  --provider <name>       provider name",
    "  --thinking <level>      off|minimal|low|medium|high|xhigh|max",
    "  --preset <name>         preset from .claude/pi/config.json",
    "  --system-prompt <v>     stored prompt name (reviewer, fixer, …), @path/to.md, or inline text",
    "  --append-system-prompt  additive prompt text or file (repeatable)",
    "  --read-only             restrict pi to reading: read, grep, find, ls + LSP navigation",
    "  --write                 allow edit/write/bash even when the preset is read-only",
    "  --session <id>          continue an existing pi session ('last' = latest job)",
    "  --fresh                 ignore --session and start a new pi session",
    "  --stale-ok              continue a session whose provider cache has aged out,",
    "                          re-sending its whole history at the full input rate",
    "  --timeout <seconds>     hard limit for the run",
    "  --max-cost <usd>        stop the run once it has cost this much",
    "  --max-tokens <n>        stop the run once it has used this many tokens",
    "  --max-turns <n>         stop the run after this many assistant turns",
    "  --notify <command>      shell command to run when the job finishes",
    "  --stdin                 append piped stdin to the prompt",
    "  --cwd <path>            directory the agent works in (mounted at /workspace,",
    "                          and the tree `review` diffs). Job records stay with",
    "                          the caller, so status/watch keep finding the job.",
    "  --git-name <name>       commit identity for the agent; --git-email goes with it",
    "  --git-email <address>   (both are needed — git refuses half of one)",
    "  --json                  machine-readable output",
    "",
    "Tool flags (what the pi agent is allowed to use):",
    "  --tools <list>          allowlist: read,bash,edit,write,grep,find,ls + extension tools",
    "  --exclude-tools <list>  denylist",
    "  --no-builtin-tools      keep only extension/custom tools",
    "  --no-tools              no tools at all",
    "  --extension <source>    load a pi extension (path, npm:pkg, git url); repeatable",
    "  --skill <path>          load a pi skill; repeatable",
    "  --no-extensions         ignore discovered extensions",
    "  --no-skills             ignore discovered skills",
    "  --engine rpc|json       rpc (default) keeps the run steerable",
    "",
    "Isolation:",
    "  --sandbox <name>        docker, none, or a profile from sandboxProfiles",
    "                          in the config (a named toolchain: mounted binaries,",
    "                          PATH, gate extensions). The whole pi process runs in",
    "                          the container; build the image first with",
    "                          `pi-companion.mjs sandbox build`.",
    "  --mount <h:c[:ro]>      add a host directory to that sandbox, on top of",
    "                          whatever the profile mounts; repeatable. A relative",
    "                          host path resolves against the workspace.",
    "",
    "Images: a profile may name its own `image` and `dockerfile`. Dockerfiles are",
    "looked up as <name>.Dockerfile in <workspace>/.claude/pi/sandbox, then",
    "~/.claude/pi/sandbox, then the plugin's own — so a user copy survives plugin",
    "updates. `sandbox build <name>` builds one, `--all` builds every one the",
    "config knows about."
  ].join("\n");
}

/**
 * Claude Code hands the whole argument line over as a single "$ARGUMENTS"
 * string, while a real shell passes separate tokens. Both must work.
 */
function normalizeCommandArgs(argv) {
  // Only re-split when the single argument actually looks like a command line.
  // A shell has already done the splitting by then, so re-parsing plain prose
  // ate its punctuation: "fix the user's login flow" came out as "users".
  const single = argv.length === 1 ? String(argv[0] ?? "") : null;
  if (single && /(^|\s)(--?[a-zA-Z])/.test(single)) {
    return splitRawArgumentString(single);
  }
  return argv;
}

/**
 * stdin is only consumed when the caller opts in with --stdin, so a command
 * launched with an inherited terminal never blocks waiting for input.
 */
function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * The task text the parent left for this detached run, or null when this
 * process is not one.
 *
 * Read once and removed: the same text is in the job record and in the journal,
 * so the file has no second reader, and leaving it behind would keep a copy of
 * somebody's repository around for as long as the job is retained.
 */
export function takeDetachedPrompt() {
  const file = process.env[DETACHED_PROMPT_ENV];
  if (!file) {
    return null;
  }
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // A missing handoff file means the parent could not write it; the command
    // falls back to resolving the task itself, exactly as before.
    return null;
  }
  try {
    fs.unlinkSync(file);
  } catch {
    // The eviction sweep clears it later.
  }
  return text.trim() ? text : null;
}

function output(rendered, payload, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
}

function resolveSessionReference(workspaceRoot, reference) {
  const value = String(reference ?? "").trim();
  if (!value) {
    return null;
  }
  if (value !== "last" && value !== "latest") {
    return value;
  }
  const previous = sortJobsNewestFirst(listJobs(workspaceRoot)).find((job) => job.sessionId);
  if (!previous) {
    throw new Error("No previous pi session recorded for this workspace.");
  }
  return previous.sessionId;
}

/**
 * Turn parsed flags + config into the concrete settings of one run.
 */
export function buildRunSettings({ command, flags, workspaceRoot, runRoot = workspaceRoot, config, trusted = true }) {
  const overrides = {
    model: flags.model ?? null,
    provider: flags.provider ?? null,
    thinking: normalizeThinking(flags.thinking),
    preset: flags.preset ?? null,
    systemPrompt: flags["system-prompt"] ?? null,
    appendSystemPrompt: flags["append-system-prompt"] ?? [],
    tools: flags.tools ?? null,
    excludeTools: flags["exclude-tools"] ?? null,
    extensions: flags.extension ?? [],
    skills: flags.skill ?? [],
    mounts: flags.mount ?? [],
    ...(flags["no-tools"] ? { noTools: true } : {}),
    ...(flags["no-builtin-tools"] ? { noBuiltinTools: true } : {}),
    ...(flags["no-extensions"] ? { noExtensions: true } : {}),
    ...(flags["no-skills"] ? { noSkills: true } : {}),
    ...(flags.engine ? { engine: flags.engine } : {}),
    ...(flags.sandbox ? { sandbox: flags.sandbox } : {}),
    ...(flags["git-name"] || flags["git-email"]
      ? { git: { ...(flags["git-name"] ? { name: flags["git-name"] } : {}), ...(flags["git-email"] ? { email: flags["git-email"] } : {}) } }
      : {}),
    ...(flags["read-only"] ? { readOnly: true } : {}),
    ...(flags.write ? { readOnly: false } : {}),
    ...(flags.timeout ? { timeoutMs: positiveNumber(flags.timeout, "--timeout") * 1000 } : {}),
    ...(flags.notify ? { onFinish: flags.notify } : {}),
    // Each flag caps one dimension on its own, so passing one does not clear the
    // others a preset already set.
    ...(flags["max-cost"] || flags["max-tokens"] || flags["max-turns"]
      ? {
          budget: {
            ...(flags["max-cost"] ? { maxCostUsd: positiveNumber(flags["max-cost"], "--max-cost") } : {}),
            ...(flags["max-tokens"] ? { maxTokens: positiveNumber(flags["max-tokens"], "--max-tokens") } : {}),
            ...(flags["max-turns"] ? { maxTurns: positiveNumber(flags["max-turns"], "--max-turns") } : {})
          }
        }
      : {})
  };

  const settings = resolveRunSettings(config, command, overrides);
  if (!flags["git-name"] && !flags["git-email"]) {
    // Identity order is flags, then git's own answer for this directory (or,
    // outside a repository, the nearest `.gitconfig` above it), then a preset.
    // Config files outrank presets deliberately: an `includeIf "gitdir:…"` rule
    // is the decision about who commits in this tree, while a preset only names
    // a fallback for trees that have no such rule. In a sandbox this resolution
    // is also the only way such a rule can survive — the container sees
    // /workspace, not the path the rule matches.
    settings.git = resolveCommitIdentity(runRoot) ?? settings.git;
  }
  const prompt = buildSystemPrompt({ pluginRoot: PLUGIN_ROOT, workspaceRoot, config, settings });

  const warnings = [];
  if (runRoot !== workspaceRoot) {
    // The agent edits a tree the caller is not sitting in, and without a
    // container it does so with the caller's own permissions.
    warnings.push(
      `The agent runs in ${runRoot}, outside this workspace. Its edits land there, not in ${workspaceRoot}.`
    );
  }
  let sandbox = applyConcurrencyPool(normalizeSandbox(settings.sandbox, config.sandboxProfiles), config);
  let worktreeMount = null;
  if (settings.mounts.length && !isSandboxed(sandbox)) {
    // Without a container there is nothing to mount into: pi already sees the
    // whole filesystem, so silently dropping them would hide a real mistake.
    throw new Error(
      `--mount needs a sandbox: ${settings.mounts.join(", ")} has nowhere to go. ` +
        "Add `--sandbox docker` or a preset with one."
    );
  }
  if (isSandboxed(sandbox)) {
    // The provider decides which credential the container gets, so it has to
    // travel with the sandbox descriptor rather than only with the pi args.
    // `isolateCaches` travels with the descriptor because the answer belongs to
    // the workspace, not to the profile: the same `go` profile shares its module
    // cache between one's own repositories and keeps a throwaway one for a
    // checkout that arrived from outside.
    sandbox = { ...sandbox, provider: providerOf(settings), isolateCaches: !trusted };
    // Which forges the run may fetch from is decided here, where the config is
    // in hand; the proxy itself starts per run, next to the credential one.
    sandbox = { ...sandbox, gitProxyHosts: resolveGitProxyHosts(config, sandbox) };
    // A worktree cannot see its own repository through /workspace alone, so the
    // shared .git is mounted for it. Listed before the run's own mounts, which
    // therefore win the deduplication if one names the same target explicitly.
    const worktreeMounts = resolveWorktreeMount(runRoot) ?? [];
    worktreeMount = worktreeMounts[0] ?? null;
    sandbox = attachMounts(sandbox, [...worktreeMounts, ...settings.mounts]);
    const identity = gitIdentityEnv(settings.git);
    if (Object.keys(identity).length) {
      sandbox = {
        ...sandbox,
        env: [...sandbox.env, ...Object.entries(identity).map(([key, value]) => `${key}=${value}`)]
      };
    }

    // Gates the profile brings come first: an extension that blocks a tool call
    // should get the event before the ones the run asked for.
    settings.extensions = [...sandbox.extensions, ...settings.extensions];
    settings.skills = [...sandbox.skills, ...settings.skills];

    // A missing daemon or image is a setup problem: fail before a job record
    // exists rather than recording a run that never started.
    const preflight = sandboxPreflight(sandbox);
    if (!preflight.ok) {
      throw new Error(`Sandbox is not ready.\n- ${preflight.errors.join("\n- ")}`);
    }
    warnings.push(
      ...preflight.warnings,
      // The container sees the run root at /workspace, so host paths are judged
      // against that tree, not against the one holding the job records.
      ...sandboxRunWarnings(sandbox, {
        workspaceRoot: runRoot,
        extensions: settings.extensions,
        skills: settings.skills
      })
    );
  }

  let catalogue = [];
  try {
    catalogue = listModels(PI_BINARY, { cwd: workspaceRoot });
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  const selection = resolveModelSelection(catalogue, {
    model: settings.model,
    provider: settings.provider
  });
  if (selection.warning) {
    warnings.push(selection.warning);
  }

  return {
    ...settings,
    runRoot,
    sandbox,
    sandboxLabel: describeSandbox(sandbox),
    // Recorded so a cancel that has no container name can still guess it: the
    // fallback builds `pi-<profile>-<job>`, and without this it guessed the
    // profile-less form and never found a profiled container.
    sandboxProfile: sandbox?.profileName ?? null,
    // Occupancy at launch time: a run that has to queue should say so before it
    // starts, not leave the caller wondering why nothing is happening.
    slotUsage: describeSlotUsage(sandbox),
    worktreeMount,
    model: selection.model,
    provider: selection.provider,
    systemPromptText: prompt.systemPrompt,
    appends: prompt.appends,
    promptName: prompt.name,
    promptLabel: prompt.sources.find((source) => source.startsWith("system prompt")) ?? null,
    promptSources: prompt.sources,
    warnings
  };
}

/**
 * Git reads these before any config file, so one identity covers a sandboxed
 * run (where ~/.gitconfig may not exist at all) and a host run (where it exists
 * but names the human, not the agent).
 */
function gitIdentityEnv(git) {
  if (!git?.name || !git?.email) {
    return {};
  }
  return {
    GIT_AUTHOR_NAME: git.name,
    GIT_AUTHOR_EMAIL: git.email,
    GIT_COMMITTER_NAME: git.name,
    GIT_COMMITTER_EMAIL: git.email
  };
}

/**
 * Hand a background run to a detached copy of this script.
 *
 * `--background` used to mean "print the job id first and keep going", so the
 * caller's shell stayed occupied for the whole run — a Claude Code turn had to
 * hold a background task open for an hour, and anything that killed that task
 * (a stray `timeout`, a cancelled turn) killed the agent with it.
 *
 * The child re-runs the same command with the same arguments; only the job id
 * is handed down, so both processes agree on which job this is. Detaching
 * happens after settings are resolved, so a bad preset or a missing sandbox
 * image still fails in front of the caller instead of in a log nobody reads.
 *
 * @returns {boolean} true when the run was handed off and this process is done
 */
function detachBackgroundRun({ kind, workspaceRoot, jobId, title, prompt, settings, env: extraEnv = {} }) {
  const detachedLog = resolveDetachedLogFile(workspaceRoot, jobId);
  ensureStateDir(workspaceRoot);
  const handle = fs.openSync(detachedLog, "a");

  // The child re-executes this command line with stdin closed, so a task that
  // arrived on stdin exists only in this process. Handing the assembled text
  // over through a file is what keeps `--background` and `--stdin` from losing
  // it: the child used to re-read an empty stdin and run on the first line of
  // the prompt alone — a brief-sized silence, since the run still started.
  // 0600 because the text is the contents of somebody's repository.
  const promptFile = resolvePromptFile(workspaceRoot, jobId);
  fs.writeFileSync(promptFile, prompt ?? "", { encoding: "utf8", mode: 0o600 });

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", handle, handle],
    env: {
      ...process.env,
      [DETACHED_ENV]: "1",
      [DETACHED_JOB_ENV]: jobId,
      [DETACHED_PROMPT_ENV]: promptFile,
      // Decisions the parent already made and the child must not remake: it
      // re-executes the same command line, and "last" or a cache TTL can
      // resolve differently by the time it does.
      ...extraEnv
    }
  });
  child.unref();
  fs.closeSync(handle);

  // A record exists before the child writes its own, so `status` can answer
  // even in the seconds between the handoff and the first tracked update.
  const job = createJobRecord({
    id: jobId,
    kind,
    title,
    workspaceRoot,
    runRoot: settings.runRoot ?? workspaceRoot,
    model: settings.model,
    preset: settings.presetName,
    sandbox: settings.sandboxLabel,
    background: true,
    detached: true,
    pid: child.pid,
    status: "pending",
    createdAt: nowIso()
  });
  writeJobFile(workspaceRoot, jobId, job);
  upsertJob(workspaceRoot, job);

  process.stdout.write(renderBackgroundStart({ job, settings, detachedLog }));
  return true;
}

/**
 * The settings worth repeating a run with.
 *
 * Not the whole resolved object: the system prompt text, the merged extension
 * lists and the sandbox descriptor are derived from the config as it is *now*,
 * and pinning them would repeat a stale copy of the machine's setup rather than
 * the run. What is kept is what the caller chose — the preset, the model, the
 * ceilings — so a rerun resolves everything else fresh.
 */
function rerunRecipe(settings) {
  const recipe = {
    preset: settings.presetName ?? null,
    model: settings.model ?? null,
    provider: settings.provider ?? null,
    thinking: settings.thinking ?? null,
    engine: settings.engine ?? null,
    sandbox: settings.sandbox?.profileName ?? (isSandboxed(settings.sandbox) ? "docker" : null),
    readOnly: settings.readOnly ? true : null,
    timeoutMs: settings.timeoutMs ?? null,
    budget: settings.budget ?? null
  };
  return Object.fromEntries(Object.entries(recipe).filter(([, value]) => value !== null));
}

/**
 * Shared execution path for delegate and review.
 */
async function executeRun({
  kind,
  title,
  prompt,
  settings,
  workspaceRoot,
  runRoot = workspaceRoot,
  flags,
  jobId,
  resultTitle,
  sessionId = null
}) {
  const logFile = createJobLogFile(workspaceRoot, jobId, title);
  const eventsFile = eventsPath(workspaceRoot, jobId);
  const inboxFile = inboxPath(workspaceRoot, jobId);
  const job = createJobRecord({
    id: jobId,
    kind,
    title,
    workspaceRoot,
    // Where the agent actually works; equal to workspaceRoot unless --cwd moved it.
    runRoot,
    logFile,
    eventsFile,
    inboxFile,
    engine: settings.engine,
    model: settings.model,
    systemPromptName: settings.promptName,
    preset: settings.presetName,
    readOnly: settings.readOnly,
    sandbox: settings.sandboxLabel,
    background: Boolean(flags.background),
    // Taken before pi starts, so what the agent changed can be told apart from
    // what was already in the tree. Null outside a git repository.
    treeBefore: captureTreeSnapshot(runRoot),
    // The task itself, and enough of the settings to run it again. Both go to
    // the journal (redacted and capped there); the record on disk holds them so
    // a `rerun` works even for a job whose journal row has aged out.
    prompt,
    rerunSettings: rerunRecipe(settings),
    status: "pending",
    createdAt: nowIso()
  });

  writeJobFile(workspaceRoot, jobId, job);
  upsertJob(workspaceRoot, job);

  const onProgress = createProgressReporter({
    workspaceRoot,
    jobId,
    logFile,
    stderr: Boolean(flags.background)
  });

  for (const warning of settings.warnings) {
    onProgress({ message: `Warning: ${warning}` });
  }
  for (const source of settings.promptSources) {
    onProgress({ message: `System prompt ${source}` });
  }

  const startedAt = Date.now();
  /**
   * Announce the end of the run, for every terminal outcome including failure:
   * "it finished" is exactly the moment worth announcing, and a notification
   * that only arrives on success is the one you cannot rely on.
   *
   * Two channels, and the order is deliberate. The fleet event goes first and
   * always — it is the one a supervisor watches, so it cannot be something the
   * user had to switch on. `onFinish` follows as the optional channel out to
   * the host (desktop notification, message queue), and its failure is a log
   * line, never the thing that swallows the announcement.
   */
  const announceTerminal = (status, execution = null) => {
    // The record `runTrackedJob` just wrote is the authority on how the run
    // ended: it is where a degraded-but-usable run becomes `completed` and
    // where a run cut off at the output ceiling becomes `truncated`. Announcing
    // a status recomputed here would contradict what `status` reports.
    const stored = readStoredJob(job.workspaceRoot, job.id);
    const finished = {
      ...job,
      ...(stored ? enrichJob(stored) : {}),
      status: stored?.status ?? status,
      logFile,
      model: execution?.model ?? stored?.model ?? settings.model,
      summary: execution?.summary ?? stored?.summary ?? null
    };
    recordFleetEvent(finished);
    if (!settings.onFinish) {
      return;
    }
    const outcome = runFinishHook(settings.onFinish, finished);
    if (outcome.error) {
      appendLogLine(logFile, `onFinish hook failed: ${outcome.error}`);
    }
  };

  let execution;
  try {
    execution = await runTrackedJob({ ...job, logFile }, async () => {
      const runner = settings.engine === "json" ? runPiTurn : runPiRpcTurn;
      const result = await runner({
        cwd: runRoot,
        env: { ...process.env, ...gitIdentityEnv(settings.git) },
        prompt,
        model: settings.model,
        provider: settings.provider,
        thinking: settings.thinking,
        systemPrompt: settings.systemPromptText,
        appends: settings.appends,
        tools: settings.tools,
        excludeTools: settings.excludeTools,
        readOnly: settings.readOnly,
        noTools: settings.noTools,
        noBuiltinTools: settings.noBuiltinTools,
        extensions: settings.extensions,
        skills: settings.skills,
        noExtensions: settings.noExtensions,
        noSkills: settings.noSkills,
        sessionId,
        sessionName: title.slice(0, 80),
        timeoutMs: settings.timeoutMs,
        budget: settings.budget,
        eventsFile,
        inboxFile,
        sandbox: settings.sandbox,
        jobId,
        onProgress,
        onSpawn: ({ pid: piPid, containerName }) => {
          // Recorded so /pi:cancel can signal pi itself, not just this wrapper —
          // and, in a sandbox, remove the container the signal cannot reach.
          upsertJob(workspaceRoot, { id: jobId, piPid, containerName: containerName ?? null });
        }
      });

      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      const enriched = {
        ...result,
        elapsed: elapsedSeconds < 60 ? `${elapsedSeconds}s` : `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`,
        // Read here, while the tree is still as the agent left it: asking later
        // would measure whatever has happened since the run ended.
        changes: summarizeTreeChanges(runRoot, job.treeBefore)
      };

      return {
        ...enriched,
        summary: (result.text ?? "").split("\n").find((line) => line.trim())?.slice(0, 160) ?? null,
        rendered: renderRunResult({ title: resultTitle, job, settings, execution: enriched })
      };
    });
  } catch (error) {
    // `runTrackedJob` has already recorded the failure; this only announces
    // it. Rethrown untouched afterwards so the command still reports it.
    announceTerminal("failed");
    throw error;
  }

  announceTerminal(execution.aborted ? "cancelled" : execution.exitStatus === 0 ? "completed" : "failed", execution);

  return { job, execution };
}

async function commandSetup(argv, workspaceRoot) {
  const { flags } = parseArgs(argv, { booleans: ["json"] });
  const availability = getPiAvailability(workspaceRoot);
  const { config, sources, errors, warnings: configWarnings } = loadConfig(workspaceRoot);
  const configuredSandbox = normalizeSandbox(config.defaults?.sandbox ?? null, config.sandboxProfiles);

  const payload = {
    ...availability,
    sandbox: {
      configured: describeSandbox(configuredSandbox),
      image: isSandboxed(configuredSandbox) ? configuredSandbox.image : DEFAULT_SANDBOX_IMAGE,
      ready: sandboxPreflight(
        isSandboxed(configuredSandbox) ? configuredSandbox : { mode: "docker", image: DEFAULT_SANDBOX_IMAGE }
      ).ok
    },
    configSources: sources,
    configErrors: [...errors, ...(configWarnings ?? [])],
    presets: Object.keys(config.presets ?? {}),
    prompts: [...listNamedPrompts(PLUGIN_ROOT, workspaceRoot).keys()].sort(),
    stateDir: resolveStateDir(workspaceRoot),
    userConfigPath: userConfigPath()
  };

  output(renderSetupReport(payload), payload, Boolean(flags.json));
  return availability.installed ? 0 : 1;
}

/**
 * The agents this setup offers, and what each is for.
 *
 * Deliberately does NOT touch the model catalogue: that call walks several
 * hundred entries and takes over a second, while "which agent do I hand this
 * to" is asked constantly — by a person choosing, and by the hook that answers
 * the same question on every delegation.
 */
async function commandPresets(argv, workspaceRoot) {
  const { flags } = parseArgs(argv, { booleans: ["json"] });
  const { config } = loadConfig(workspaceRoot);
  const payload = {
    presets: config.presets ?? {},
    prompts: [...listNamedPrompts(PLUGIN_ROOT, workspaceRoot).keys()].sort(),
    // Kept beside the presets rather than merged into them: these values are
    // derived, and a reader that cannot tell them apart from what the user
    // wrote will eventually write one back into the config.
    capabilities: allPresetCapabilities(config)
  };
  output(renderPresetsReport(payload), payload, Boolean(flags.json));
  return 0;
}

async function commandModels(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, { booleans: ["json", "stats"], strings: ["days"] });
  const search = positional.join(" ").trim() || null;
  const { config } = loadConfig(workspaceRoot);
  const models = listModels(PI_BINARY, { cwd: workspaceRoot, search });

  // Presets and prompts live in `presets`, and that goes for `--json` too: a
  // JSON payload richer than the report it accompanies is how the two answers
  // drift apart, and the reason to split the commands was that walking the
  // catalogue costs a second.
  const payload = {
    models,
    defaults: config.defaults ?? {},
    search,
    // What the catalogue cannot tell you: how these models actually behaved
    // here. Only gathered when asked for — it opens the journal.
    measured: flags.stats ? measuredModels({ days: flags.days ? Number(flags.days) : null, search }) : null
  };

  output(renderModelsReport(payload), payload, Boolean(flags.json));
  return 0;
}

/**
 * Which provider a run will authenticate against.
 *
 * Taken from `--provider` or from the `provider/model` form of the model id.
 * Null means "pi decides", and a sandboxed run then falls back to the full
 * credentials file — the only case where the whole set still travels.
 */
function providerOf(settings) {
  if (settings.provider) {
    return String(settings.provider);
  }
  const model = typeof settings.model === "string" ? settings.model : "";
  const separator = model.indexOf("/");
  return separator > 0 ? model.slice(0, separator) : null;
}

/**
 * Resolve a profile's slot allowance from the pool it belongs to.
 *
 * The limit lives with the pool rather than with each profile, so profiles
 * sharing a provider cannot disagree about how many sessions that provider
 * allows. A profile that names no pool keeps whatever `maxConcurrent` it set
 * for itself, which is the default and needs no configuration at all.
 */
export function applyConcurrencyPool(sandbox, config) {
  const group = sandbox?.concurrencyGroup;
  if (!group) {
    return sandbox;
  }
  const limit = Number(config?.concurrencyPools?.[group]);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(
      `Sandbox profile references concurrency pool "${group}", which is not defined. ` +
        `Add "concurrencyPools": {"${group}": <slots>} to the config, or drop concurrencyGroup.`
    );
  }
  return { ...sandbox, maxConcurrent: limit };
}

/**
 * Per-model numbers from the journal, filtered by the same search the catalogue
 * used so the two halves of the report talk about the same models.
 *
 * Returns an empty list rather than throwing when the journal cannot be opened:
 * a missing history is a reason to show less, not to fail the command.
 */
function measuredModels({ days = null, search = null } = {}) {
  const handle = openDatabase();
  if (!handle) {
    return [];
  }
  try {
    const rows = queryStats(handle, { by: "model", days, limit: 200 });
    const needle = search?.toLowerCase() ?? null;
    return rows.filter((row) => !needle || String(row.bucket).toLowerCase().includes(needle));
  } finally {
    handle.close();
  }
}

/**
 * Sessions of a workspace, each with the context it grew to.
 *
 * The size comes from the job file rather than the index: the index never had
 * it, and it is the number that says what continuing a cold session costs.
 */
function workspaceSessions(workspaceRoot, { global: everywhere = false } = {}) {
  const jobs = everywhere ? listJobsEverywhere() : listJobs(workspaceRoot);
  return collectSessions(jobs).map((session) => ({
    ...session,
    contextTokens: readStoredJob(session.workspaceRoot ?? workspaceRoot, session.jobId)?.peakContext ?? null
  }));
}

/**
 * The gate in front of every continuation.
 *
 * Resuming a session replays its whole history. Inside the provider's cache
 * window that is nearly free; past it the same tokens are paid for again, and
 * the longer the session the larger that bill — which is why a cold session is
 * refused by default instead of quietly continued.
 */
function guardSessionAge(session, { config, flags, command }) {
  const ttlMs = resolveCacheTtlMs(config, { provider: session.provider });
  const state = cacheState(session, ttlMs);
  if (state === "cold" && !flags["stale-ok"]) {
    throw new Error(staleSessionMessage(session, { ttlMs, contextTokens: session.contextTokens, command }));
  }
  return {
    jobId: session.jobId,
    sessionId: session.sessionId,
    ageMs: session.ageMs,
    cache: state,
    staleOk: state === "cold"
  };
}

/**
 * Continue a recorded session with the agent it already had.
 *
 * The contour travels with the session — preset, model, sandbox, working
 * directory — because a continuation resumed under different equipment is a
 * different agent reading the same history, and in the sandboxed case it is not
 * even that: the session lives in the agent volume, so a continuation without
 * the sandbox cannot see it at all.
 */
async function commandContinue(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, RUN_FLAGS);
  const words = [...positional];
  // `continue last "…"`: a positional is taken as the reference only when it
  // cannot be mistaken for the first word of the task.
  const reference = flags.session ?? (words.length > 1 && isSessionReference(words[0]) ? words.shift() : null);

  const handedOver = takeDetachedPrompt();
  const piped = !handedOver && flags.stdin ? readStdin().trim() : "";
  const prompt = handedOver ?? [words.join(" ").trim(), piped].filter(Boolean).join("\n\n");
  if (!prompt) {
    throw new Error(
      "Nothing to continue with. Usage: continue [<session-id|job-id|last>] <what to do next>. " +
        "What can be continued here is listed by `sessions`."
    );
  }

  const { config, warnings: configWarnings } = loadConfig(workspaceRoot);
  // The detached copy re-executes this command line; the session its parent
  // resolved travels in the environment so "last" cannot drift under it.
  const inherited = process.env[DETACHED_SESSION_ENV] || null;
  const sessions = workspaceSessions(workspaceRoot);
  const session = findSession(sessions, inherited ?? reference);
  if (!session) {
    throw new Error(
      sessions.length
        ? `No session here matches "${reference}". Sessions recorded for this workspace: ${sessions
            .slice(0, 5)
            .map((entry) => entry.sessionId.slice(0, 8))
            .join(", ")}. Full list: \`sessions\`.`
        : "No pi session recorded for this workspace. Job state is bucketed by the directory a run was started from, " +
            "so a session started elsewhere is not lost — run `sessions --global` to find its workspace, or start a " +
            "run here with `delegate`."
    );
  }
  if (session.live) {
    throw new Error(
      `Job ${session.jobId} is still running on session \`${session.sessionId}\`. Send it a message with ` +
        `\`steer ${session.jobId} "…"\`, or wait for it with \`wait ${session.jobId}\` and continue after.`
    );
  }

  const continuation = guardSessionAge(session, {
    config,
    flags: inherited ? { ...flags, "stale-ok": true } : flags,
    command: "continue"
  });

  // The recipe of the run that owns the session is the floor; flags override it
  // the way they do on `rerun`.
  const recipe = session.recipe ?? {};
  const runRoot = resolveRunRoot(flags.cwd ?? session.runRoot ?? null);
  const merged = {
    ...flags,
    preset: flags.preset ?? recipe.preset,
    model: flags.model ?? recipe.model,
    provider: flags.provider ?? recipe.provider,
    thinking: flags.thinking ?? recipe.thinking,
    engine: flags.engine ?? recipe.engine,
    sandbox: flags.sandbox ?? recipe.sandbox,
    ...(recipe.readOnly && !flags.write ? { "read-only": true } : {}),
    timeout: flags.timeout ?? (recipe.timeoutMs ? String(Math.round(recipe.timeoutMs / 1000)) : undefined)
  };

  const settings = buildRunSettings({
    command: "delegate",
    flags: merged,
    workspaceRoot,
    runRoot,
    config,
    trusted: workspaceIsTrusted(runRoot)
  });
  settings.budget = settings.budget ?? recipe.budget ?? null;
  settings.warnings = [...(configWarnings ?? []), ...settings.warnings];
  settings.continuation = continuation;

  const title = `Continue ${session.jobId}: ${prompt.split("\n")[0].slice(0, 100)}`;
  const jobId = process.env[DETACHED_JOB_ENV] || generateJobId("delegate");
  if (flags.background && process.env[DETACHED_ENV] !== "1") {
    detachBackgroundRun({
      kind: "delegate",
      workspaceRoot,
      jobId,
      title,
      prompt,
      settings,
      env: { [DETACHED_SESSION_ENV]: session.sessionId }
    });
    return 0;
  }

  const { job, execution } = await executeRun({
    kind: "delegate",
    jobId,
    title,
    prompt,
    settings,
    workspaceRoot,
    runRoot,
    flags,
    resultTitle: "pi continued session",
    // `--fresh` keeps the agent and drops the history: the way out when the
    // session is too cold to be worth re-sending.
    sessionId: flags.fresh ? null : session.sessionId
  });

  output(execution.rendered, { job: job.id, ...execution }, Boolean(flags.json));
  return execution.exitStatus === 0 ? 0 : 1;
}

/** What can be continued here, and how warm the cache behind each still is. */
async function commandSessions(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, { booleans: ["json", "all", "global"] });
  const { config } = loadConfig(workspaceRoot);
  const everywhere = Boolean(flags.global);
  const found = workspaceSessions(workspaceRoot, { global: everywhere });
  const filtered = positional.length ? [findSession(found, positional[0])].filter(Boolean) : found;
  const rows = (flags.all || positional.length ? filtered : filtered.slice(0, 10)).map((session) => ({
    ...session,
    // Each row is judged against its own provider's window, since that is what
    // decides whether continuing it reads from cache.
    ttlMs: resolveCacheTtlMs(config, { provider: session.provider })
  }));

  const rendered = renderSessionsReport(rows, {
    workspace: workspaceRoot,
    global: everywhere,
    ttlMs: resolveCacheTtlMs(config, {})
  });
  output(rendered, { sessions: rows, total: found.length }, Boolean(flags.json));
  return 0;
}

async function commandDelegate(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, RUN_FLAGS);
  // A detached run gets the text its parent already assembled: re-reading stdin
  // here would find it closed and quietly drop whatever was piped in.
  const handedOver = takeDetachedPrompt();
  const piped = !handedOver && flags.stdin ? readStdin().trim() : "";
  const prompt = handedOver ?? [positional.join(" ").trim(), piped].filter(Boolean).join("\n\n");

  if (!prompt) {
    throw new Error("Nothing to delegate. Pass the task text, e.g. `/pi:delegate investigate the flaky test`.");
  }

  const { config, warnings: configWarnings } = loadConfig(workspaceRoot);
  const runRoot = resolveRunRoot(flags.cwd);
  const settings = buildRunSettings({
    command: "delegate",
    flags,
    workspaceRoot,
    runRoot,
    config,
    trusted: workspaceIsTrusted(runRoot)
  });
  // Anything the project layer was not allowed to set has to be visible: a
  // silently ignored setting looks exactly like one that did not work.
  settings.warnings = [...(configWarnings ?? []), ...settings.warnings];
  const sessionId = flags.fresh ? null : resolveSessionReference(workspaceRoot, flags.session);
  // A session named here is continued as-is: `delegate` keeps the flags it was
  // given and inherits nothing from the run that owns the session. The age of
  // the cache is still checked — it costs the same money either way.
  const continued = sessionId ? findSession(workspaceSessions(workspaceRoot), sessionId) : null;
  if (continued) {
    settings.continuation = guardSessionAge(continued, { config, flags, command: "delegate" });
    if (continued.preset && !flags.preset) {
      settings.warnings.push(
        `Session \`${continued.sessionId.slice(0, 8)}\` last ran under preset \`${continued.preset}\`, which ` +
          "`delegate --session` does not inherit — `continue` does, sandbox included."
      );
    }
  }

  const title = prompt.split("\n")[0].slice(0, 120);
  const jobId = process.env[DETACHED_JOB_ENV] || generateJobId("delegate");
  if (flags.background && process.env[DETACHED_ENV] !== "1") {
    detachBackgroundRun({ kind: "delegate", workspaceRoot, jobId, title, prompt, settings });
    return 0;
  }

  const { job, execution } = await executeRun({
    kind: "delegate",
    jobId,
    title,
    prompt,
    settings,
    workspaceRoot,
    runRoot,
    flags,
    resultTitle: "pi delegated task",
    sessionId
  });

  output(execution.rendered, { job: job.id, ...execution }, Boolean(flags.json));
  return execution.exitStatus === 0 ? 0 : 1;
}

async function commandReview(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, RUN_FLAGS);
  // The diff under review belongs to the tree the agent will read, so every git
  // question is asked of the run root.
  let runRoot = resolveRunRoot(flags.cwd);

  // `--job <id>` reviews exactly what another run changed: the natural next
  // step after delegating work, and the one that used to need the base commit
  // to be looked up by hand.
  const reviewed = flags.job ? resolveResultJob(workspaceRoot, flags.job) : null;
  if (reviewed) {
    const before = reviewed.stored?.treeBefore ?? reviewed.job.treeBefore ?? null;
    if (!before?.head) {
      throw new Error(
        `Job ${reviewed.job.id} has no tree snapshot to review — it ran outside a git repository, or before snapshots existed.`
      );
    }
    // The run may have worked in another tree (--cwd, or a worktree), and that
    // is the tree its changes live in.
    runRoot = reviewed.stored?.runRoot ?? reviewed.job.runRoot ?? runRoot;
  }
  ensureGitRepository(runRoot);

  const target = reviewed
    ? {
        scope: "job",
        base: (reviewed.stored?.treeBefore ?? reviewed.job.treeBefore).head,
        branch: getCurrentBranch(runRoot),
        description: `the changes made by job ${reviewed.job.id}${reviewed.job.title ? ` (${reviewed.job.title})` : ""}`
      }
    : resolveReviewTarget(runRoot, {
        scope: flags.scope ?? "auto",
        base: flags.base ?? null
      });
  const context = reviewed
    ? collectTreeDiff(runRoot, reviewed.stored?.treeBefore ?? reviewed.job.treeBefore)
    : collectReviewContext(runRoot, target);
  if (!context.text.trim()) {
    throw new Error(
      reviewed
        ? `Job ${reviewed.job.id} left the tree unchanged; there is nothing to review.`
        : "Nothing to review: the resolved diff is empty."
    );
  }

  const { config } = loadConfig(workspaceRoot);
  const settings = buildRunSettings({
    command: "review",
    flags,
    workspaceRoot,
    runRoot,
    config,
    trusted: workspaceIsTrusted(runRoot)
  });

  const focus = positional.join(" ").trim();
  // A detached run reviews the diff its parent captured, rather than the tree
  // as it happens to look once the child starts.
  const prompt = takeDetachedPrompt() ?? interpolate(loadTaskTemplate(PLUGIN_ROOT, "review"), {
    TARGET: target.description,
    BRANCH: target.branch,
    BASE: target.base ?? "(working tree)",
    FOCUS: focus || "No extra focus was requested; review everything in the diff.",
    TRUNCATED: context.truncated
      ? "The diff below was truncated. Read the files directly for anything that looks cut off."
      : "",
    DIFF: context.text
  });

  const title = `Review ${target.description}${focus ? ` — ${focus.slice(0, 60)}` : ""}`;
  const jobId = process.env[DETACHED_JOB_ENV] || generateJobId("review");
  if (flags.background && process.env[DETACHED_ENV] !== "1") {
    detachBackgroundRun({ kind: "review", workspaceRoot, jobId, title, prompt, settings });
    return 0;
  }

  const { job, execution } = await executeRun({
    kind: "review",
    jobId,
    title,
    prompt,
    settings,
    workspaceRoot,
    runRoot,
    flags,
    resultTitle: `pi review — ${target.description}`
  });

  output(execution.rendered, { job: job.id, target, ...execution }, Boolean(flags.json));
  return execution.exitStatus === 0 ? 0 : 1;
}

async function commandStatus(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, {
    booleans: ["json", "all", "global", "running"],
    strings: ["status", "preset", "model"]
  });
  const snapshot = buildStatusSnapshot(workspaceRoot, {
    jobId: positional[0] ?? null,
    all: Boolean(flags.all),
    // The fleet view: every workspace on this machine, not just this checkout.
    global: Boolean(flags.global),
    // `--running` is the shorthand for the only filter anyone types by hand.
    status: flags.running ? "running,pending" : (flags.status ?? null),
    preset: flags.preset ?? null,
    model: flags.model ?? null
  });
  output(renderStatusReport(snapshot), snapshot, Boolean(flags.json));
  return 0;
}

async function commandResult(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, { booleans: ["json", "diff"] });
  const { job, stored } = resolveResultJob(workspaceRoot, positional[0] ?? null);

  // The patch is read from the tree on demand rather than stored with the job:
  // it can be megabytes, and the answer to "show me what it wrote" is only
  // wanted for a run in a handful of cases.
  if (flags.diff) {
    const before = stored?.treeBefore ?? job.treeBefore ?? null;
    if (!before?.head) {
      throw new Error(
        `Job ${job.id} has no tree snapshot to diff against — it ran outside a git repository, or before snapshots existed.`
      );
    }
    const runRoot = stored?.runRoot ?? job.runRoot ?? workspaceRoot;
    const diff = collectTreeDiff(runRoot, before);
    // A diff against a commit cannot separate the agent's work from anything
    // else that happened in the same tree since. Naming those files is the
    // honest version: dropping them would hide edits the agent also made.
    const alsoMine = (before.dirty ?? []).length
      ? `\n\nAlready modified when the run started, so anything here is not necessarily the agent's: ${before.dirty
          .slice(0, 20)
          .join(", ")}${before.dirty.length > 20 ? `, and ${before.dirty.length - 20} more` : ""}.`
      : "";
    const rendered = diff.text.trim()
      ? `# pi result — \`${job.id}\` diff\n\nAgainst \`${before.head.slice(0, 12)}\`, the commit the run started from.${alsoMine}\n\n${diff.text}`
      : `# pi result — \`${job.id}\` diff\n\nThe tree is unchanged since the run started.`;
    output(rendered, { job: job.id, base: before.head, diff: diff.text, truncated: diff.truncated }, Boolean(flags.json));
    return 0;
  }

  output(renderStoredJobResult(job, stored), { job, stored }, Boolean(flags.json));
  return 0;
}

/**
 * Send a message into a running job.
 *
 * While pi is working the message is delivered as steering (after the current
 * assistant turn finishes its tool calls, before the next LLM call); a job that
 * has already settled is re-opened with the message as a new prompt.
 */
async function commandSteer(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, {
    booleans: ["json", "follow-up"],
    strings: ["job"]
  });

  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).map(enrichJob);
  // Match the same way every other command does: an abbreviated id is a job
  // reference, not the first word of the message. Comparing only full ids left
  // "4f2a" glued to the front of the text and sent to whichever job was newest.
  const looksLikeReference =
    positional[0] && jobs.some((job) => job.id === positional[0] || job.id.endsWith(positional[0]));
  const explicitId = flags.job ?? (looksLikeReference ? positional.shift() : null);
  const message = positional.join(" ").trim();

  if (!message) {
    throw new Error('Nothing to send. Usage: steer [job-id] "your instruction".');
  }

  const target = explicitId
    ? jobs.find((job) => job.id === explicitId || job.id.endsWith(explicitId))
    : jobs.find((job) => job.status === "running");

  if (!target) {
    throw new Error(
      explicitId ? `No pi job matches "${explicitId}".` : "No running pi job to steer."
    );
  }
  if (target.status !== "running") {
    throw new Error(
      `Job ${target.id} is ${target.status}, so it cannot be steered. Continue its session instead: \`continue ${target.sessionId ?? "last"} "…"\`.`
    );
  }
  if (target.engine === "json") {
    throw new Error(
      `Job ${target.id} runs on the one-shot json engine and has no control channel. Re-run it with --engine rpc (the default) to steer it.`
    );
  }

  const kind = flags["follow-up"] ? "follow_up" : "steer";
  const entry = pushControlMessage(workspaceRoot, target.id, { kind, message });
  appendLogLine(target.logFile, `Queued ${kind} from Claude Code: ${message}`);

  const payload = { job: target.id, ...entry };
  const rendered = joinReport([
    `Sent ${kind === "steer" ? "steering message" : "follow-up"} to \`${target.id}\`.`,
    "",
    `> ${message}`,
    "",
    kind === "steer"
      ? "pi picks it up after the current assistant turn finishes its tool calls."
      : "pi picks it up once it finishes the current work.",
    "Watch it land with `watch --follow`."
  ]);

  output(rendered, payload, Boolean(flags.json));
  return 0;
}

function joinReport(lines) {
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Replay (and optionally follow) a job's event stream as a readable transcript.
 *
 * A background job outlives the turn that started it, so watching has to work
 * in slices: `--since` continues from the cursor the previous call printed, and
 * `--for` bounds `--follow` so it always returns to the caller.
 */
async function commandWatch(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, {
    booleans: ["json", "follow"],
    strings: ["tail", "since", "for"]
  });

  const reference = positional[0] ?? null;
  const findTarget = () => {
    const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).map(enrichJob);
    if (!jobs.length) {
      return null;
    }
    return reference
      ? (jobs.find((job) => job.id === reference || job.id.endsWith(reference)) ?? null)
      : (jobs.find((job) => job.status === "running") ?? jobs[0]);
  };

  // `delegate --background` prints the job id before the detached child has
  // written the record, so a watch fired immediately after it would look for a
  // job that exists only as an id. Following means waiting for it to show up;
  // without --follow the caller gets the error straight away, as before.
  let target = findTarget();
  if (!target && flags.follow && reference) {
    const appearBy = Date.now() + JOB_APPEARANCE_GRACE_MS;
    while (!target && Date.now() < appearBy) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      target = findTarget();
    }
  }

  if (!target) {
    throw new Error(
      reference
        ? `No pi job matches "${reference}".`
        : "No pi jobs recorded for this workspace yet."
    );
  }

  const file = target.eventsFile ?? eventsPath(workspaceRoot, target.id);
  const tailLimit = flags.tail ? Math.max(1, Number(flags.tail)) : null;
  const since = flags.since ? Math.max(0, Number(flags.since)) : 0;
  if (!Number.isFinite(since)) {
    throw new Error(`--since expects a cursor number, got "${flags.since}".`);
  }
  const followSeconds = flags.for ? Number(flags.for) : null;
  if (followSeconds != null && (!Number.isFinite(followSeconds) || followSeconds <= 0)) {
    throw new Error(`--for expects a number of seconds, got "${flags.for}".`);
  }
  const deadline = followSeconds ? Date.now() + followSeconds * 1000 : null;

  const reader = createEventReader(file);
  const readEvents = (fromLine) => reader.read(fromLine);

  const initial = readEvents(since);
  if (flags.json) {
    // --tail applied only to the rendered path, so `--json --tail 20` dumped the
    // entire transcript: on a long run that is megabytes of JSON, and it lands
    // in the context of whoever asked for twenty lines.
    const events = tailLimit ? initial.events.slice(-tailLimit) : initial.events;
    output(
      "",
      { job: target, events, cursor: initial.nextLine, since, truncated: events.length < initial.events.length },
      true
    );
    return 0;
  }

  // Rendering is stateful (tool calls pair up with their results), so a run
  // that starts mid-stream replays the skipped events into a throwaway state.
  const state = {};
  if (since > 0) {
    // A separate reader: the main one streams forward and drops what it has
    // handed over, so it cannot serve a second pass from the beginning.
    for (const event of createEventReader(file).read(0).events.slice(0, since)) {
      renderTranscriptEvent(event, state);
    }
  }

  let lines = initial.events.flatMap((event) => renderTranscriptEvent(event, state));
  if (tailLimit) {
    lines = lines.slice(-tailLimit);
  }

  const cursorHint = (cursor, status) =>
    `\n_Cursor ${cursor}${status === "running" ? `; continue with \`watch ${target.id} --since ${cursor}\`` : ""}._\n`;

  process.stdout.write(
    `# pi transcript — \`${target.id}\` (${target.status})\n${target.title ? `\n${target.title}\n` : ""}\n`
  );
  process.stdout.write(
    lines.length ? `${lines.join("\n")}\n` : since ? "_Nothing new since the last check._\n" : "_No events recorded yet._\n"
  );

  if (!flags.follow) {
    if (target.status === "running") {
      process.stdout.write(
        "\n_Job is still running. Re-run watch, or add --follow (with --for <seconds> to bound it)._"
      );
    }
    process.stdout.write(cursorHint(initial.nextLine, target.status));
    return 0;
  }

  // Follow mode: stream until the job stops running and the file is drained,
  // or until the --for deadline, whichever comes first.
  let cursor = initial.nextLine;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const next = readEvents(cursor);
    cursor = next.nextLine;
    for (const event of next.events) {
      const rendered = renderTranscriptEvent(event, state);
      if (rendered.length) {
        process.stdout.write(`${rendered.join("\n")}\n`);
      }
    }
    const current = enrichJob(listJobs(workspaceRoot).find((job) => job.id === target.id) ?? target);
    if (isTerminalStatus(current.status) && !next.events.length) {
      process.stdout.write(`\n■ job ${current.status}\n`);
      process.stdout.write(cursorHint(cursor, current.status));
      return 0;
    }
    if (deadline && Date.now() >= deadline) {
      process.stdout.write(`\n■ still ${current.status} after ${followSeconds}s\n`);
      process.stdout.write(cursorHint(cursor, current.status));
      return 0;
    }
  }
}

/**
 * Manage the container image the sandbox runs in.
 *
 * The image is pinned to the host pi version by default, so a sandboxed agent
 * behaves like the one running on the host instead of drifting to whatever npm
 * publishes next.
 */
/**
 * Token accounting across every workspace, from the durable journal rather than
 * the per-workspace job files (which are capped, split by directory and live in
 * a temp tree).
 */
async function commandStats(argv, workspaceRoot) {
  const { flags } = parseArgs(argv, {
    booleans: ["json", "all"],
    strings: ["by", "days", "limit"]
  });

  const handle = openDatabase();
  if (!handle) {
    throw new Error(
      `Cannot open the job journal at ${databasePath()}. It needs Node 22.3+ with node:sqlite.`
    );
  }

  try {
    const days = flags.all ? null : positiveNumber(flags.days ?? 30, "--days");
    const by = flags.by ?? "day";
    const rows = queryStats(handle, { by, days, limit: positiveNumber(flags.limit ?? 50, "--limit") });
    const totals = queryTotals(handle, { days });

    output(
      renderStatsReport({ rows, totals, by, days, database: databasePath() }),
      { by, days, database: databasePath(), totals, rows },
      Boolean(flags.json)
    );
    return 0;
  } finally {
    handle.close();
  }
}

async function commandSandbox(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, {
    booleans: ["json", "no-cache", "all"],
    strings: ["image", "pi-version", "dockerfile"]
  });

  const action = positional[0] ?? "status";
  const { config } = loadConfig(workspaceRoot);
  const configured = normalizeSandbox(config.defaults?.sandbox ?? null, config.sandboxProfiles);
  const image = flags.image ?? (isSandboxed(configured) ? configured.image : DEFAULT_SANDBOX_IMAGE);

  if (action === "build") {
    // Which images to build: every one the config knows about with --all, the
    // one a named profile uses when a name is given, the base otherwise.
    const known = listSandboxImages(config);
    const requested = positional[1] ?? null;
    let targets;
    if (flags.all) {
      targets = known;
    } else if (requested) {
      const match = known.find((entry) => entry.name === requested || entry.profiles.includes(requested));
      if (!match) {
        throw new Error(
          `Unknown sandbox image "${requested}". Known: ${known.map((entry) => entry.name).join(", ")}.`
        );
      }
      targets = [match];
    } else {
      targets = [
        {
          name: "base",
          image,
          dockerfile: flags.dockerfile ?? "base",
          profiles: []
        }
      ];
    }

    const piVersion = flags["pi-version"] ?? getPiAvailability(workspaceRoot).version ?? null;
    const results = [];
    for (const target of targets) {
      process.stderr.write(
        `Building \`${target.image}\` from ${sandboxDockerfile(target.dockerfile, { workspaceRoot })}` +
          `${piVersion ? ` with pi ${piVersion}` : ""}.\n`
      );
      const build = buildSandboxImage({
        image: target.image,
        dockerfile: target.dockerfile,
        workspaceRoot,
        piVersion,
        noCache: Boolean(flags["no-cache"])
      });
      results.push({ ...target, status: build.status, dockerfilePath: build.dockerfile, command: build.command });
      if (build.status !== 0) {
        break;
      }
    }

    const failed = results.find((entry) => entry.status !== 0);
    output(
      failed
        ? `Failed to build \`${failed.image}\` (docker exited ${failed.status}).\n`
        : `Built ${results.map((entry) => `\`${entry.image}\``).join(", ")}${piVersion ? ` with pi ${piVersion}` : ""}.\n`,
      { action, piVersion, images: results },
      Boolean(flags.json)
    );
    return failed ? 1 : 0;
  }

  if (action === "clean") {
    const containers = listSandboxContainers();
    // A running container belongs to a live run: removing it kills the agent
    // mid-task, and the job record is left claiming it is still working. Clean
    // is for leftovers, so live ones need saying so out loud and asking again.
    const live = containers.filter((container) => /^Up\b/i.test(String(container.status ?? "")));
    if (live.length && !flags.all) {
      output(
        `${live.length} sandbox container(s) are still running: ${live.map((c) => `\`${c.name}\``).join(", ")}.\n` +
          "Stop them with `/pi:cancel <job-id>`, or re-run `sandbox clean --all` to remove them anyway.\n",
        { action, live: live.map((container) => container.name), removed: [] },
        Boolean(flags.json)
      );
      return 1;
    }
    const removed = containers.filter((container) => removeSandboxContainer(container.name));
    const payload = { action, removed: removed.map((container) => container.name), killedLive: flags.all ? live.length : 0 };
    output(
      removed.length
        ? `Removed ${removed.length} sandbox container(s): ${removed.map((c) => `\`${c.name}\``).join(", ")}.\n`
        : "No sandbox containers to remove.\n",
      payload,
      Boolean(flags.json)
    );
    return 0;
  }

  if (action !== "status") {
    throw new Error(`Unknown sandbox action "${action}". Use status, build or clean.`);
  }

  const report = {
    ...sandboxStatus(isSandboxed(configured) ? configured : { image }, {
      images: listSandboxImages(config),
      workspaceRoot
    }),
    image,
    configured: describeSandbox(configured)
  };
  output(renderSandboxReport(report), report, Boolean(flags.json));
  return 0;
}

/**
 * Stop one job: ask pi to abort, then signal, then take the container down.
 *
 * Each step is a fallback for the one before: the control channel keeps the
 * session and the partial work, a signal reaches a run with no channel, and
 * removing the container is the only thing that helps a job whose wrapper is
 * already gone. Records live in the job's own workspace, which is not
 * necessarily the one the command was typed in.
 */
async function cancelJob(job, { wait = true } = {}) {
  const workspaceRoot = job.workspaceRoot;
  let cancelled = false;

  if (job.engine !== "json" && job.status === "running") {
    pushControlMessage(workspaceRoot, job.id, { kind: "abort" });
    appendLogLine(job.logFile, "Abort requested from Claude Code.");
    // Skipped when cancelling a fleet: four seconds per job turns "stop
    // everything" into a minute of waiting, and the signal below is what
    // actually stops a run that ignores the channel.
    for (let waited = 0; wait && waited < 4000; waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const current = listJobs(workspaceRoot).find((entry) => entry.id === job.id);
      if (current && current.status !== "running") {
        cancelled = true;
        break;
      }
    }
  }

  if (!cancelled) {
    // pi runs in its own process group; the companion wrapper does not.
    const piStopped = job.piPid ? await terminateProcessTree(job.piPid, { group: true }) : false;
    const wrapperStopped = job.pid ? await terminateProcessTree(job.pid, { group: false }) : false;
    cancelled = piStopped || wrapperStopped;
  }

  // Signals reach the `docker run` client, never the container behind it, so a
  // sandboxed job is only really stopped once the container is gone.
  // A run with no sandbox has no container to remove; only guess a name when
  // the job actually had one.
  const containerName =
    job.containerName ?? (job.sandbox || job.sandboxProfile ? containerNameForJob(job.id, job.sandboxProfile ?? null) : null);
  if (containerName) {
    const removed = removeSandboxContainer(containerName);
    cancelled = cancelled || removed;
  }

  const record = { id: job.id, status: "cancelled", phase: "cancelled", pid: null, completedAt: nowIso() };
  upsertJob(workspaceRoot, record);
  // The journal only ever heard about a job from runTrackedJob, so a cancelled
  // or orphaned run stayed `running` there for good: it counted against the
  // success rate of every report and could never be corrected.
  recordJobSafely({ ...job, ...(readStoredJob(workspaceRoot, job.id) ?? {}), ...record });
  // Keep whatever the run already stored (partial output, session id) and only
  // overlay the cancellation.
  writeJobFile(workspaceRoot, job.id, {
    ...job,
    ...(readStoredJob(workspaceRoot, job.id) ?? {}),
    ...record
  });

  return cancelled;
}

async function commandCancel(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, { booleans: ["json", "all", "global"] });

  // `--all` is the fleet lever: several repositories delegating at once used to
  // mean one `cancel <id>` per run, with the ids looked up by hand first.
  if (flags.all || flags.global) {
    const targets = listCancelableJobs(workspaceRoot, { global: Boolean(flags.global) });
    if (!targets.length) {
      throw new Error(
        flags.global ? "No pi jobs are running on this machine." : "No running pi job to cancel in this workspace."
      );
    }
    const results = [];
    for (const job of targets) {
      results.push({ job, cancelled: await cancelJob(job, { wait: false }) });
    }
    output(
      renderCancelAllReport(results, { global: Boolean(flags.global) }),
      { cancelled: results.map(({ job, cancelled }) => ({ id: job.id, workspace: job.workspaceRoot, cancelled })) },
      Boolean(flags.json)
    );
    return results.every(({ cancelled }) => cancelled) ? 0 : 1;
  }

  const job = resolveCancelableJob(workspaceRoot, positional[0] ?? null);
  const stoppable = isCancelable(job);
  const cancelled = stoppable ? await cancelJob({ ...job, workspaceRoot: job.workspaceRoot ?? workspaceRoot }) : false;

  output(renderCancelReport(job, cancelled), { job, cancelled }, Boolean(flags.json));
  return cancelled || !stoppable ? 0 : 1;
}

/**
 * The fleet channel as a stream.
 *
 * `wait` answers one question once — "are these jobs done yet" — and then it is
 * gone, which makes it a waiter that has to be re-armed for every wave and can
 * die between them without saying so. `events --follow` is the other shape: one
 * long-lived reader of the machine-wide log, arming once and covering every run
 * from every workspace until it is stopped. That is what a supervisor watching
 * for "an agent finished" actually needs, and what a Claude Code Monitor turns
 * into one chat notification per line.
 *
 * The poll exists for the one ending nobody can announce from inside: a run
 * whose process was killed writes nothing, and only a sweep notices its pid is
 * gone. Those are folded into the same stream as `orphaned`, so silence in this
 * channel means "still working" and never "died quietly".
 */
async function commandEvents(argv, workspaceRoot) {
  const { flags } = parseArgs(argv, {
    booleans: ["json", "follow", "workspace"],
    strings: ["for", "tail", "poll"]
  });

  // Following starts at the end of the log by default: replaying an epic's
  // worth of finished runs into the chat is noise, and what a follower is armed
  // for is the ending that has not happened yet. `--tail N` asks for catch-up.
  const tailCount =
    flags.tail === undefined ? (flags.follow ? 0 : DEFAULT_EVENT_TAIL) : Number(flags.tail);
  if (!Number.isFinite(tailCount) || tailCount < 0) {
    throw new Error(`--tail expects a count, got "${flags.tail}".`);
  }
  const pollSeconds =
    flags.poll === undefined ? DEFAULT_EVENT_POLL_SECONDS : positiveNumber(flags.poll, "--poll");
  const followSeconds = flags.for === undefined ? null : positiveNumber(flags.for, "--for");

  const belongsHere = (event) => !flags.workspace || event.workspaceRoot === workspaceRoot;
  const write = (event) => {
    process.stdout.write(flags.json ? `${JSON.stringify(event)}\n` : `${formatFleetEvent(event)}\n`);
  };

  const history = readFleetEvents();

  if (!flags.follow) {
    const rows = history.events.filter(belongsHere).slice(-tailCount);
    if (!rows.length && !flags.json) {
      process.stdout.write(
        "No finished pi runs recorded yet. The log fills as runs end; `--follow` waits for the next one.\n"
      );
      return 0;
    }
    for (const event of rows) {
      write(event);
    }
    return 0;
  }

  const seen = new Set(history.events.map(eventKey));
  const caughtUp = tailCount > 0 ? history.events.slice(-tailCount) : [];
  for (const event of caughtUp) {
    if (belongsHere(event)) {
      write(event);
    }
  }
  let cursor = history.nextLine;

  if (!flags.json) {
    process.stdout.write(
      `pi fleet channel armed · watching ${flags.workspace ? "this workspace" : "every workspace"} · ` +
        `${history.events.length} run(s) already in the log · orphan sweep every ${pollSeconds}s\n`
    );
  }

  const deadline = followSeconds === null ? null : Date.now() + followSeconds * 1000;
  // Two clocks, because the two kinds of ending arrive differently. Announced
  // endings are already written when the run ends, so the log is read often and
  // the notification is nearly immediate; a killed run is only visible as a
  // dead pid, and that sweep is the expensive one — it reads every bucket on
  // the machine — so it runs on the slower interval.
  let nextSweep = Date.now() + pollSeconds * 1000;
  for (;;) {
    const next = readFleetEvents({ from: cursor });
    cursor = next.nextLine;
    for (const event of next.events) {
      const key = eventKey(event);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (belongsHere(event)) {
        write(event);
      }
    }

    if (Date.now() >= nextSweep) {
      nextSweep = Date.now() + pollSeconds * 1000;
      // A killed run leaves no line of its own, so the sweep writes one for it
      // — into the log, not just to this stream, so a second follower does not
      // report the same death twice.
      const jobs = (flags.workspace ? listJobs(workspaceRoot) : listJobsEverywhere()).map(enrichJob);
      for (const event of orphanEvents(jobs, seen)) {
        seen.add(eventKey(event));
        recordFleetEvent(event);
        cursor = readFleetEvents({ from: cursor }).nextLine;
        if (belongsHere(event)) {
          write(event);
        }
      }
    }

    if (deadline !== null && Date.now() >= deadline) {
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, EVENT_LOG_POLL_MS));
  }
}

/**
 * Block until background jobs finish.
 *
 * `delegate --background` hands the run to a detached process and returns
 * immediately, which is the point — but a caller that has nothing else to do
 * until the answer exists had only polling `status` to work with. This waits on
 * the job records and returns once every target has reached a terminal state.
 */
async function commandWait(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, { booleans: ["json", "all"], strings: ["for"] });

  const waitSeconds = flags.for ? Number(flags.for) : DEFAULT_WAIT_SECONDS;
  if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) {
    throw new Error(`--for expects a number of seconds, got "${flags.for}".`);
  }
  const deadline = Date.now() + waitSeconds * 1000;

  const snapshot = () => sortJobsNewestFirst(listJobs(workspaceRoot)).map(enrichJob);
  const targetsOf = (jobs) => {
    if (positional.length) {
      return positional.map((reference) => {
        const job = jobs.find((entry) => entry.id === reference || entry.id.endsWith(reference));
        if (!job) {
          throw new Error(`No pi job matches "${reference}".`);
        }
        return job.id;
      });
    }
    const live = jobs.filter((job) => !isTerminalStatus(job.status));
    if (!live.length) {
      throw new Error(
        flags.all ? "No pi jobs are running in this workspace." : "No running pi job to wait for."
      );
    }
    return flags.all ? live.map((job) => job.id) : [live[0].id];
  };

  // A job id printed by `delegate --background` can reach this command before
  // the detached child has written its record, exactly as with `watch --follow`.
  //
  // The wait is on the named jobs appearing, not on the bucket being empty:
  // keyed on emptiness it only ever helped in a fresh workspace, and in a
  // lived-in one — where every id but the newest is already on disk — the
  // just-started job fell straight through to "No pi job matches" and a
  // non-zero exit within a second of being launched. A supervisor reading only
  // the notification sees that as the wave having finished.
  const missingReferences = (known) =>
    positional.filter(
      (reference) => !known.some((job) => job.id === reference || job.id.endsWith(reference))
    );

  let jobs = snapshot();
  if (positional.length) {
    // Never wait for an id past the caller's own deadline: `wait --for 5` that
    // spends 30 seconds looking for the job has stopped answering the question
    // it was asked.
    const appearBy = Math.min(Date.now() + JOB_APPEARANCE_GRACE_MS, deadline);
    while (missingReferences(jobs).length && Date.now() < appearBy) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      jobs = snapshot();
    }
  }

  const ids = targetsOf(jobs);
  let waited = [];
  let timedOut = false;
  for (;;) {
    waited = snapshot().filter((job) => ids.includes(job.id));
    if (waited.length === ids.length && waited.every((job) => isTerminalStatus(job.status))) {
      break;
    }
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }

  // A job cut off at the output ceiling completed in the exit-code sense and did
  // not finish in any sense that matters. `wait` is what a supervisor blocks on
  // before treating work as done, so it must not answer zero here: the ⚠️ in
  // `status` is no use to something that only reads the code.
  const failed = waited.filter((job) => job.status !== "completed" || job.phase === "truncated");
  output(
    renderWaitReport(waited, { timedOut, waitSeconds }),
    { jobs: waited, timedOut },
    Boolean(flags.json)
  );
  return timedOut || failed.length ? 1 : 0;
}

/**
 * The journal as a list: what was run, where, at what cost.
 *
 * `status` answers for this workspace and only while the records survive;
 * this reads the durable journal, which is the only thing that remembers a run
 * from last week or from a repository one has since deleted.
 */
async function commandRuns(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, {
    booleans: ["json", "all", "prune", "full"],
    strings: ["limit", "days", "model", "preset", "kind"]
  });

  const handle = openDatabase();
  if (!handle) {
    throw new Error(`The journal could not be opened (${databasePath()}). Node 22.3+ is needed for node:sqlite.`);
  }

  try {
    if (flags.prune) {
      const days = flags.days ? positiveNumber(flags.days, "--days") : DEFAULT_TEXT_TTL_DAYS;
      const cleared = pruneJournalText(handle, { days });
      output(
        joinReport([
          `# pi runs — pruned`,
          "",
          `Cleared the stored task and answer of ${cleared} run${cleared === 1 ? "" : "s"} older than ${days} days.`,
          "",
          "Counters, timings and costs are kept: statistics still cover the whole history."
        ]),
        { pruned: cleared, days },
        Boolean(flags.json)
      );
      return 0;
    }

    if (positional[0]) {
      const run = queryRun(handle, positional[0]);
      if (!run) {
        throw new Error(`No run matches "${positional[0]}" in the journal.`);
      }
      output(renderRunDetail(run), run, Boolean(flags.json));
      return 0;
    }

    const runs = queryRuns(handle, {
      limit: flags.limit ? positiveNumber(flags.limit, "--limit") : 20,
      days: flags.days ? positiveNumber(flags.days, "--days") : null,
      // The journal is machine-wide; `--all` opts into that, the default stays
      // with the workspace the caller is standing in.
      workspace: flags.all ? null : workspaceRoot,
      model: flags.model ?? null,
      preset: flags.preset ?? null,
      kind: flags.kind ?? null
    });
    output(renderRunsReport(runs, { workspace: flags.all ? null : workspaceRoot }), { runs }, Boolean(flags.json));
    return 0;
  } finally {
    handle.close();
  }
}

/**
 * Run a recorded task again.
 *
 * The point is comparison as much as repetition: `rerun <id> --model other` is
 * the same task, the same settings and a different model, which is the only
 * honest way to tell two models apart on work one actually does.
 */
/**
 * The task a rerun actually sends.
 *
 * Repeating a run verbatim is the rare case; the useful one is "that, but with
 * one thing changed" — which used to mean copying the text out of the journal
 * by hand and rebuilding every flag around it. `--prompt`/`--stdin` replace the
 * task and keep the settings, `--append` adds to it.
 *
 * Exported for the tests: the composition is the part worth pinning down, and
 * the command around it needs a model to exercise.
 *
 * @returns {string|null} null when there is no text at all — neither recorded
 *   nor supplied — which is the one case the caller has to refuse.
 */
export function composeRerunPrompt(recorded, { replacement = null, append = [] } = {}) {
  const base = String(replacement ?? recorded ?? "").trim();
  const extra = (Array.isArray(append) ? append : [append])
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
  if (!base && !extra.length) {
    return null;
  }
  // Blank line between the parts: the addition is a separate instruction, not
  // a continuation of the last sentence of the original task.
  return [base, ...extra].filter(Boolean).join("\n\n");
}

async function commandRerun(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, RUN_FLAGS);
  const reference = positional.join(" ").trim();
  if (!reference) {
    throw new Error(
      "Which run? Usage: rerun <job-id> [--append <text>] [--prompt <text>|--stdin] [--model <id>] [--preset <name>] [--background]."
    );
  }

  const handle = openDatabase();
  const stored = handle ? queryRun(handle, reference) : null;
  handle?.close();

  // The job file is consulted too: a run whose journal text has aged out, or
  // one recorded before the journal kept prompts, can still be repeated from
  // the record in its own workspace.
  const local = (() => {
    try {
      return resolveResultJob(workspaceRoot, reference).stored;
    } catch {
      return null;
    }
  })();

  // The job file wins over the journal: the journal's copy is redacted and
  // capped, which is right for storage and wrong as the text to send again.
  const recorded = local?.prompt ?? stored?.prompt ?? null;
  // Same handoff as `delegate`: a rerun whose text came in on stdin has it only
  // in the parent, and the recorded task is not the one the caller asked for.
  const handedOver = takeDetachedPrompt();
  const prompt =
    handedOver ??
    composeRerunPrompt(recorded, {
      replacement: flags.prompt ?? (flags.stdin ? readStdin().trim() : null),
      append: flags.append ?? []
    });
  if (!prompt) {
    throw new Error(
      `Run "${reference}" has no stored task text — it predates prompt journalling, or its text has passed the ${DEFAULT_TEXT_TTL_DAYS}-day retention. ` +
        "Pass --prompt (or --stdin) to supply the task and keep the run's settings."
    );
  }

  const recipe = local?.rerunSettings ?? (stored?.settings ? JSON.parse(stored.settings) : {});
  const runRoot = resolveRunRoot(flags.cwd ?? local?.runRoot ?? stored?.run_root ?? null);
  const { config, warnings: configWarnings } = loadConfig(workspaceRoot);

  // The recipe is the floor, the flags are the override: `--model` on a rerun
  // is the whole point of the command.
  const merged = {
    ...flags,
    preset: flags.preset ?? recipe.preset,
    model: flags.model ?? recipe.model,
    provider: flags.provider ?? recipe.provider,
    thinking: flags.thinking ?? recipe.thinking,
    engine: flags.engine ?? recipe.engine,
    sandbox: flags.sandbox ?? recipe.sandbox,
    ...(recipe.readOnly && !flags.write ? { "read-only": true } : {}),
    timeout: flags.timeout ?? (recipe.timeoutMs ? String(Math.round(recipe.timeoutMs / 1000)) : undefined)
  };

  const settings = buildRunSettings({
    command: "delegate",
    flags: merged,
    workspaceRoot,
    runRoot,
    config,
    trusted: workspaceIsTrusted(runRoot)
  });
  // Ceilings the original run carried survive unless the caller names new ones.
  settings.budget = settings.budget ?? recipe.budget ?? null;
  settings.warnings = [...(configWarnings ?? []), ...settings.warnings];

  const title = `Rerun of ${stored?.id ?? local?.id ?? reference}: ${prompt.split("\n")[0].slice(0, 100)}`;
  const jobId = process.env[DETACHED_JOB_ENV] || generateJobId("delegate");
  if (flags.background && process.env[DETACHED_ENV] !== "1") {
    // The detached copy re-runs this same command line and could resolve the
    // recorded task itself, but not the replacement or the appends the caller
    // just made — those travel with the prompt.
    detachBackgroundRun({ kind: "delegate", workspaceRoot, jobId, title, prompt, settings });
    return 0;
  }

  const { job, execution } = await executeRun({
    kind: "delegate",
    jobId,
    title,
    prompt,
    settings,
    workspaceRoot,
    runRoot,
    flags,
    resultTitle: "pi rerun",
    sessionId: null
  });

  output(execution.rendered, { job: job.id, ...execution }, Boolean(flags.json));
  return execution.exitStatus === 0 ? 0 : 1;
}

const COMMANDS = {
  setup: commandSetup,
  models: commandModels,
  presets: commandPresets,
  delegate: commandDelegate,
  review: commandReview,
  status: commandStatus,
  result: commandResult,
  runs: commandRuns,
  rerun: commandRerun,
  continue: commandContinue,
  sessions: commandSessions,
  events: commandEvents,
  wait: commandWait,
  cancel: commandCancel,
  steer: commandSteer,
  watch: commandWatch,
  stats: commandStats,
  sandbox: commandSandbox
};

async function main() {
  const [command, ...rawRest] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const rest = normalizeCommandArgs(rawRest);
  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(`Unknown command "${command}".\n\n${usage()}\n`);
    return 2;
  }

  // A misspelled flag used to be dropped from argv and its value left in the
  // prompt: `--modle opus fix the bug` ran on the default model with "opus fix
  // the bug" as the task. Refusing costs one retry; guessing costs a paid run.
  const unknownFlags = rest.filter((token) => /^--?[a-zA-Z]/.test(String(token)) && !KNOWN_FLAGS.has(canonicalFlag(token)));
  if (unknownFlags.length && !rest.includes("--")) {
    process.stderr.write(
      `Unknown flag(s): ${unknownFlags.join(", ")}.\n` +
        "Check the spelling, or put `--` before the task text to pass it through.\n\n" +
        `${usage()}\n`
    );
    return 2;
  }

  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  return handler(rest, workspaceRoot);
}

/**
 * Whether this file was executed rather than imported.
 *
 * Compared through realpath because the skill exposes the script as a symlink
 * (`~/.claude/skills/pi/scripts` → the plugin directory): argv holds the link,
 * `import.meta.url` the file it points at, and a plain string compare would
 * silently turn every CLI invocation into a no-op.
 */
function invokedAsScript() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Run the CLI only when this file is the entry point, so tests can import the
// settings resolution without the module parsing their argv as a command.
if (invokedAsScript()) {
  main()
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => {
      // The credential slice exists for the duration of the run and no longer.
      cleanupCredentialSlices();
    });
}
