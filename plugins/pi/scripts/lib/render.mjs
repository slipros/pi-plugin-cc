import { describeBudget } from "./budget.mjs";
import { groupByProvider } from "./models.mjs";
import { READ_ONLY_TOOLS, wasTruncated } from "./pi.mjs";
import { cacheState, formatDuration as formatAge } from "./sessions.mjs";

function formatCost(cost) {
  if (typeof cost !== "number" || Number.isNaN(cost)) {
    return null;
  }
  return cost >= 0.01 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
}

function formatUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const parts = [];
  if (typeof usage.input === "number") {
    parts.push(`in ${usage.input.toLocaleString("en-US")}`);
  }
  if (typeof usage.output === "number") {
    parts.push(`out ${usage.output.toLocaleString("en-US")}`);
  }
  if (typeof usage.cacheRead === "number" && usage.cacheRead > 0) {
    parts.push(`cache ${usage.cacheRead.toLocaleString("en-US")}`);
  }
  const cost = formatCost(usage.cost);
  if (cost) {
    parts.push(cost);
  }
  return parts.length ? parts.join(" · ") : null;
}

function joinLines(lines) {
  return `${lines.filter((line) => line != null).join("\n").trimEnd()}\n`;
}

export function renderSetupReport(report) {
  const lines = ["# pi plugin setup", ""];

  lines.push(report.installed ? `- pi binary: **found** (${report.version ?? "unknown version"})` : "- pi binary: **missing**");

  if (!report.installed) {
    lines.push("");
    lines.push("Install pi with:");
    lines.push("");
    lines.push("```bash");
    lines.push("npm install -g @earendil-works/pi-coding-agent");
    lines.push("```");
    return joinLines(lines);
  }

  const modelCount = report.models.length;
  lines.push(
    modelCount
      ? `- Models available: **${modelCount}** across ${groupByProvider(report.models).size} provider(s)`
      : "- Models available: **none** — no provider credentials are configured"
  );
  if (report.error) {
    lines.push(`- Model catalogue warning: ${report.error}`);
  }
  lines.push(`- Config files loaded: ${report.configSources.length ? report.configSources.join(", ") : "none (built-in defaults)"}`);
  if (report.configErrors?.length) {
    for (const error of report.configErrors) {
      lines.push(`- Config error: ${error}`);
    }
  }
  lines.push(`- Presets: ${report.presets.length ? report.presets.join(", ") : "none configured"}`);
  if (report.sandbox) {
    const state = report.sandbox.ready
      ? `image \`${report.sandbox.image}\` is built`
      : `image \`${report.sandbox.image}\` is not ready — run \`pi-companion.mjs sandbox build\``;
    lines.push(`- Sandbox: ${report.sandbox.configured ?? "off by default"} · ${state}`);
  }
  lines.push(`- System prompts: ${report.prompts.join(", ")}`);
  lines.push(`- Job state directory: \`${report.stateDir}\``);

  if (!modelCount) {
    lines.push("");
    lines.push("Sign in to a provider before delegating work:");
    lines.push("");
    lines.push("```bash");
    lines.push("pi   # then run /login inside the TUI");
    lines.push("```");
  } else {
    lines.push("");
    lines.push("Ready. Try `/pi:delegate investigate the failing test` or `/pi:review`.");
  }

  return joinLines(lines);
}

/**
 * One line per preset: what the agent is FOR, then how it is configured.
 *
 * `description` leads because picking an agent is a question about the work,
 * and the caller should not have to open a system prompt to answer it —
 * reading prompts to choose costs more than the choice.
 */
export function presetLines(presets, capabilities = {}, limits = {}) {
  const names = Object.keys(presets ?? {});
  if (!names.length) {
    return ["- none configured (add a `presets` block to `.claude/pi/config.json`)"];
  }
  return names.map((name) => {
    const preset = presets[name] ?? {};
    const caps = capabilities[name] ?? {};
    // The output ceiling belongs next to the model: a run that hits it ends
    // mid-sentence with a "completed" status, and the choice between two presets
    // is often exactly this number. Absent when the catalogue was unreachable.
    const limit = limits[preset.model ?? ""] ?? null;
    const details = [
      preset.model
        ? `model \`${preset.model}\`${limit ? ` (ctx ${limit.context ?? "?"} · out ${limit.maxOutput ?? "?"})` : ""}`
        : null,
      preset.provider ? `provider \`${preset.provider}\`` : null,
      preset.thinking ? `thinking \`${preset.thinking}\`` : null,
      preset.systemPrompt ? `prompt \`${preset.systemPrompt}\`` : null,
      preset.readOnly ? "read-only" : null,
      preset.sandbox?.profile ? `sandbox \`${preset.sandbox.profile}\`` : null,
      // Capabilities the preset does not state and the model does not carry:
      // a skill the profile mounts is invisible in both, and a caller that
      // cannot see it will route the work by the model's limits instead.
      caps.vision ? `vision \`${caps.vision}\`` : null,
      caps.tags?.length ? `tags \`${caps.tags.join(", ")}\`` : null,
      // Loudest field on the line: the preset names equipment the container will
      // not have, so a run would work without the rules that equipment carries.
      caps.mountGaps?.length ? `⚠ NOT MOUNTED: ${caps.mountGaps.join(", ")}` : null
    ]
      .filter(Boolean)
      .join(", ");
    return preset.description
      ? `- \`${name}\` — ${preset.description}${details ? ` · ${details}` : ""}`
      : `- \`${name}\` — ${details || "no overrides"}`;
  });
}

/**
 * The agents this setup offers — without walking the model catalogue.
 *
 * Choosing an agent should not cost a pass over several hundred models: that
 * call takes over a second, which is too slow for anything that asks on every
 * invocation, such as a hook.
 */
export function renderPresetsReport({ presets = {}, prompts = [], capabilities = {}, limits = {} } = {}) {
  const lines = ["# pi presets", "", ...presetLines(presets, capabilities, limits)];
  if (prompts.length) {
    lines.push("", "## System prompts", "", prompts.map((name) => `- \`${name}\``).join("\n"));
  }
  return joinLines(lines);
}

