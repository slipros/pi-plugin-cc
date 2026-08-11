import { spawn } from "node:child_process";
import process from "node:process";

import { listModels } from "./models.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";
import { isSandboxed, removeSandboxContainer, resolveLaunch } from "./sandbox.mjs";

export const PI_BINARY = process.env.PI_PLUGIN_BINARY?.trim() || "pi";

/**
 * Tool set for reviews and other look-but-do-not-touch runs.
 *
 * The lsp_* half is navigation, not mutation: it answers where a symbol is
 * declared and who calls it. A review is exactly the run that needs it — `--tools`
 * is an allow list, so leaving them out left a reviewer grepping for names and
 * hitting `Tool lsp_references not found` on every attempt to do better.
 * `lsp_more` pages through a truncated result and is useless without them.
 * `lsp_diagnostics` stays out on purpose: gates own the verdict on whether code
 * is broken, and a reviewer reading a language server's opinion instead invites
 * findings no build would confirm.
 */
export const READ_ONLY_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_document_symbols",
  "lsp_workspace_symbols",
  "lsp_more"
];

const TEXT_BLOCK_TYPES = new Set(["text"]);

export function getPiAvailability(cwd) {
  if (!binaryAvailable(PI_BINARY)) {
    return {
      installed: false,
      version: null,
      models: [],
      error: `\`${PI_BINARY}\` was not found on PATH.`
    };
  }

  const version = runCommand(PI_BINARY, ["--version"], { cwd });
  let models = [];
  let error = null;
  try {
    models = listModels(PI_BINARY, { cwd });
  } catch (listError) {
    error = listError instanceof Error ? listError.message : String(listError);
  }

  return {
    installed: true,
    version: version.status === 0 ? version.stdout.trim() : null,
    models,
    error
  };
}

function collectText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((block) => TEXT_BLOCK_TYPES.has(block?.type))
    .map((block) => String(block.text ?? ""))
    .join("")
    .trim();
}

function summarizeToolCall(toolName, args) {
  const name = String(toolName ?? "tool");
  if (!args || typeof args !== "object") {
    return name;
  }
  const target =
    args.path ?? args.file ?? args.filePath ?? args.pattern ?? args.command ?? args.query ?? null;
  if (target == null) {
    return name;
  }
  const text = String(target).replace(/\s+/g, " ").trim();
  return `${name}: ${text.length > 96 ? `${text.slice(0, 93)}...` : text}`;
}

/** Tokens the model actually generated: visible output plus hidden reasoning. */
function producedTokens(usage) {
  if (!usage || typeof usage !== "object") {
    return 0;
  }
  return (typeof usage.output === "number" ? usage.output : 0) +
    (typeof usage.reasoning === "number" ? usage.reasoning : 0);
}

/**
 * How much of the context window one exchange occupied: everything the model
 * had to hold at once — the prompt it was sent, whatever of it was served from
 * cache, and the answer it produced.
 *
 * The per-run total of `input` cannot answer this. Every turn resends the
 * conversation, so a 47-turn run sums to a million input tokens while never
 * holding more than a fraction of that at once.
 */
function contextTokens(usage) {
  if (!usage || typeof usage !== "object") {
    return 0;
  }
  const value = (key) => (typeof usage[key] === "number" ? usage[key] : 0);
  return value("input") + value("cacheRead") + value("output") + value("reasoning");
}

/** Pairs a tool_execution_end with its start; ids differ per pi version. */
function toolKey(event) {
  return String(event.toolCallId ?? event.id ?? event.callId ?? event.toolName ?? "tool");
}

/**
 * The timings a finished run reports.
 *
 * `toolMs` is the wall-clock the tools held, with overlapping calls counted
 * once; `modelMs` is everything else in the run's span, which is the waiting on
 * the model. A tool still open when the run ended contributes nothing — its
 * start would otherwise swallow the rest of the run.
 */
