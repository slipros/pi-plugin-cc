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
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { loadConfig, resolveRunSettings, userConfigPath } from "./lib/config.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import {
  buildStatusSnapshot,
  createJobLogFile,
  createJobRecord,
  createProgressReporter,
  resolveCancelableJob,
  resolveResultJob,
  runTrackedJob,
  sortJobsNewestFirst
} from "./lib/jobs.mjs";
import { listModels, normalizeThinking, resolveModelSelection } from "./lib/models.mjs";
import { getPiAvailability, PI_BINARY, runPiTurn } from "./lib/pi.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { buildSystemPrompt, interpolate, listBuiltInRoles, loadTaskTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  listJobs,
  nowIso,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  renderBackgroundStart,
  renderCancelReport,
  renderModelsReport,
  renderRunResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult
} from "./lib/render.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const RUN_FLAGS = {
  booleans: ["background", "wait", "read-only", "write", "json", "fresh", "stdin"],
  strings: [
    "model",
    "provider",
    "thinking",
    "preset",
    "role",
    "system-prompt",
    "tools",
    "exclude-tools",
    "session",
    "timeout",
    "name",
    "base",
    "scope"
  ],
  collect: ["append-system-prompt"],
  aliases: {
    m: "model",
    p: "provider",
    t: "thinking",
    "readonly": "read-only",
    "append-system": "append-system-prompt",
    resume: "session"
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
    "",
    "Run flags:",
    "  --model <id>            model id or pattern (provider/model[:thinking])",
    "  --provider <name>       provider name",
    "  --thinking <level>      off|minimal|low|medium|high|xhigh|max",
    "  --preset <name>         preset from .claude/pi/config.json",
    "  --role <name>           system-prompt role (built-in or project)",
    "  --system-prompt <v>     inline text, or @path / *.md file",
    "  --append-system-prompt  additive prompt text or file (repeatable)",
    "  --read-only             restrict pi to read, grep, find, ls",
    "  --write                 allow edit/write/bash even when the preset is read-only",
    "  --tools / --exclude-tools <list>",
    "  --session <id>          continue an existing pi session ('last' = latest job)",
    "  --fresh                 ignore --session and start a new pi session",
    "  --timeout <seconds>     hard limit for the run",
    "  --stdin                 append piped stdin to the prompt",
    "  --json                  machine-readable output"
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
function buildRunSettings({ command, flags, workspaceRoot, config }) {
  const overrides = {
    model: flags.model ?? null,
    provider: flags.provider ?? null,
    thinking: normalizeThinking(flags.thinking),
    preset: flags.preset ?? null,
    role: flags.role ?? null,
    systemPrompt: flags["system-prompt"] ?? null,
    appendSystemPrompt: flags["append-system-prompt"] ?? [],
    tools: flags.tools ?? null,
    excludeTools: flags["exclude-tools"] ?? null,
    ...(flags["read-only"] ? { readOnly: true } : {}),
    ...(flags.write ? { readOnly: false } : {}),
    ...(flags.timeout ? { timeoutMs: Number(flags.timeout) * 1000 } : {})
  };

  const settings = resolveRunSettings(config, command, overrides);
  const prompt = buildSystemPrompt({ pluginRoot: PLUGIN_ROOT, workspaceRoot, config, settings });

  const warnings = [];
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
    model: selection.model,
    provider: selection.provider,
    systemPromptText: prompt.systemPrompt,
    appends: prompt.appends,
    roleLabel: prompt.role ? `\`${prompt.role}\`` : null,
    promptLabel: prompt.role
      ? null
      : (prompt.sources.find((source) => source.startsWith("system prompt")) ?? null),
    promptSources: prompt.sources,
    warnings
  };
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
  flags,
  resultTitle,
  sessionId = null
}) {
  const jobId = generateJobId(kind);
  const logFile = createJobLogFile(workspaceRoot, jobId, title);
  const job = createJobRecord({
    id: jobId,
    kind,
    title,
    workspaceRoot,
    logFile,
    model: settings.model,
    role: settings.role,
    preset: settings.presetName,
    readOnly: settings.readOnly,
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

  if (flags.background) {
    process.stdout.write(renderBackgroundStart({ job, settings }));
  }

  const startedAt = Date.now();
  const execution = await runTrackedJob({ ...job, logFile }, async () => {
    const result = await runPiTurn({
      cwd: workspaceRoot,
      prompt,
      model: settings.model,
      provider: settings.provider,
      thinking: settings.thinking,
      systemPrompt: settings.systemPromptText,
      appends: settings.appends,
      tools: settings.tools,
      excludeTools: settings.excludeTools,
      readOnly: settings.readOnly,
      sessionId,
      sessionName: title.slice(0, 80),
      timeoutMs: settings.timeoutMs,
      onProgress,
      onSpawn: (piPid) => {
        // Recorded so /pi:cancel can signal pi itself, not just this wrapper.
        upsertJob(workspaceRoot, { id: jobId, piPid });
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

  const payload = {
    ...availability,
    configSources: sources,
    configErrors: errors,
    presets: Object.keys(config.presets ?? {}),
    roles: [...new Set([...listBuiltInRoles(PLUGIN_ROOT), ...Object.keys(config.roles ?? {})])].sort(),
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
    roles: [...new Set([...listBuiltInRoles(PLUGIN_ROOT), ...Object.keys(config.roles ?? {})])].sort(),
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
  const settings = buildRunSettings({ command: "delegate", flags, workspaceRoot, config });
  const sessionId = flags.fresh ? null : resolveSessionReference(workspaceRoot, flags.session);

  const title = prompt.split("\n")[0].slice(0, 120);
  const { job, execution } = await executeRun({
    kind: "delegate",
    title,
    prompt,
    settings,
    workspaceRoot,
    flags,
    resultTitle: "pi delegated task",
    sessionId
  });

  output(execution.rendered, { job: job.id, ...execution }, Boolean(flags.json));
  return execution.exitStatus === 0 ? 0 : 1;
}

async function commandReview(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, RUN_FLAGS);
  ensureGitRepository(workspaceRoot);

  const target = resolveReviewTarget(workspaceRoot, {
    scope: flags.scope ?? "auto",
    base: flags.base ?? null
  });
  const context = collectReviewContext(workspaceRoot, target);
  if (!context.text.trim()) {
    throw new Error("Nothing to review: the resolved diff is empty.");
  }

  const { config } = loadConfig(workspaceRoot);
  const settings = buildRunSettings({ command: "review", flags, workspaceRoot, config });

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
  const { job, execution } = await executeRun({
    kind: "review",
    title,
    prompt,
    settings,
    workspaceRoot,
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

async function commandCancel(argv, workspaceRoot) {
  const { flags, positional } = parseArgs(argv, { booleans: ["json"] });
  const job = resolveCancelableJob(workspaceRoot, positional[0] ?? null);

  let cancelled = false;
  if (job.status === "running" && job.pid) {
    // pi runs in its own process group; the companion wrapper does not.
    const piStopped = job.piPid ? await terminateProcessTree(job.piPid, { group: true }) : false;
    const wrapperStopped = await terminateProcessTree(job.pid, { group: false });
    cancelled = piStopped || wrapperStopped;
    if (cancelled) {
      const record = { id: job.id, status: "cancelled", phase: "cancelled", pid: null, completedAt: nowIso() };
      upsertJob(workspaceRoot, record);
      writeJobFile(workspaceRoot, job.id, { ...job, ...record });
    }
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
  cancel: commandCancel
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