export function renderModelsReport({ models, defaults, search, measured = null }) {
  const lines = ["# pi models", ""];

  if (!models.length) {
    lines.push(
      search
        ? `No models match \`${search}\`.`
        : "No models are available. Run `pi` and sign in with `/login`, or configure `~/.pi/agent/models.json`."
    );
    return joinLines(lines);
  }

  lines.push(`${models.length} model(s)${search ? ` matching \`${search}\`` : ""}:`);
  lines.push("");
  lines.push("| Model id | Context | Max output | Thinking | Images |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const model of models) {
    lines.push(
      `| \`${model.id}\` | ${model.context ?? "?"} | ${model.maxOutput ?? "?"} | ${model.thinking ? "yes" : "no"} | ${model.images ? "yes" : "no"} |`
    );
  }

  if (measured) {
    lines.push("", "## Measured here", "");
    if (measured.length) {
      lines.push(
        "What the catalogue cannot say: how these models behaved on this machine.",
        "",
        "| Model | runs | ok | ctx avg | ctx max | tok/s | out/run | p50 | p90 | turns/run | tool err | cost |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
      );
      for (const row of measured) {
        const counted = Number(row.counted_runs ?? 0);
        const turnsPerRun = counted ? (Number(row.turns ?? 0) / counted).toFixed(1) : "—";
        lines.push(
          `| \`${row.bucket}\` | ${row.runs} | ${formatShare(row.completed, row.runs)} | ` +
            `${formatCompact(row.avg_context)} | ${formatCompact(row.max_context)} | ` +
            `${formatRate(row.tokensPerSecond)}${row.unreported_reasoning ? "*" : ""} | ${formatCompact(row.outputPerRun)} | ${formatSeconds(row.p50Seconds)} | ${formatSeconds(row.p90Seconds)} | ` +
            `${turnsPerRun} | ${formatShare(row.tool_errors, row.tool_calls)} | ${formatCost(row.cost) ?? "—"} |`
        );
      }
      lines.push(
        "",
        "`tok/s` counts generated tokens against the generation window measured on the proxy, so runs without that " +
          "telemetry and answers under 1,000 output tokens are left out; `out/run` is the average answer length behind " +
          "the rate. A `*` marks a provider whose hidden reasoning is streamed but reported as zero, making its rate an underestimate."
      );
    } else {
      lines.push("No runs recorded yet, so there is nothing to compare.");
    }
  }

  // Presets and prompts live in `presets`: this report answers "what can answer
  // me", that one answers "who should do the work". Keeping both here made the
  // slower report the only way to see the faster answer.
  lines.push("");
  lines.push("## Defaults");
  lines.push("");
  lines.push(`- model: ${defaults.model ? `\`${defaults.model}\`` : "pi decides"}`);
  lines.push(`- thinking: ${defaults.thinking ? `\`${defaults.thinking}\`` : "pi decides"}`);
  lines.push(`- system prompt: ${defaults.systemPrompt ? `\`${defaults.systemPrompt}\`` : "pi default"}`);

  lines.push("");
  lines.push("Use `--model <id>`, `--provider <name>` or `--thinking <level>` to pick one of these.");
  lines.push("Agents to hand work to — and what each is for — are listed by `presets`.");

  return joinLines(lines);
}

/**
 * Where the session this run leaves behind can be picked up.
 *
 * A sandboxed run keeps its session inside the agent volume, so the obvious
 * `pi --session <id>` on the host finds nothing — the hint has to say which
 * door actually opens.
 */
function formatSessionLine(sessionId, settings) {
  const how = settings.sandboxLabel
    ? "it lives in the sandbox volume, not on the host"
    : `or \`pi --session ${sessionId}\` yourself`;
  return `- pi session: \`${sessionId}\` (continue with \`continue ${sessionId}\`; ${how})`;
}

/**
 * How much code the run moved, in one line.
 *
 * Read and written are shown together on purpose: either number alone says
 * little, while the pair is the shape of the work — a run that wrote more than
 * it read changed code it never looked at, and that is worth seeing next to the
 * answer rather than in a query somebody has to think to run.
 */
export function formatAgentWork(work) {
  if (!work) {
    return null;
  }
  const read = Number(work.linesRead) || 0;
  const written = Number(work.linesWritten) || 0;
  const replaced = Number(work.linesReplaced) || 0;
  const rereads = Number(work.rereads) || 0;
  if (!read && !written && !replaced) {
    return null;
  }
  const parts = [
    `read ${read} line(s) in ${Number(work.filesRead) || 0} file(s)`,
    `wrote ${written}${replaced ? ` (replacing ${replaced})` : ""} in ${Number(work.filesWritten) || 0} file(s)`
  ];
  if (rereads) {
    parts.push(`${rereads} re-read(s)`);
  }
  return parts.join(" · ");
}

/**
 * How the run went about it, in one line.
 *
 * Separate from the line counts because it answers a different question: not
 * how much was done, but whether the doing was healthy. Each part is printed
 * only when it has something to say — a clean run should not be padded with
 * four zeroes.
 */
export function formatToolProfile(work) {
  if (!work) {
    return null;
  }
  const calls = Number(work.toolCalls) || 0;
  const shell = Number(work.shellCalls) || 0;
  const parts = [];
  if (calls) {
    parts.push(`${calls} tool call(s)${shell ? `, ${Math.round((100 * shell) / calls)}% shell` : ""}`);
  }
  const failed = [
    Number(work.editErrors) ? `${work.editErrors} edit(s) matched nothing` : null,
    Number(work.readErrors) ? `${work.readErrors} read(s) missed` : null,
    Number(work.shellErrors) ? `${work.shellErrors} command(s) failed` : null
  ].filter(Boolean);
  parts.push(...failed);
  if (typeof work.firstEditMs === "number") {
    parts.push(`first edit after ${Math.round(work.firstEditMs / 1000)}s`);
  }
  if (Number(work.repeatCallRun) >= 3) {
    parts.push(`${work.repeatCallRun} identical calls in a row`);
  }
  return parts.length ? parts.join(" · ") : null;
}