export function summarizeTiming(timing) {
  if (!timing || timing.firstEventAt === null) {
    return { spanMs: 0, modelMs: 0, toolMs: 0 };
  }
  const spanMs = Math.max(0, timing.lastEventAt - timing.firstEventAt);
  const toolMs = mergeIntervals(timing.toolIntervals);
  return { spanMs, modelMs: Math.max(0, spanMs - toolMs), toolMs };
}

/** Total length covered by intervals, counting overlaps once. */
function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  let total = 0;
  let cursor = -Infinity;
  for (const [start, end] of sorted) {
    const from = Math.max(start, cursor);
    if (end > from) {
      total += end - from;
      cursor = end;
    }
  }
  return total;
}

function accumulateUsage(target, usage) {
  if (!usage || typeof usage !== "object") {
    return target;
  }
  const next = { ...target };
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]) {
    if (typeof usage[key] === "number") {
      next[key] = (next[key] ?? 0) + usage[key];
    }
  }
  const cost = usage.cost;
  if (cost && typeof cost === "object" && typeof cost.total === "number") {
    next.cost = (next.cost ?? 0) + cost.total;
  }
  return next;
}

/**
 * Build the argv for a `pi` run.
 * Exported so tests can assert the mapping without spawning anything.
 */
export function buildPiArgs({
  model = null,
  provider = null,
  thinking = null,
  systemPrompt = null,
  appends = [],
  tools = null,
  excludeTools = null,
  readOnly = false,
  noTools = false,
  noBuiltinTools = false,
  extensions = [],
  skills = [],
  noExtensions = false,
  noSkills = false,
  sessionId = null,
  sessionName = null,
  noSession = false,
  mode = "json"
} = {}) {
  // json mode is a one-shot turn on stdin; rpc keeps a two-way channel open so
  // the run can be steered while it works.
  const args = mode === "rpc" ? ["--mode", "rpc"] : ["--print", "--mode", "json"];

  if (provider) {
    args.push("--provider", provider);
  }
  if (model) {
    args.push("--model", model);
  }
  if (thinking) {
    args.push("--thinking", thinking);
  }
  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }
  for (const append of appends) {
    if (append) {
      args.push("--append-system-prompt", append);
    }
  }

  // An empty list is a deliberate "no restriction", so it must not turn into
  // an empty --tools / --exclude-tools value.
  const asToolList = (value) => {
    const list = Array.isArray(value) ? value.join(",") : value;
    return list ? String(list) : null;
  };
  const toolAllowList = asToolList(tools) ?? (readOnly ? READ_ONLY_TOOLS.join(",") : null);
  const toolDenyList = asToolList(excludeTools);

  if (noTools) {
    args.push("--no-tools");
  } else {
    if (noBuiltinTools) {
      args.push("--no-builtin-tools");
    }
    if (toolAllowList) {
      args.push("--tools", toolAllowList);
    }
    if (toolDenyList) {
      args.push("--exclude-tools", toolDenyList);
    }
  }

  // Extensions are how pi gains tools beyond the built-ins — including MCP
  // servers, via the pi-mcp-adapter extension.
  if (noExtensions) {
    args.push("--no-extensions");
  }
  for (const extension of extensions) {
    if (extension) {
      args.push("--extension", extension);
    }
  }
  if (noSkills) {
    args.push("--no-skills");
  }
  for (const skill of skills) {
    if (skill) {
      args.push("--skill", skill);
    }
  }

  if (noSession) {
    args.push("--no-session");
  } else if (sessionId) {
    args.push("--session", sessionId);
  }
  if (sessionName) {
    args.push("--name", sessionName);
  }

  return args;
}

/**
 * Parse one line of pi's JSON event stream into progress/result state.
 * Kept pure so the stream handling is unit testable.
 */
/**
 * Render argv for logs without dumping whole system prompts into them.
 */
export function redactArgs(args) {
  const redacted = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    redacted.push(arg);
    if (arg === "--system-prompt" || arg === "--append-system-prompt") {
      const value = args[++index] ?? "";
      redacted.push(`<${String(value).length} chars>`);
    }
  }
  return redacted.join(" ");
}

