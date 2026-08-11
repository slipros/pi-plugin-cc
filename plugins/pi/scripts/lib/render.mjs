import { groupByProvider } from "./models.mjs";
import { READ_ONLY_TOOLS } from "./pi.mjs";

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

export function renderModelsReport({ models, presets, prompts, defaults, search, measured = null }) {
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
        "| Model | runs | ok | ctx avg | ctx max | tok/s | p50 | p90 | turns/run | tool err | cost |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
      );
      for (const row of measured) {
        const turnsPerRun = row.runs ? (Number(row.turns ?? 0) / row.runs).toFixed(1) : "—";
        lines.push(
          `| \`${row.bucket}\` | ${row.runs} | ${formatShare(row.completed, row.runs)} | ` +
            `${formatCompact(row.avg_context)} | ${formatCompact(row.max_context)} | ` +
            `${formatRate(row.tokensPerSecond)} | ${formatSeconds(row.p50Seconds)} | ${formatSeconds(row.p90Seconds)} | ` +
            `${turnsPerRun} | ${formatShare(row.tool_errors, row.tool_calls)} | ${formatCost(row.cost) ?? "—"} |`
        );
      }
      lines.push(
        "",
        "`tok/s` counts generated tokens against model time only — runs older than that measurement are left out of it."
      );
    } else {
      lines.push("No runs recorded yet, so there is nothing to compare.");
    }
  }

  const presetNames = Object.keys(presets ?? {});
  lines.push("");
  lines.push("## Presets");
  lines.push("");
  if (presetNames.length) {
    for (const name of presetNames) {
      const preset = presets[name];
      const details = [
        preset.model ? `model \`${preset.model}\`` : null,
        preset.provider ? `provider \`${preset.provider}\`` : null,
        preset.thinking ? `thinking \`${preset.thinking}\`` : null,
        preset.systemPrompt ? `prompt \`${preset.systemPrompt}\`` : null,
        preset.readOnly ? "read-only" : null
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(`- \`${name}\` — ${details || "no overrides"}`);
    }
  } else {
    lines.push("- none configured (add a `presets` block to `.claude/pi/config.json`)");
  }

  lines.push("");
  lines.push("## System prompts");
  lines.push("");
  lines.push(prompts.length ? prompts.map((name) => `- \`${name}\``).join("\n") : "- none");

  lines.push("");
  lines.push("## Defaults");
  lines.push("");
  lines.push(`- model: ${defaults.model ? `\`${defaults.model}\`` : "pi decides"}`);
  lines.push(`- thinking: ${defaults.thinking ? `\`${defaults.thinking}\`` : "pi decides"}`);
  lines.push(`- system prompt: ${defaults.systemPrompt ? `\`${defaults.systemPrompt}\`` : "pi default"}`);

  lines.push("");
  lines.push("Use `--model <id>`, `--provider <name>`, `--thinking <level>` or `--preset <name>` on `/pi:delegate` and `/pi:review`.");

  return joinLines(lines);
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
    settings.presetName ? `- Preset: \`${settings.presetName}\`` : null,
    // Only worth a line when it is not the directory the caller is standing in.
    job.runRoot && job.runRoot !== job.workspaceRoot ? `- Working directory: \`${job.runRoot}\`` : null,
    settings.promptLabel ? `- ${settings.promptLabel.replace(/^system prompt/, "System prompt")}` : null,
    settings.readOnly ? `- Tools: read-only (\`${READ_ONLY_TOOLS.join("`, `")}\`)` : null,
    // The run works in a worktree, so the repository it belongs to came along.
    settings.worktreeMount ? `- Worktree: shared \`${settings.worktreeMount.split(":")[0]}\` mounted` : null,
    settings.git ? `- Commits as: ${settings.git.name} <${settings.git.email}>` : null,
    execution?.sessionId ? `- pi session: \`${execution.sessionId}\` (resume with \`pi --session ${execution.sessionId}\`)` : null,
    formatUsage(execution?.usage) ? `- Usage: ${formatUsage(execution.usage)}` : null,
    execution?.elapsed ? `- Duration: ${execution.elapsed}` : null
  ].filter(Boolean);

  return [`# ${title}`, "", ...meta, ""];
}

export function renderRunResult({ title, job, settings, execution }) {
  const lines = renderRunHeader(title, { job, settings, execution });

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

  if (execution.errors?.length) {
    lines.push("## Problems", "");
    for (const error of execution.errors) {
      lines.push(`- ${error}`);
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
  const icon = STATUS_ICONS[job.status] ?? "•";
  const parts = [
    `${icon} \`${job.id}\``,
    job.kind,
    job.status,
    job.phase ? `phase: ${job.phase}` : null,
    job.model ? `model: ${job.model}` : null,
    job.elapsed ? `elapsed: ${job.elapsed}` : null
  ].filter(Boolean);
  return `- ${parts.join(" · ")}`;
}

export function renderStatusReport(snapshot) {
  const lines = ["# pi jobs", ""];

  if (!snapshot.jobs.length) {
    lines.push("No pi jobs recorded for this workspace yet.");
    return joinLines(lines);
  }

  for (const job of snapshot.jobs) {
    lines.push(jobLine(job));
    if (job.title) {
      lines.push(`  - Task: ${job.title}`);
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
  return `${Math.round((100 * Number(part ?? 0)) / total)}%`;
}

/** Tokens per second; null when no run in the bucket carried timings. */
function formatRate(rate) {
  if (rate == null || !Number.isFinite(rate) || rate <= 0) {
    return "—";
  }
  return rate >= 100 ? String(Math.round(rate)) : rate.toFixed(1);
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
  return seconds >= 90 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds)}s`;
}

function formatDuration(totalSeconds) {
  const seconds = Number(totalSeconds ?? 0);
  if (!seconds) {
    return "0s";
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes || Math.round(seconds)}${hours ? "m" : minutes ? "m" : "s"}`;
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
    `| ${by} | runs | ok | in | out | ctx avg | ctx max | tok/s | p50 | p90 | tools | err | cost |`,
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const row of rows) {
    lines.push(
      `| ${row.bucket} | ${row.runs} | ${formatShare(row.completed, row.runs)} | ${formatTokens(row.input)} | ` +
        `${formatTokens(row.output)} | ${formatCompact(row.avg_context)} | ${formatCompact(row.max_context)} | ` +
        `${formatRate(row.tokensPerSecond)} | ${formatSeconds(row.p50Seconds)} | ` +
        `${formatSeconds(row.p90Seconds)} | ${row.tool_calls ?? 0} | ${row.tool_errors ?? 0} | ${formatCost(row.cost) ?? "—"} |`
    );
  }

  lines.push(
    "",
    "`tok/s` is generated tokens over model time — the run minus the time its tools held it; runs recorded before " +
      "timings existed count as zero and are left out of it. `p50`/`p90` are run durations, tools included. " +
      "`ctx` is how much of the context window a run held at its peak — averaged and at its worst — which the `in` " +
      "column cannot show, since every turn resends the conversation.",
    "",
    `Journal: \`${database}\` · group by \`--by day|model|preset|workspace|kind|status\` · \`--days N\` or \`--all\`.`
  );
  return joinLines(lines);
}
