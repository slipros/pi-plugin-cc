import { spawn } from "node:child_process";
import process from "node:process";

import { listModels } from "./models.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";

export const PI_BINARY = process.env.PI_PLUGIN_BINARY?.trim() || "pi";

/** Tool set for reviews and other look-but-do-not-touch runs. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

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
  sessionId = null,
  sessionName = null,
  noSession = false
} = {}) {
  const args = ["--print", "--mode", "json"];

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

  const toolAllowList = tools ?? (readOnly ? READ_ONLY_TOOLS.join(",") : null);
  if (toolAllowList) {
    args.push("--tools", Array.isArray(toolAllowList) ? toolAllowList.join(",") : toolAllowList);
  }
  if (excludeTools) {
    args.push("--exclude-tools", Array.isArray(excludeTools) ? excludeTools.join(",") : excludeTools);
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
export function applyPiEvent(state, event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  switch (event.type) {
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
      return { phase: "working", message: summary };
    }
    case "tool_execution_end": {
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
      state.settled = true;
      return { phase: "finishing", message: "pi finished its work." };
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

function createTurnState() {
  return {
    sessionId: null,
    turns: 0,
    toolCalls: [],
    toolErrors: 0,
    assistantTexts: [],
    usage: {},
    model: null,
    stopReason: null,
    errors: [],
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
  env = process.env,
  ...options
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("Refusing to start pi with an empty prompt.");
  }

  const args = buildPiArgs(options);
  const state = createTurnState();
  const report = (event) => {
    if (event && onProgress) {
      onProgress(event);
    }
  };

  report({ phase: "starting", message: `Running ${PI_BINARY} ${args.join(" ")}` });

  const child = spawn(PI_BINARY, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stderr = "";
  let stdoutRest = "";
  let timedOut = false;

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
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
          report(applyPiEvent(state, JSON.parse(line)));
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
      report(applyPiEvent(state, JSON.parse(stdoutRest.trim())));
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
    toolCalls: state.toolCalls,
    toolErrors: state.toolErrors,
    exitStatus: errors.length && exitStatus === 0 ? 1 : exitStatus,
    stderr: stderr.trim(),
    errors,
    timedOut,
    command: `${PI_BINARY} ${args.join(" ")}`
  };
}