export function applyPiEvent(state, event, now = Date.now()) {
  if (!event || typeof event !== "object") {
    return null;
  }
  // Older callers may hand in a state built before timings existed.
  const timing = (state.timing ??= createTimingState());
  timing.firstEventAt ??= now;
  timing.lastEventAt = now;

  switch (event.type) {
    case "message_start": {
      return null;
    }
    case "session": {
      if (event.id) {
        state.sessionId = String(event.id);
      }
      return { phase: "starting", message: `pi session ${state.sessionId ?? "(unknown)"} started.` };
    }
    case "turn_start": {
      state.turns += 1;
      return { phase: "working", message: `Turn ${state.turns} started.` };
    }
    case "tool_execution_start": {
      const summary = summarizeToolCall(event.toolName, event.args);
      state.toolCalls.push(summary);
      timing.toolStartedAt.set(toolKey(event), now);
      return { phase: "working", message: summary };
    }
    case "tool_execution_end": {
      const startedAt = timing.toolStartedAt.get(toolKey(event));
      if (startedAt !== undefined) {
        timing.toolIntervals.push([startedAt, now]);
        timing.toolStartedAt.delete(toolKey(event));
      }
      if (event.isError) {
        state.toolErrors += 1;
        return { phase: "working", message: `${event.toolName ?? "tool"} reported an error.` };
      }
      return null;
    }
    case "message_end": {
      const message = event.message ?? {};
      if (message.role === "assistant") {
        const text = collectText(message);
        if (text) {
          state.assistantTexts.push(text);
        }
        state.peakContext = Math.max(state.peakContext ?? 0, contextTokens(message.usage));
        state.usage = accumulateUsage(state.usage, message.usage);
        if (message.model) {
          state.model = message.provider ? `${message.provider}/${message.model}` : String(message.model);
        }
        if (message.stopReason) {
          state.stopReason = String(message.stopReason);
        }
        if (message.errorMessage) {
          state.errors.push(String(message.errorMessage));
        }
      }
      return null;
    }
    case "agent_end": {
      // One low-level run finished; retries, compaction or queued messages may
      // still continue the session, so this is not the end of the job.
      return { phase: "finishing", message: event.willRetry ? "pi will retry." : "pi finished a run." };
    }
    case "agent_settled": {
      state.settled = true;
      return { phase: "finishing", message: "pi settled." };
    }
    case "queue_update": {
      const steering = Array.isArray(event.steering) ? event.steering : [];
      const followUp = Array.isArray(event.followUp) ? event.followUp : [];
      state.queue = { steering, followUp };
      if (!steering.length && !followUp.length) {
        return null;
      }
      return {
        phase: "working",
        message: `Queued: ${steering.length} steering, ${followUp.length} follow-up.`
      };
    }
    case "error": {
      const text = String(event.message ?? event.error ?? "pi reported an error.");
      state.errors.push(text);
      return { phase: "working", message: `Error: ${text}` };
    }
    default:
      return null;
  }
}

/**
 * Wall-clock split of a run: time spent waiting on the model versus time spent
 * inside its tools.
 *
 * Model time is measured by subtraction — the span of the run minus the time
 * tools held it — because the event stream cannot time generation directly.
 * `message_start` arrives only once the provider starts answering, and the
 * tokens then land in a few large batches (52 of them within 50ms over the
 * wire), so the start-to-end interval measures delivery, not decoding: it
 * would report a thousand tokens per second for a model doing thirty. What
 * happens before `message_start` — prefill, queueing, the network — is the part
 * that actually costs time, and subtraction keeps it in.
 *
 * Tool intervals are merged rather than summed: an agent that fires three LSP
 * queries at once holds the run for the longest of them, not for their total,
 * and summing produced tool time exceeding the run's own duration.
 */
function createTimingState() {
  return {
    firstEventAt: null,
    lastEventAt: null,
    toolIntervals: [],
    toolStartedAt: new Map()
  };
}

