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
import { loadConfig, resolveRunSettings, userConfigPath } from "./lib/config.mjs";
import { collectReviewContext, ensureGitRepository, resolveCommitIdentity, resolveReviewTarget } from "./lib/git.mjs";
import {
  appendLogLine,
  buildStatusSnapshot,
  createJobLogFile,
  createJobRecord,
  createProgressReporter,
  enrichJob,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  runTrackedJob,
  sortJobsNewestFirst
} from "./lib/jobs.mjs";
import { listModels, normalizeThinking, resolveModelSelection } from "./lib/models.mjs";
import { getPiAvailability, PI_BINARY, runPiTurn } from "./lib/pi.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { buildSystemPrompt, interpolate, listNamedPrompts, loadTaskTemplate } from "./lib/prompts.mjs";
import { inboxPath, pushControlMessage } from "./lib/inbox.mjs";
import { parseJsonLine } from "./lib/jsonl.mjs";
import { runPiRpcTurn } from "./lib/rpc.mjs";
import { renderTranscriptEvent } from "./lib/transcript.mjs";
import {
  attachMounts,
  buildSandboxImage,
  describeSandbox,
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
  nowIso,
  resolveDetachedLogFile,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  renderBackgroundStart,
  renderCancelReport,
  renderModelsReport,
  renderRunResult,
  renderSandboxReport,
  renderSetupReport,
  renderStatsReport,
  renderStatusReport,
  renderStoredJobResult
} from "./lib/render.mjs";
import { resolveRunRoot, resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { databasePath, openDatabase, queryStats, queryTotals } from "./lib/db.mjs";

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// Set on the detached copy of this process, so it runs the job instead of
// handing it off again, and both halves agree on the job id.
const DETACHED_ENV = "PI_PLUGIN_DETACHED";
const DETACHED_JOB_ENV = "PI_PLUGIN_JOB_ID";

const RUN_FLAGS = {
  booleans: [
    "background",
    "wait",
    "read-only",
    "write",
    "json",
    "fresh",
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
    "name",
    "base",
    "scope",
    "engine",
    "sandbox",
    "cwd",
    "git-name",
    "git-email"
  ],
  collect: ["append-system-prompt", "extension", "skill", "mount"],
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

function usage() {
  return [
    "Usage:",
    "  pi-companion.mjs setup [--json]",
    "  pi-companion.mjs models [search] [--json]",
    "  pi-companion.mjs delegate [flags] <prompt>",
    "  pi-companion.mjs review [flags] [focus text]",
    "  pi-companion.mjs status [job-id] [--all] [--json]",
    "  pi-companion.mjs result [job-id] [--json]",
    "  pi-companion.mjs cancel [job-id] [--json]",
    "  pi-companion.mjs steer [job-id] [--follow-up] <message>",
    "  pi-companion.mjs watch [job-id] [--follow [--for <s>]] [--since <cursor>] [--tail <n>] [--json]",
    "  pi-companion.mjs stats [--by day|model|preset|workspace|kind] [--days N|--all] [--json]",
    "  pi-companion.mjs sandbox [status|build [name|--all]|clean] [--image <tag>]",
    "                            [--dockerfile <name|path>] [--pi-version <v>]",
    "",
    "Run flags:",
    "  --model <id>            model id or pattern (provider/model[:thinking])",
    "  --provider <name>       provider name",
    "  --thinking <level>      off|minimal|low|medium|high|xhigh|max",
    "  --preset <name>         preset from .claude/pi/config.json",
    "  --system-prompt <v>     stored prompt name (reviewer, fixer, …), @path/to.md, or inline text",
    "  --append-system-prompt  additive prompt text or file (repeatable)",
    "  --read-only             restrict pi to read, grep, find, ls",
    "  --write                 allow edit/write/bash even when the preset is read-only",
    "  --session <id>          continue an existing pi session ('last' = latest job)",
    "  --fresh                 ignore --session and start a new pi session",
    "  --timeout <seconds>     hard limit for the run",
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
  if (argv.length === 1 && /[\s"']/.test(argv[0] ?? "")) {
    return splitRawArgumentString(argv[0]);
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
function buildRunSettings({ command, flags, workspaceRoot, runRoot = workspaceRoot, config }) {
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
    ...(flags.timeout ? { timeoutMs: Number(flags.timeout) * 1000 } : {})
  };

  const settings = resolveRunSettings(config, command, overrides);
  if (!settings.git) {
    // Nothing was named explicitly, so inherit whatever git would use in this
    // directory. In a sandbox that is the only way a per-directory rule can
    // survive: the container sees /workspace, not the path the rule matches.
    settings.git = resolveCommitIdentity(runRoot);
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
  let sandbox = normalizeSandbox(settings.sandbox, config.sandboxProfiles);
  if (settings.mounts.length && !isSandboxed(sandbox)) {
    // Without a container there is nothing to mount into: pi already sees the
    // whole filesystem, so silently dropping them would hide a real mistake.
    throw new Error(
      `--mount needs a sandbox: ${settings.mounts.join(", ")} has nowhere to go. ` +
        "Add `--sandbox docker` or a preset with one."
    );
  }
  if (isSandboxed(sandbox)) {
    sandbox = attachMounts(sandbox, settings.mounts);
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
function detachBackgroundRun({ kind, workspaceRoot, jobId, title, settings }) {
  const detachedLog = resolveDetachedLogFile(workspaceRoot, jobId);
  ensureStateDir(workspaceRoot);
  const handle = fs.openSync(detachedLog, "a");

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", handle, handle],
    env: { ...process.env, [DETACHED_ENV]: "1", [DETACHED_JOB_ENV]: jobId }
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
  const execution = await runTrackedJob({ ...job, logFile }, async () => {
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
      elapsed: elapsedSeconds < 60 ? `${elapsedSeconds}s` : `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`
    };

    return {
      ...enriched,
      summary: (result.text ?? "").split("\n").find((line) => line.trim())?.slice(0, 160) ?? null,
      rendered: renderRunResult({ title: resultTitle, job, settings, execution: enriched })
    };
  });

  return { job, execution };
}

async function commandSetup(argv, workspaceRoot) {
  const { flags } = parseArgs(argv, { booleans: ["json"] });
  const availability = getPiAvailability(workspaceRoot);
  const { config, sources, errors } = loadConfig(workspaceRoot);
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
    configErrors: errors,
    presets: Object.keys(config.presets ?? {}),
    prompts: [...listNamedPrompts(PLUGIN_ROOT, workspaceRoot).keys()].sort(),
    stateDir: resolveStateDir(workspaceRoot),
    userConfigPath: userConfigPath()
  };

  output(renderSetupReport(payload), payload, Boolean(flags.json));
  return availability.installed ? 0 : 1;
}

async function commandModels(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, { booleans: ["json"] });
  const search = positional.join(" ").trim() || null;
  const { config } = loadConfig(workspaceRoot);
  const models = listModels(PI_BINARY, { cwd: workspaceRoot, search });

  const payload = {
    models,
    presets: config.presets ?? {},
    prompts: [...listNamedPrompts(PLUGIN_ROOT, workspaceRoot).keys()].sort(),
    defaults: config.defaults ?? {},
    search
  };

  output(renderModelsReport(payload), payload, Boolean(flags.json));
  return 0;
}

async function commandDelegate(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, RUN_FLAGS);
  const piped = flags.stdin ? readStdin().trim() : "";
  const prompt = [positional.join(" ").trim(), piped].filter(Boolean).join("\n\n");

  if (!prompt) {
    throw new Error("Nothing to delegate. Pass the task text, e.g. `/pi:delegate investigate the flaky test`.");
  }

  const { config } = loadConfig(workspaceRoot);
  const runRoot = resolveRunRoot(flags.cwd);
  const settings = buildRunSettings({ command: "delegate", flags, workspaceRoot, runRoot, config });
  const sessionId = flags.fresh ? null : resolveSessionReference(workspaceRoot, flags.session);

  const title = prompt.split("\n")[0].slice(0, 120);
  const jobId = process.env[DETACHED_JOB_ENV] || generateJobId("delegate");
  if (flags.background && process.env[DETACHED_ENV] !== "1") {
    detachBackgroundRun({ kind: "delegate", workspaceRoot, jobId, title, settings });
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
  const runRoot = resolveRunRoot(flags.cwd);
  ensureGitRepository(runRoot);

  const target = resolveReviewTarget(runRoot, {
    scope: flags.scope ?? "auto",
    base: flags.base ?? null
  });
  const context = collectReviewContext(runRoot, target);
  if (!context.text.trim()) {
    throw new Error("Nothing to review: the resolved diff is empty.");
  }

  const { config } = loadConfig(workspaceRoot);
  const settings = buildRunSettings({ command: "review", flags, workspaceRoot, runRoot, config });

  const focus = positional.join(" ").trim();
  const prompt = interpolate(loadTaskTemplate(PLUGIN_ROOT, "review"), {
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
    detachBackgroundRun({ kind: "review", workspaceRoot, jobId, title, settings });
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
  const { flags, positional } = parseArgs(argv, { booleans: ["json", "all"] });
  const snapshot = buildStatusSnapshot(workspaceRoot, {
    jobId: positional[0] ?? null,
    all: Boolean(flags.all)
  });
  output(renderStatusReport(snapshot), snapshot, Boolean(flags.json));
  return 0;
}

async function commandResult(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, { booleans: ["json"] });
  const { job, stored } = resolveResultJob(workspaceRoot, positional[0] ?? null);
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
  const explicitId = flags.job ?? (positional[0] && jobs.some((job) => job.id === positional[0]) ? positional.shift() : null);
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
      `Job ${target.id} is ${target.status}, so it cannot be steered. Start a new run with --session ${target.sessionId ?? "last"} instead.`
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

  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).map(enrichJob);
  if (!jobs.length) {
    throw new Error("No pi jobs recorded for this workspace yet.");
  }

  const reference = positional[0] ?? null;
  const target = reference
    ? jobs.find((job) => job.id === reference || job.id.endsWith(reference))
    : (jobs.find((job) => job.status === "running") ?? jobs[0]);

  if (!target) {
    throw new Error(`No pi job matches "${reference}".`);
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

  const readEvents = (fromLine) => {
    if (!fs.existsSync(file)) {
      return { events: [], nextLine: fromLine };
    }
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    return {
      events: lines.slice(fromLine).map(parseJsonLine).filter(Boolean),
      nextLine: lines.length
    };
  };

  const initial = readEvents(since);
  if (flags.json) {
    output("", { job: target, events: initial.events, cursor: initial.nextLine, since }, true);
    return 0;
  }

  // Rendering is stateful (tool calls pair up with their results), so a run
  // that starts mid-stream replays the skipped events into a throwaway state.
  const state = {};
  if (since > 0) {
    for (const event of readEvents(0).events.slice(0, since)) {
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
    if (current.status !== "running" && !next.events.length) {
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
    const days = flags.all ? null : Number(flags.days ?? 30);
    const by = flags.by ?? "day";
    const rows = queryStats(handle, { by, days, limit: Number(flags.limit ?? 50) });
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
    const removed = containers.filter((container) => removeSandboxContainer(container.name));
    const payload = { action, removed: removed.map((container) => container.name) };
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

async function commandCancel(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, { booleans: ["json"] });
  const job = resolveCancelableJob(workspaceRoot, positional[0] ?? null);

  let cancelled = false;
  if (job.status === "running" && job.pid) {
    // Ask pi to stop through the control channel first: an abort keeps the
    // session intact and lets the run record its partial work.
    if (job.engine !== "json") {
      pushControlMessage(workspaceRoot, job.id, { kind: "abort" });
      appendLogLine(job.logFile, "Abort requested from Claude Code.");
      for (let waited = 0; waited < 4000; waited += 250) {
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
      const wrapperStopped = await terminateProcessTree(job.pid, { group: false });
      cancelled = piStopped || wrapperStopped;
    }

    // Signals reach the `docker run` client, never the container behind it, so
    // a sandboxed job is only really stopped once the container is gone.
    if (job.containerName) {
      const removed = removeSandboxContainer(job.containerName);
      cancelled = cancelled || removed;
    }

    const record = { id: job.id, status: "cancelled", phase: "cancelled", pid: null, completedAt: nowIso() };
    upsertJob(workspaceRoot, record);
    // Keep whatever the run already stored (partial output, session id) and
    // only overlay the cancellation.
    writeJobFile(workspaceRoot, job.id, {
      ...job,
      ...(readStoredJob(workspaceRoot, job.id) ?? {}),
      ...record
    });
  }

  output(renderCancelReport(job, cancelled), { job, cancelled }, Boolean(flags.json));
  return cancelled || job.status !== "running" ? 0 : 1;
}

const COMMANDS = {
  setup: commandSetup,
  models: commandModels,
  delegate: commandDelegate,
  review: commandReview,
  status: commandStatus,
  result: commandResult,
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

  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  return handler(rest, workspaceRoot);
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
