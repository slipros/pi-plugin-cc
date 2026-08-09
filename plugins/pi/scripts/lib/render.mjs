import { groupByProvider } from "./models.mjs";

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

export function renderModelsReport({ models, presets, prompts, defaults, search }) {
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
    settings.readOnly ? "- Tools: read-only (`read`, `grep`, `find`, `ls`)" : null,
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