export function createTurnState() {
  return {
    sessionId: null,
    turns: 0,
    toolCalls: [],
    toolErrors: 0,
    assistantTexts: [],
    usage: {},
    timing: createTimingState(),
    peakContext: 0,
    model: null,
    thinkingLevel: null,
    stopReason: null,
    errors: [],
    queue: { steering: [], followUp: [] },
    settled: false
  };
}

/**
 * Run a single non-interactive pi turn and stream progress back to the caller.
 *
 * @returns {Promise<{
 *   text: string, sessionId: string|null, usage: object, model: string|null,
 *   stopReason: string|null, toolCalls: string[], exitStatus: number,
 *   stderr: string, errors: string[], timedOut: boolean, command: string
 * }>}
 */
export async function runPiTurn({
  cwd,
  prompt,
  timeoutMs = 1_800_000,
  onProgress = null,
  onSpawn = null,
  env = process.env,
  sandbox = null,
  jobId = null,
  ...options
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("Refusing to start pi with an empty prompt.");
  }

  const piArgs = buildPiArgs(options);
  const launch = resolveLaunch({ sandbox, binary: PI_BINARY, piArgs, cwd, jobId, env });
  const state = createTurnState();
  const report = (event) => {
    if (event && onProgress) {
      onProgress(event);
    }
  };

  report({ phase: "starting", message: `Running ${launch.command} ${redactArgs(launch.args)}` });

  // detached puts pi in its own process group, so cancelling a job can take
  // down the tools it spawned without touching the caller's shell.
  const child = spawn(launch.command, launch.args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });

  onSpawn?.({ pid: child.pid ?? null, containerName: launch.containerName });

  let stderr = "";
  let stdoutRest = "";
  let timedOut = false;

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
          // Signalling the `docker run` client does not stop the container.
          if (isSandboxed(sandbox)) {
            removeSandboxContainer(launch.containerName);
          }
        }, timeoutMs)
      : null;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutRest += chunk;
    let newlineIndex = stdoutRest.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stdoutRest.slice(0, newlineIndex).trim();
      stdoutRest = stdoutRest.slice(newlineIndex + 1);
      if (line) {
        try {
          const update = applyPiEvent(state, JSON.parse(line));
          report(update ? { ...update, usage: state.usage } : null);
        } catch {
          // Non-JSON output on stdout is diagnostic noise, not a fatal error.
        }
      }
      newlineIndex = stdoutRest.indexOf("\n");
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.stdin.end(String(prompt));

  const exitStatus = await new Promise((resolve, reject) => {
    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve(code == null ? (signal ? 1 : 0) : code);
    });
  });

  if (stdoutRest.trim()) {
    try {
      const tailUpdate = applyPiEvent(state, JSON.parse(stdoutRest.trim()));
      report(tailUpdate ? { ...tailUpdate, usage: state.usage } : null);
    } catch {
      // Trailing partial line; nothing useful to recover.
    }
  }

  const text = state.assistantTexts.at(-1) ?? "";
  const errors = [...state.errors];
  if (timedOut) {
    errors.push(`pi exceeded the ${Math.round(timeoutMs / 1000)}s timeout and was terminated.`);
  }
  if (!text && !errors.length && exitStatus === 0) {
    errors.push("pi produced no assistant output.");
  }
  if (exitStatus !== 0 && stderr.trim()) {
    errors.push(stderr.trim());
  }

  return {
    text,
    sessionId: state.sessionId,
    usage: state.usage,
    model: state.model,
    stopReason: state.stopReason,
    turns: state.turns,
    toolCalls: state.toolCalls,
    toolErrors: state.toolErrors,
    timing: summarizeTiming(state.timing),
    peakContext: state.peakContext ?? 0,
    exitStatus: errors.length && exitStatus === 0 ? 1 : exitStatus,
    stderr: stderr.trim(),
    errors,
    timedOut,
    containerName: launch.containerName,
    command: `${launch.command} ${redactArgs(launch.args)}`
  };
}