function renderRunHeader(title, { job, settings, execution }) {
  // The effective thinking level comes back from pi's own state; the requested
  // one is only a fallback for engines that never report it.
  const thinking = execution?.thinkingLevel ?? settings.thinking ?? null;
  const meta = [
    `- Job: \`${job.id}\``,
    `- Model: ${execution?.model ? `\`${execution.model}\`` : settings.model ? `\`${settings.model}\`` : "pi default"}`,
    thinking ? `- Thinking: \`${thinking}\`` : null,
    settings.sandboxLabel ? `- Sandbox: ${settings.sandboxLabel}` : null,
    formatSlots(settings.slotUsage),
    settings.presetName ? `- Preset: \`${settings.presetName}\`` : null,
    // Only worth a line when it is not the directory the caller is standing in.
    job.runRoot && job.runRoot !== job.workspaceRoot ? `- Working directory: \`${job.runRoot}\`` : null,
    settings.promptLabel ? `- ${settings.promptLabel.replace(/^system prompt/, "System prompt")}` : null,
    settings.readOnly ? `- Tools: read-only (\`${READ_ONLY_TOOLS.join("`, `")}\`)` : null,
    // The run works in a worktree, so the repository it belongs to came along.
    settings.worktreeMount ? `- Worktree: shared \`${settings.worktreeMount.split(":")[0]}\` mounted` : null,
    settings.git ? `- Commits as: ${settings.git.name} <${settings.git.email}>` : null,
    settings.continuation
      ? `- Continues: \`${settings.continuation.jobId}\` (last active ${formatAge(settings.continuation.ageMs)} ago, ` +
        `cache ${settings.continuation.cache}${settings.continuation.staleOk ? ", continued past the TTL on `--stale-ok`" : ""})`
      : null,
    execution?.sessionId ? formatSessionLine(execution.sessionId, settings) : null,
    formatUsage(execution?.usage) ? `- Usage: ${formatUsage(execution.usage)}` : null,
    formatAgentWork(execution?.agentWork) ? `- File work: ${formatAgentWork(execution.agentWork)}` : null,
    formatToolProfile(execution?.agentWork) ? `- Tool profile: ${formatToolProfile(execution.agentWork)}` : null,
    // Printed whether or not it was reached: a run that stopped early is easier
    // to read when the ceiling it was given is on the same page.
    describeBudget(settings.budget) ? `- Budget: ${describeBudget(settings.budget)}` : null,
    execution?.elapsed ? `- Duration: ${execution.elapsed}` : null
  ].filter(Boolean);

  return [`# ${title}`, "", ...meta, ""];
}

/**
 * What the run did to the tree, as opposed to what it said about it.
 *
 * Kept to names and counts: the patch itself is what `result --diff` is for,
 * and pasting it here would bury the answer under it.
 */
export function renderChangesSection(changes) {
  if (!changes || (!changes.commits?.length && !changes.files?.length)) {
    return [];
  }
  const lines = ["## Changes", ""];

  if (changes.stat) {
    lines.push(`- ${changes.stat}`);
  }
  for (const commit of changes.commits ?? []) {
    lines.push(`- commit ${commit}`);
  }
  const files = changes.files ?? [];
  const shown = files.slice(0, 20);
  for (const file of shown) {
    lines.push(`  - ${file}`);
  }
  if (files.length > shown.length) {
    lines.push(`  - … and ${files.length - shown.length} more`);
  }
  if (changes.preexisting?.length) {
    // Said out loud so nobody reads someone else's work-in-progress as the
    // agent's: these files were already modified when the run started.
    lines.push(`- Already modified before the run (not the agent's): ${changes.preexisting.join(", ")}`);
  }
  if (changes.diffCommand) {
    lines.push(`- Read the patch: \`${changes.diffCommand}\` — or \`result --diff\``);
  }
  lines.push("");
  return lines;
}

/**
 * The line a run has to carry when the ceiling had the last word.
 *
 * Two different facts, and the difference matters when reading the answer: a
 * run that recovered has an answer in several pieces, a run that ended truncated
 * has an answer that stops mid-thought.
 */
export function truncationWarning(execution) {
  const recovered = Number(execution?.recoveredTruncations) || 0;
  if (wasTruncated(execution)) {
    return recovered
      ? `The last answer hit the output ceiling and ${recovered} continuation(s) did not get past it — the work is probably unfinished.`
      : "The last answer hit the output ceiling — the work is probably unfinished, whatever the exit code says.";
  }
  return recovered
    ? `The answer hit the output ceiling ${recovered} time(s) and the run continued itself; the text below is joined from those pieces.`
    : null;
}

/** Ниже этой серии совпадение длин — совпадение, а не повтор. */
const REPEAT_RUN_ALERT = 4;

/**
 * Прогон, который ходил по кругу, не упираясь в потолок.
 *
 * Обрыв на потолке заметен: он меняет stopReason и попадает в phase. Повтор,
 * укладывающийся в потолок, не меняет ничего — ходы идут, ответы приходят, джоб
 * закрывается галочкой, а работа при этом не движется и контекст растёт. Отсюда
 * отдельное предупреждение: иначе такой прогон не отличить от полезного ни по
 * одному полю.
 */
export function repetitionWarning(execution) {
  const run = Number(execution?.proxyStats?.repeatRun) || 0;
  if (run < REPEAT_RUN_ALERT) {
    return null;
  }
  return `${run} answers in a row came back the same length — the agent was likely repeating a turn rather than making progress; check what it actually changed.`;
}

export function renderRunResult({ title, job, settings, execution }) {
  const lines = renderRunHeader(title, { job, settings, execution });
  lines.push(...renderChangesSection(execution.changes));

  // Setup problems that did not stop the run — a model the catalogue does not
  // know, an extension the sandbox cannot see — belong in the report, not only
  // in the job log where nobody looks until something breaks.
  if (settings.warnings?.length) {
    lines.push("## Warnings", "");
    for (const warning of settings.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  // A run cut off at the ceiling exits zero and reads as finished; the answer
  // below it then ends on a sentence of intent. Said here because this report is
  // where the answer is read, and `status` — which does carry the ⚠️ — is not
  // where anyone looks once a job is done.
  const truncationNote = truncationWarning(execution);
  const repetitionNote = repetitionWarning(execution);
  if (execution.errors?.length || truncationNote || repetitionNote) {
    lines.push("## Problems", "");
    for (const error of execution.errors ?? []) {
      lines.push(`- ${error}`);
    }
    if (truncationNote) {
      lines.push(`- ${truncationNote}`);
    }
    if (repetitionNote) {
      lines.push(`- ${repetitionNote}`);
    }
    lines.push("");
  }

  lines.push("---", "");
  lines.push(execution.text?.trim() || "_pi returned no output._");

  return joinLines(lines);
}

export function renderBackgroundStart({ job, settings, detachedLog = null }) {
  return joinLines([
    `Started pi job \`${job.id}\` in the background.`,
    "",
    `- Kind: ${job.kind}`,
    `- Model: ${settings.model ? `\`${settings.model}\`` : "pi default"}`,
    settings.sandboxLabel ? `- Sandbox: ${settings.sandboxLabel}` : null,
    formatSlots(settings.slotUsage),
    settings.promptName ? `- System prompt: \`${settings.promptName}\`` : null,
    job.runRoot && job.runRoot !== job.workspaceRoot ? `- Working directory: \`${job.runRoot}\`` : null,
    detachedLog ? `- Startup log: ${detachedLog}` : null,
    "",
    "The run continues on its own; this command is done. Check progress with `/pi:status`, read the answer with `/pi:result`, stop it with `/pi:cancel`."
  ]);
}

const STATUS_ICONS = {
  running: "⏳",
  completed: "✅",
  failed: "❌",
  cancelled: "🚫",
  orphaned: "⚠️"
};

function jobLine(job) {
  // A run cut off at the output ceiling exits zero, so it would otherwise carry
  // a tick: the phase is one word in the middle of the line and the tick is
  // what gets read. That misreading is what the phase exists to prevent, so
  // here the warning takes the icon.
  const truncated = job.phase === "truncated";
  const icon = truncated ? "⚠️" : (STATUS_ICONS[job.status] ?? "•");
  const parts = [
    `${icon} \`${job.id}\``,
    job.kind,
    job.status,
    truncated ? "phase: truncated — the answer hit the output ceiling, the work is probably unfinished" : job.phase ? `phase: ${job.phase}` : null,
    job.model ? `model: ${job.model}` : null,
    job.elapsed ? `elapsed: ${job.elapsed}` : null
  ].filter(Boolean);
  return `- ${parts.join(" · ")}`;
}

/**
 * What `wait` prints once it stops waiting.
 *
 * The point of the command is to be the last thing between starting a run and
 * reading it, so the report says where each job landed and how to read it —
 * not the whole transcript, which `result` already prints.
 */
export function renderWaitReport(jobs, { timedOut = false, waitSeconds = null } = {}) {
  const lines = [timedOut ? `# pi wait — still running after ${waitSeconds}s` : "# pi wait — done", ""];

  for (const job of jobs) {
    lines.push(jobLine(job));
    if (job.title) {
      lines.push(`  - Task: ${job.title}`);
    }
    if (job.summary) {
      lines.push(`  - ${job.summary}`);
    }
    if (job.errorMessage) {
      lines.push(`  - Error: ${job.errorMessage}`);
    }
  }

  lines.push("");
  lines.push(
    timedOut
      ? "Still going. Wait again with a longer `--for`, follow it with `watch --follow`, or stop it with `cancel`."
      : `Read the full answer with \`result${jobs.length > 1 ? " <job-id>" : ""}\`.`
  );
  return joinLines(lines);
}

export function renderStatusReport(snapshot) {
  const lines = [snapshot.global ? "# pi jobs — every workspace" : "# pi jobs", ""];

  if (!snapshot.jobs.length) {
    lines.push(
      snapshot.global
        ? "No pi jobs match on this machine."
        : "No pi jobs recorded for this workspace yet."
    );
    return joinLines(lines);
  }

  for (const job of snapshot.jobs) {
    lines.push(jobLine(job));
    if (job.title) {
      lines.push(`  - Task: ${job.title}`);
    }
    // Which repository a job belongs to is the whole point of the fleet view,
    // and it is the one thing the per-workspace listing never has to say.
    if (snapshot.global && job.workspaceRoot) {
      lines.push(`  - Workspace: ${job.workspaceRoot}`);
    }
    if (job.runRoot && job.runRoot !== job.workspaceRoot) {
      lines.push(`  - Working directory: ${job.runRoot}`);
    }
    // Recorded as the run goes, so a job still working can answer "how much has
    // this cost me so far" without reading the whole transcript.
    if (formatUsage(job.usage)) {
      lines.push(`  - Usage: ${formatUsage(job.usage)}`);
    }
    if (job.status === "running" && job.progress?.length) {
      lines.push(`  - Progress:`);
      for (const entry of job.progress) {
        lines.push(`    - ${entry}`);
      }
    }
    if (job.errorMessage) {
      lines.push(`  - Error: ${job.errorMessage}`);
    }
    if (job.status === "orphaned") {
      lines.push("  - The process is gone; the job never wrote a result.");
    }
  }

  if (snapshot.filtered) {
    lines.push("", `Showing ${snapshot.jobs.length} of ${snapshot.total} jobs. Use \`--all\` to see the rest.`);
  }

  return joinLines(lines);
}

export function renderStoredJobResult(job, stored) {
  const lines = [`# pi result — \`${job.id}\``, ""];
  lines.push(`- Kind: ${job.kind ?? "unknown"}`);
  lines.push(`- Status: ${job.status}`);
  if (job.title) {
    lines.push(`- Task: ${job.title}`);
  }
  if (stored?.model ?? job.model) {
    lines.push(`- Model: \`${stored?.model ?? job.model}\``);
  }
  if (stored?.sessionId ?? job.sessionId) {
    const sessionId = stored?.sessionId ?? job.sessionId;
    lines.push(`- pi session: \`${sessionId}\` (continue with \`pi --session ${sessionId}\`)`);
  }
  const usage = formatUsage(stored?.usage);
  if (usage) {
    lines.push(`- Usage: ${usage}`);
  }
  if (job.elapsed) {
    lines.push(`- Duration: ${job.elapsed}`);
  }
  lines.push("");

  if (job.status === "running") {
    lines.push("This job is still running. Check `/pi:status` for progress.");
    return joinLines(lines);
  }

  if (stored?.errorMessage) {
    lines.push(`**Error:** ${stored.errorMessage}`, "");
  }
  if (stored?.errors?.length) {
    lines.push("## Problems", "");
    for (const error of stored.errors) {
      lines.push(`- ${error}`);
    }
    lines.push("");
  }
  // `rendered` below already carries a Changes section for runs recorded after
  // this existed; this is the one a background job reads back on its own.
  if (!stored?.rendered && stored?.changes) {
    lines.push(...renderChangesSection(stored.changes));
  }

  lines.push("---", "");
  lines.push(stored?.rendered?.trim() || "_No stored output for this job._");

  return joinLines(lines);
}

export function renderSandboxReport(report) {
  const lines = ["# pi sandbox", ""];

  lines.push(`- Mode: ${report.configured ? report.configured : "not configured (pass `--sandbox docker` to enable)"}`);
  lines.push(`- Image: \`${report.image}\``);
  lines.push(`- Dockerfile: \`${report.dockerfile}\``);

  if (!report.dockerAvailable) {
    lines.push("- Docker: **not on PATH**");
    lines.push("", "Install Docker, then build the image with `pi-companion.mjs sandbox build`.");
    return joinLines(lines);
  }
  if (report.daemonError) {
    lines.push(`- Docker daemon: **unreachable** — ${report.daemonError}`);
    return joinLines(lines);
  }

  lines.push(`- Docker daemon: ${report.daemon}`);
  lines.push(
    report.imagePresent
      ? `- Image status: **built**${report.imageCreated ? ` (${report.imageCreated})` : ""}`
      : "- Image status: **missing** — build it with `pi-companion.mjs sandbox build`"
  );

  if (report.images?.length > 1) {
    lines.push("");
    lines.push("## Images");
    lines.push("");
    for (const entry of report.images) {
      const used = entry.profiles.length ? ` — profiles: ${entry.profiles.join(", ")}` : "";
      lines.push(
        `- \`${entry.image}\` ${entry.present ? "built" : "**missing**"} · ${entry.dockerfilePath ?? `no Dockerfile named "${entry.dockerfile}"`}${used}`
      );
    }
    lines.push("");
    lines.push("Build one with `pi-companion.mjs sandbox build <name>`, all of them with `--all`.");
  }

  lines.push("");
  lines.push("## Containers");
  lines.push("");
  if (report.containers.length) {
    for (const container of report.containers) {
      lines.push(`- \`${container.name}\` — ${container.status} (${container.image})`);
    }
    lines.push("", "Remove finished ones with `pi-companion.mjs sandbox clean`.");
  } else {
    lines.push("- none");
  }

  return joinLines(lines);
}

export function renderCancelReport(job, cancelled) {
  return joinLines([
    `# pi cancel — \`${job.id}\``,
    "",
    cancelled
      ? `Cancelled the job (was ${job.status}).`
      : `Nothing to cancel: the job is ${job.status}.`,
    job.sessionId ? `\npi session \`${job.sessionId}\` is preserved; resume it with \`pi --session ${job.sessionId}\`.` : null
  ]);
}

function shortId(id) {
  return String(id ?? "").slice(-8);
}

/** One line of the `runs` table: what it was, what it cost, how it ended. */
function runRow(run) {
  const created = String(run.created_at ?? "").replace("T", " ").slice(0, 16);
  const tokens = Number(run.input ?? 0) + Number(run.output ?? 0) + Number(run.cache_read ?? 0);
  return (
    `| \`${run.id}\` | ${created} | ${run.status ?? "?"} | ${run.model ?? "—"} | ${run.preset ?? "—"} | ` +
    `${formatTokens(tokens)} | ${formatCost(run.cost) ?? "—"} | ${formatSeconds(run.duration_seconds)} | ` +
    `${String(run.title ?? "").replace(/\|/g, "\\|").slice(0, 60)} |`
  );
}

export function renderRunsReport(runs, { workspace = null } = {}) {
  if (!runs.length) {
    return joinLines([
      "# pi runs",
      "",
      workspace
        ? `Nothing recorded for \`${workspace}\` yet. Use \`--all\` to look across every workspace.`
        : "The journal is empty."
    ]);
  }

  return joinLines([
    workspace ? `# pi runs — \`${workspace}\`` : "# pi runs — every workspace",
    "",
    "| id | when | status | model | preset | tokens | cost | time | task |",
    "|---|---|---|---|---|---|---|---|---|",
    ...runs.map(runRow),
    "",
    `Repeat one with \`rerun ${shortId(runs[0].id)}\`, or on another model with \`rerun ${shortId(runs[0].id)} --model <id>\`.`,
    "Read what one was given and answered with `runs <id>`."
  ]);
}

/** One recorded run in full: the task it was given and what it answered. */
export function renderRunDetail(run) {
  const lines = [`# pi run — \`${run.id}\``, ""];
  const meta = [
    `- Status: ${run.status ?? "unknown"}`,
    run.created_at ? `- Started: ${String(run.created_at).replace("T", " ").slice(0, 19)}` : null,
    run.model ? `- Model: \`${run.model}\`` : null,
    run.preset ? `- Preset: \`${run.preset}\`` : null,
    run.workspace ? `- Workspace: ${run.workspace}` : null,
    run.sandbox ? `- Sandbox: ${run.sandbox}` : null,
    `- Usage: ${formatTokens(Number(run.input ?? 0) + Number(run.output ?? 0) + Number(run.cache_read ?? 0))} tokens${
      formatCost(run.cost) ? ` · ${formatCost(run.cost)}` : ""
    }${run.duration_seconds ? ` · ${formatSeconds(run.duration_seconds)}` : ""}`,
    // `null` here means the run predates the measurement, which is not the same
    // as a run that touched no files — so the line is absent rather than zero.
    formatAgentWork({
      linesRead: run.lines_read,
      linesWritten: run.lines_written,
      linesReplaced: run.lines_replaced,
      filesRead: run.files_read,
      filesWritten: run.files_written,
      rereads: run.rereads
    })
      ? `- File work: ${formatAgentWork({
          linesRead: run.lines_read,
          linesWritten: run.lines_written,
          linesReplaced: run.lines_replaced,
          filesRead: run.files_read,
          filesWritten: run.files_written,
          rereads: run.rereads
        })}`
      : null,
    formatToolProfile({
      toolCalls: run.tool_calls,
      shellCalls: run.shell_calls,
      editErrors: run.edit_errors,
      readErrors: run.read_errors,
      shellErrors: run.shell_errors,
      firstEditMs: run.first_edit_ms,
      repeatCallRun: run.repeat_call_run
    })
      ? `- Tool profile: ${formatToolProfile({
          toolCalls: run.tool_calls,
          shellCalls: run.shell_calls,
          editErrors: run.edit_errors,
          readErrors: run.read_errors,
          shellErrors: run.shell_errors,
          firstEditMs: run.first_edit_ms,
          repeatCallRun: run.repeat_call_run
        })}`
      : null,
    // What reached the tree, next to what the tools reported writing: the gap
    // between them is work that was done twice.
    run.diff_added !== null && run.diff_added !== undefined
      ? `- Delivered: +${run.diff_added} / −${run.diff_deleted ?? 0} line(s)` +
        `${run.diff_untracked ? ` · ${run.diff_untracked} new file(s) never staged, not counted above` : ""}`
      : null
  ].filter(Boolean);
  lines.push(...meta, "");

  // Only the proxy sees these: pi retries HTTP failures internally, so a run
  // that hit three 429s and one dropped stream looked merely slow before.
  if (Number(run.req_count ?? 0) > 0) {
    const rate =
      Number(run.gen_ms ?? 0) > 0 && Number(run.gen_out_tokens ?? 0) > 0
        ? `${(Number(run.gen_out_tokens) / (Number(run.gen_ms) / 1000)).toFixed(1)} tok/s while generating`
        : null;
    lines.push(
      "## Requests",
      "",
      `- ${run.req_count} request${Number(run.req_count) === 1 ? "" : "s"} to the model, ${run.req_failed ?? 0} failed`,
      Number(run.ttft_p50_ms ?? 0) > 0 ? `- Time to first token, median: ${run.ttft_p50_ms} ms` : null,
      rate ? `- ${rate}` : null,
      Number(run.slot_wait_ms ?? 0) > 0 ? `- Queued for a sandbox slot: ${formatSeconds(Math.round(Number(run.slot_wait_ms) / 1000))}` : null,
      ""
    );
  }

  if (run.settings) {
    lines.push("## Settings", "", "```json", String(run.settings), "```", "");
  }
  // Absent means the retention window has passed, not that the run had no task.
  lines.push("## Task", "", run.prompt ? String(run.prompt) : "_Not stored, or past the retention window._", "");
  lines.push("## Answer", "", run.result_text ? String(run.result_text) : "_Not stored, or past the retention window._");
  return joinLines(lines);
}

/** What `cancel --all` printed for, one line per job it went after. */
export function renderCancelAllReport(results, { global: everywhere = false } = {}) {
  const lines = [`# pi cancel — ${everywhere ? "every workspace" : "this workspace"}`, ""];
  for (const { job, cancelled } of results) {
    const where = everywhere && job.workspaceRoot ? ` · ${job.workspaceRoot}` : "";
    lines.push(`- ${cancelled ? "🚫" : "⚠️"} \`${job.id}\` (was ${job.status})${where}`);
  }
  const stuck = results.filter(({ cancelled }) => !cancelled);
  lines.push("");
  lines.push(
    stuck.length
      ? `${results.length - stuck.length} of ${results.length} stopped. The rest left no process to signal and no container to remove; they are recorded as cancelled.`
      : `Stopped ${results.length} job${results.length === 1 ? "" : "s"}.`
  );
  return joinLines(lines);
}

export { formatUsage, formatCost };

function formatTokens(value) {
  return Number(value ?? 0).toLocaleString("en-US");
}

/** Share of runs that finished cleanly, as a percentage. */
function formatShare(part, whole) {
  const total = Number(whole ?? 0);
  if (!total) {
    return "—";
  }
  const value = Number(part ?? 0);
  const percent = (100 * value) / total;
  // Rounding must not turn a failure into a clean sheet: 249/250 is not 100%,
  // and one error in a thousand calls is not 0%.
  if (percent > 99 && value < total) {
    return ">99%";
  }
  if (percent > 0 && percent < 1) {
    return "<1%";
  }
  return `${Math.round(percent)}%`;
}

/** Tokens per second; null when no run in the bucket carried timings. */
function formatRate(rate) {
  if (rate == null || !Number.isFinite(rate) || rate <= 0) {
    return "—";
  }
  return rate >= 100 ? String(Math.round(rate)) : rate.toFixed(1);
}

/**
 * Slot occupancy at launch. A full pool is worth spelling out: the run is not
 * broken, it is queued, and that is otherwise indistinguishable from a hang.
 */
function formatSlots(usage) {
  if (!usage) {
    return null;
  }
  const line = `- Slots: ${usage.used}/${usage.limit} in use · ${usage.scope}`;
  return usage.used >= usage.limit ? `${line} — this run waits for a free slot` : line;
}

/** Token counts at a glance: 812K rather than 812,431. */
function formatCompact(value) {
  const tokens = Number(value ?? 0);
  if (!tokens) {
    return "—";
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
  }
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(Math.round(tokens));
}

function formatSeconds(value) {
  if (value == null) {
    return "—";
  }
  const seconds = Number(value);
  if (seconds < 120) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = seconds / 60;
  return minutes < 10 ? `${minutes.toFixed(1)}m` : `${Math.round(minutes)}m`;
}

function formatDuration(totalSeconds) {
  const seconds = Math.round(Number(totalSeconds ?? 0));
  if (!seconds) {
    return "0s";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  // Carry the rounded minutes into hours: 3599s is an hour, not "60m".
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function renderStatsReport({ rows, totals, by, days, database }) {
  const period = days ? `last ${days} day(s)` : "all time";
  const lines = [`# pi usage — ${period}, by ${by}`, ""];

  if (!Number(totals?.runs ?? 0)) {
    lines.push("No runs recorded yet.", "", `Journal: \`${database}\``);
    lines.push("", "Runs are recorded as they happen; nothing to show until the first one finishes.");
    return joinLines(lines);
  }

  lines.push(
    `- Runs: ${totals.runs}`,
    `- Tokens: in ${formatTokens(totals.input)} · out ${formatTokens(totals.output)}` +
      (Number(totals.cache_read) ? ` · cache ${formatTokens(totals.cache_read)}` : ""),
    Number(totals.cost) ? `- Cost: ${formatCost(totals.cost)}` : "- Cost: not reported by these providers",
    `- Agent time: ${formatDuration(totals.seconds)}`,
    ""
  );

  lines.push(
    `| ${by} | runs | ok | degr | in | out | ctx avg | ctx max | tok/s | out/run | p50 | p90 | tools | err | cost |`,
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const row of rows) {
    lines.push(
      `| ${row.bucket} | ${row.runs} | ${formatShare(row.completed, row.runs)} | ${row.degraded ?? 0} | ${formatTokens(row.input)} | ` +
        `${formatTokens(row.output)} | ${formatCompact(row.avg_context)} | ${formatCompact(row.max_context)} | ` +
        `${formatRate(row.tokensPerSecond)}${row.unreported_reasoning ? "*" : ""} | ${formatCompact(row.outputPerRun)} | ${formatSeconds(row.p50Seconds)} | ` +
        `${formatSeconds(row.p90Seconds)} | ${row.tool_calls ?? 0} | ${row.tool_errors ?? 0} | ${formatCost(row.cost) ?? "—"} |`
    );
  }

  // Вторая таблица — про то, КАК модель ломается. Она отвечает на другой вопрос,
  // чем первая, и склеивать их в одну строку из двадцати колонок значит не дать
  // прочитать ни ту, ни другую.
  if (rows.some((row) => row.think_typical || row.turns_idle || row.answers_cut || row.repeat_worst || row.loop_nudges)) {
    lines.push(
      "",
      `| ${by} | думает/ход | худший ход | ходов впустую | ответов в потолок | серия повторов | отправлено вмешательств |`,
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"
    );
    for (const row of rows) {
      // Знаменатель — ходы только тех прогонов, где turns_idle вообще посчитан
      // (движок json её не считает вовсе, см. jobs.mjs): деление на ХОДЫ ВСЕЙ
      // корзины тихо занижало долю прогонами, про которые сказать нечего, и
      // тем сильнее, чем больше таких прогонов рядом. Пусто — «н/д», а не
      // «0 (0%)», которое читалось бы как «проверили и нашли ноль».
      const idleTurns = Number(row.turns_idle_turns ?? 0);
      const idle = idleTurns > 0
        ? `${row.turns_idle ?? 0} (${Math.round((100 * (row.turns_idle ?? 0)) / idleTurns)}%)`
        : "н/д";
      // Среднее рассуждения считается не по всей корзине, если часть прогонов его
      // не отдаёт вовсе. Без пометки «12k знаков» читается как свойство корзины,
      // хотя может стоять на одном прогоне из двадцати.
      const thinkRuns = Number(row.think_runs ?? 0);
      const totalRuns = Number(row.runs ?? 0);
      const think = formatCompact(Math.round(Number(row.think_typical) || 0)) +
        (thinkRuns && totalRuns && thinkRuns < totalRuns ? ` (по ${thinkRuns} из ${totalRuns})` : "");
      lines.push(
        `| ${row.bucket} | ${think} | ` +
          `${formatCompact(Number(row.think_worst) || 0)} | ${idle} | ${row.answers_cut ?? 0} | ` +
          `${row.repeat_worst ?? 0} | ${row.loop_nudges ?? 0} |`
      );
    }
    lines.push(
      "",
      "Вторая таблица — профиль поломки, а не стоимости. «Думает/ход» — типичное число знаков рассуждения на один " +
        "ход, усреднённое по прогонам, которые рассуждение отдают (модели без него в среднее не входят — сколько прогонов "
        + "вошло, стоит в скобках): сумма за прогон растёт с его длиной и о модели не говорит ничего, а вот " +
        "рассуждение на ход у сорвавшихся прогонов было заметно обильнее, чем у чистых (docs/RESEARCH-truncation-flash-vs-glm.md; " +
        "там это средние по ходу, а не медиана, которую усредняет этот столбец, — числа не совпадают, сигнал тот же). " +
        "«Ходов впустую» — ходы, ушедшие целиком в размышление, без единого слова и вызова инструмента; движок json эту " +
        "метрику не считает вовсе, и доля у таких прогонов — «н/д», а не ноль. «Ответов в потолок» — сколько раз " +
        "генерация шла до упора (не то же, что оборванный последний ответ: тот виден в phase). «Серия повторов» — " +
        "самая длинная цепочка ответов одинаковой длины подряд, единственный признак повтора, который укладывается " +
        "в потолок и потому не меняет никаких других полей. «Отправлено вмешательств» — сколько раз плагин отправил " +
        "сообщение в сессию, пытаясь прервать круг в рассуждении; подхватил ли его агент, неизвестно — RPC подтверждает " +
        "доставку команды, а не то, что модель на неё среагировала."
    );
  }

  // Третья таблица — про работу с кодом, а не про стоимость и не про поломку.
  // Вопрос у неё свой: сколько кода прогон прочитал, прежде чем его менять.
  if (rows.some((row) => Number(row.file_work_runs ?? 0) > 0)) {
    lines.push(
      "",
      `| ${by} | замерено | прочитано/прогон | записано/прогон | заменено | читал:писал | перечитываний | сдано в дерево | цена строки |`,
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
    );
    for (const row of rows) {
      const measured = Number(row.file_work_runs ?? 0);
      if (!measured) {
        lines.push(`| ${row.bucket} | 0 | н/д | н/д | н/д | н/д | н/д | н/д | н/д |`);
        continue;
      }
      const read = Number(row.lines_read ?? 0);
      const written = Number(row.lines_written ?? 0);
      // Отношение — то, ради чего таблица и заведена: одно из чисел само по
      // себе не говорит ничего, а пара говорит форму работы. Делить на ноль
      // нечем — прогон, не написавший ни строки, это законный исход (ревью,
      // исследование), и у него отношения нет, а не «бесконечность».
      const ratio = written > 0 ? `${(read / written).toFixed(1)}:1` : "—";
      // Что дошло до дерева, против того, что инструменты отчитались написать.
      const diffRuns = Number(row.diff_runs ?? 0);
      const added = Number(row.diff_added ?? 0);
      const untracked = Number(row.diff_untracked ?? 0);
      const delivered = diffRuns
        ? `+${formatCompact(added)}/−${formatCompact(Number(row.diff_deleted) || 0)}${untracked ? ` (+${untracked} вне индекса)` : ""}`
        : "н/д";
      // Цена строки — единственная величина здесь, сравнимая между моделями
      // напрямую: дешёвая модель, переписывающая одно место шесть раз, дороже
      // дорогой, сделавшей это с первого захода.
      const diffCost = Number(row.diff_cost ?? 0);
      const perLine = diffRuns && added > 0 && diffCost > 0 ? `$${(diffCost / added).toFixed(4)}` : "—";
      lines.push(
        `| ${row.bucket} | ${measured} из ${row.runs ?? 0} | ${formatCompact(Math.round(read / measured))} | ` +
          `${formatCompact(Math.round(written / measured))} | ${formatCompact(Number(row.lines_replaced) || 0)} | ` +
          `${ratio} | ${row.rereads ?? 0} | ${delivered} | ${perLine} |`
      );
    }
    lines.push(
      "",
      "Третья таблица — про работу с кодом. Считается по вызовам собственных инструментов агента (`read`, `write`, " +
        "`edit`): чтение через `bash: cat` сюда не попадает и намеренно не угадывается — примесь вывода шелла сделала " +
        "бы отношение нечитаемым. «Читал:писал» — сколько строк кода прогон прочитал на каждую написанную; прогон, " +
        "который пишет больше, чем читает, меняет код, которого не видел. «Заменено» — строки, снесённые правками " +
        "(много при том же «записано» значит переписывание, а не дописывание). «Перечитывания» — повторные чтения " +
        "уже прочитанного файла: агент либо потерял контекст, либо проверяет собственную правку. «Сдано в дерево» — " +
        "строки из `git diff` от точки старта прогона: расхождение с «записано» значит переписывание одного и того же " +
        "места, то есть потраченные токены, от которых в дереве ничего не осталось; файлы, созданные и не добавленные " +
        "в индекс, git не видит, и их число стоит рядом отдельно. «Цена строки» — стоимость прогонов с замеренным " +
        "диффом, делённая на сданные строки: дешёвая модель, переписывающая одно место шесть раз, выходит дороже " +
        "дорогой, сделавшей это с первого захода. Колонка «замерено» говорит, на скольких прогонах корзины это вообще " +
        "посчитано: у прогонов старше замера колонки пусты, и в средние они не входят."
    );
  }

  // Четвёртая таблица — чем агент работал. Третья говорит, сколько он наработал;
  // эта — как он к этому шёл, и её колонки читаются вместе: много правок с
  // ошибкой при высокой доле шелла значит, что модель обходит инструменты и
  // промахивается мимо кода, которого не читала.
  if (rows.some((row) => Number(row.shell_calls) || Number(row.edit_errors) || Number(row.first_edit_runs))) {
    lines.push(
      "",
      `| ${by} | через шелл | правок мимо | чтений мимо | команд с ошибкой | до первой правки | повтор вызова |`,
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"
    );
    for (const row of rows) {
      // Ноль ошибок у прогона, где их никто не считал, читается как «проверили
      // и не нашли». Пусто — «н/д», как в остальных столбцах замера.
      if (!Number(row.tool_profile_runs ?? 0)) {
        lines.push(`| ${row.bucket} | н/д | н/д | н/д | н/д | н/д | н/д |`);
        continue;
      }
      const shellDenominator = Number(row.shell_calls_denom ?? 0);
      const shell = shellDenominator
        ? `${Math.round((100 * (Number(row.shell_calls) || 0)) / shellDenominator)}%`
        : "н/д";
      const firstEditRuns = Number(row.first_edit_runs ?? 0);
      // Прогоны, которые не правили ничего (ревью, исследование), в среднее не
      // входят вовсе: у них нет первой правки, а не «ноль до неё».
      const firstEdit = firstEditRuns
        ? `${formatSeconds(Math.round(Number(row.first_edit_ms) / 1000))}${
            firstEditRuns < Number(row.runs ?? 0) ? ` (по ${firstEditRuns})` : ""
          }`
        : "н/д";
      lines.push(
        `| ${row.bucket} | ${shell} | ${row.edit_errors ?? 0} | ${row.read_errors ?? 0} | ` +
          `${row.shell_errors ?? 0} | ${firstEdit} | ${row.repeat_call_worst ?? 0} |`
      );
    }
    lines.push(
      "",
      "Четвёртая таблица — чем агент работал. «Через шелл» — доля вызовов, ушедших в `bash`: она же размер слепого " +
        "пятна третьей таблицы, потому что `cat` и `sed -i` в строчные счётчики не попадают. «Правок мимо» — правки, " +
        "не нашедшие того, что собирались заменить: сильнейший из здешних признаков того, что модель пишет по памяти, " +
        "а не по прочитанному (общий столбец `err` первой таблицы складывает это с упавшими командами, где виновата " +
        "сама работа, а не модель). «До первой правки» — сколько прогон осматривался, прежде чем тронуть первый файл; " +
        "снаружи «долго читал» и «долго думал» выглядят одинаково медленно, а лечатся по-разному. «Повтор вызова» — " +
        "самая длинная серия одинаковых вызовов подряд: круг в действиях, тогда как «серия повторов» второй таблицы — " +
        "круг в ответах."
    );
  }

  lines.push(
    "",
    "`tok/s` is generated tokens over the generation window measured on the credential proxy: first content frame to " +
      "last chunk, which is the only span carrying neither prefill nor the provider's queue. Runs without that " +
      "telemetry — recorded before it existed, or run without a sandbox — are left out rather than folded in on a " +
      "different measurement, and so are answers under 1,000 output tokens, whose first frame was generated before the " +
      "window opened. `out/run` is the average answer length behind the rate: two buckets whose lengths differ several " +
      "times over are not comparable, whatever the denominator says. `p50`/`p90` are run durations, tools included. " +
      "`degr` counts runs that finished with an answer but a non-zero exit — a truncated stream, a dropped connection. " +
      "They are inside `ok`, since the work landed, and worth watching separately when a provider starts misbehaving.",
    "",
    "`ctx` is how much of the context window a run held at its peak — averaged and at its worst — which the `in` " +
      "column cannot show, since every turn resends the conversation.",
    "",
    "A `*` on `tok/s` marks a provider that streams hidden reasoning but reports `reasoning = 0`: those tokens cost " +
      "time without entering the count, so the rate is an underestimate and is not comparable with the others.",
    "",
    `Journal: \`${database}\` · group by \`--by day|model|preset|workspace|kind|status\` · \`--days N\` or \`--all\`.`
  );
  return joinLines(lines);
}

/** Contour a session was last run with — what a continuation inherits. */
function sessionContour(session) {
  const parts = [session.preset ? `\`${session.preset}\`` : (session.model ?? "—")];
  if (session.sandbox) {
    // The label carries the whole sandbox descriptor; the column only has room
    // for the part that identifies it.
    parts.push(String(session.sandbox).split(",")[0].replace(/^docker\s+/, ""));
  }
  if (session.readOnly) {
    parts.push("read-only");
  }
  return parts.join(" · ");
}

/**
 * The sessions of one workspace and the state of the cache behind each.
 *
 * `age` is time since the provider last saw the session, which is what decides
 * whether continuing it replays from cache or pays for the whole history again.
 */
export function renderSessionsReport(sessions, { workspace = null, ttlMs, global: everywhere = false } = {}) {
  const scope = everywhere ? "every workspace" : `\`${workspace}\``;
  if (!sessions.length) {
    return joinLines([
      "# pi sessions",
      "",
      `No pi session recorded for ${scope} yet.`,
      "",
      "Sessions are bucketed by the directory a run was started from: one started elsewhere is not missing, it is " +
        "just in another bucket. `--global` looks across all of them."
    ]);
  }

  const rows = sessions.map((session) => {
    const state = cacheState(session, session.ttlMs ?? ttlMs);
    const age = session.live ? "running" : formatAge(session.ageMs);
    const context = session.contextTokens ? formatTokens(session.contextTokens) : "—";
    return (
      `| \`${session.sessionId.slice(0, 8)}…${session.sessionId.slice(-4)}\` | ${age} | ${state} | ` +
      `${sessionContour(session)} | ${context} | \`${session.jobId}\` |`
    );
  });

  const warm = sessions.find((session) => cacheState(session, session.ttlMs ?? ttlMs) === "warm");
  return joinLines([
    `# pi sessions — ${scope}`,
    "",
    "| session | age | cache | contour | context | last job |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    `Cache TTL in force: ${formatAge(ttlMs)} — a \`cold\` session still holds all its history, but continuing ` +
      "it re-sends that history at the full input rate instead of reading it from the provider's cache.",
    warm
      ? `Continue one with \`continue ${warm.sessionId.slice(0, 8)} "<task>"\` — the preset, model and sandbox of its ` +
        "last run come along."
      : "Every session here is past the TTL: continue one with `--stale-ok` if its history is worth the re-billing, " +
        "or start a fresh run."
  ]);
}
