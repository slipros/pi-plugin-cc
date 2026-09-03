import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { budgetExceeded } from "./budget.mjs";
import { isTruncationReason } from "./finish-reason.mjs";
import { listModels } from "./models.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";
import { MASKED_MODEL, MASKED_PROVIDER, startCredentialProxy } from "./credential-proxy.mjs";
import { openGitProxy, withGitProxy } from "./git-proxy.mjs";
import { settleProxyPorts } from "./proxy-bind.mjs";
import { awaitSandboxSlot, isSandboxed, removeSandboxContainer, resolveLaunch } from "./sandbox.mjs";

import {
  createAgentWorkState,
  mergeAgentWork,
  noteToolEnd,
  noteToolStart,
  summarizeAgentWork
} from "./agent-work.mjs";
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

/**
 * How much of the context window one exchange occupied: everything the model
 * had to hold at once — the prompt it was sent, whatever of it came from cache,
 * what was written to cache, and the answer it produced.
 *
 * The per-run total of `input` cannot answer this. Every turn resends the
 * conversation, so a 47-turn run sums to a million input tokens while never
 * holding more than a fraction of that at once.
 *
 * `reasoning` is deliberately absent: providers report it as a *subset* of
 * `output`, not in addition to it ("completion_tokens already includes
 * reasoning_tokens" — pi-ai's own openai-completions provider), so adding it
 * counted those tokens twice. `cacheWrite` is present because Anthropic keeps
 * cache creation out of `input`, and a first turn that writes a 100K prompt to
 * cache would otherwise register as a few hundred tokens.
 */
function contextTokens(usage) {
  if (!usage || typeof usage !== "object") {
    return 0;
  }
  const value = (key) => (typeof usage[key] === "number" ? usage[key] : 0);
  return value("input") + value("cacheRead") + value("cacheWrite") + value("output");
}

/**
 * Length of the model's hidden reasoning in this message, in characters.
 *
 * Not a token count and not a substitute for one — it exists to tell apart
 * "this model did not reason" from "this provider does not report reasoning".
 * ollama-pro returns `usage.reasoning = 0` while shipping thinking blocks in
 * the content, so its generated tokens land in the denominator of a rate and
 * never in the numerator; without this the two cases look identical.
 */
export function thinkingLength(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((block) => THINKING_BLOCK_TYPES.has(block?.type))
    .reduce((total, block) => total + String(block.thinking ?? block.text ?? "").length, 0);
}

const THINKING_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);

/**
 * Did this turn produce work, or did it go entirely into reasoning?
 *
 * Work is any block that is not hidden reasoning: prose for the supervisor OR a
 * tool call. A turn that only calls a tool carries no text at all — pi ships it
 * as `content: [thinking, toolCall]` — so counting text alone marks ordinary
 * work as an idle turn: file-by-file refactoring, reading a test run, a series
 * of similar edits. That is the loop detector's worst failure mode, because it
 * spends its nudges interrupting an agent that is working correctly.
 *
 * Unknown block types count as work on purpose: a new content type is far more
 * likely to be an action than another flavour of reasoning, and the safe error
 * here is to stay silent.
 */
export function producedWork(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.some((block) => block?.type && !THINKING_BLOCK_TYPES.has(block.type));
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
      continue;
    }
    // `-e NAME=value` carries whatever a profile puts in the container's
    // environment, and this line goes to the job log, the status preview and
    // the --json output. The name is worth keeping, the value never is.
    if (arg === "-e" || arg === "--env") {
      const value = String(args[++index] ?? "");
      const separator = value.indexOf("=");
      redacted.push(separator === -1 ? value : `${value.slice(0, separator)}=<hidden>`);
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
      noteToolStart((state.agentWork ??= createAgentWorkState()), event.toolName, event.args, {
        now,
        runStartedAt: timing.firstEventAt
      });
      (state.openToolCalls ??= new Map()).set(toolKey(event), {
        name: event.toolName,
        args: event.args
      });
      return { phase: "working", message: summary };
    }
    case "tool_execution_end": {
      const startedAt = timing.toolStartedAt.get(toolKey(event));
      if (startedAt !== undefined) {
        timing.toolIntervals.push([startedAt, now]);
        timing.toolStartedAt.delete(toolKey(event));
      }
      const opened = (state.openToolCalls ??= new Map()).get(toolKey(event));
      state.openToolCalls.delete(toolKey(event));
      noteToolEnd(
        (state.agentWork ??= createAgentWorkState()),
        event.toolName ?? opened?.name,
        opened?.args,
        event.result,
        Boolean(event.isError)
      );
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
        state.thinkingChars = (state.thinkingChars ?? 0) + thinkingLength(message);
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
 * tools held it — because the event stream carries no generation window of its
 * own. An earlier version of this comment claimed tokens arrive "in a few large
 * batches, 52 within 50ms", and that the interval therefore measures delivery
 * rather than decoding. That was measured wrong and is not true: checked from
 * both ends of the channel — on the credential proxy and in the companion's own
 * events — the median gap between deltas is 11ms, so the stream is as steady as
 * the model produces it.
 *
 * What subtraction really costs is the opposite mistake: `modelMs` includes
 * prefill, the provider's queue and the network, so a rate computed from it
 * *understates* generation, by about half on a measured run (122 against 259
 * tok/s). The honest generation window is `stream_ms` from the proxy, which
 * starts at the first content frame — see `sse-meter.mjs`. This number stays
 * what it always was, "everything in the run that was not a tool", so the
 * history it is compared against keeps meaning the same thing.
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
    thinkingChars: 0,
    agentWork: createAgentWorkState(),
    // Arguments of tools still running, so the result event can be attributed
    // to the file its call named: `tool_execution_end` carries the answer but
    // not always the request.
    openToolCalls: new Map(),
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
/**
 * Bring up the credential proxy for a sandboxed run, if the provider allows it.
 *
 * Never fatal: a proxy that cannot start means the run proceeds the old way,
 * with the provider's own credential mounted, rather than not running at all.
 */
/** Provider the run really used, for records that must not show the mask. */
function proxyProviderOf(sandbox) {
  return sandbox?.provider ?? "unknown";
}

async function openCredentialProxy(sandbox, onProgress, model, jobId = null) {
  // `proxyCredentials: false` in a profile opts out — for a provider whose
  // endpoint does something the plain forwarder here does not reproduce.
  if (!isSandboxed(sandbox) || !sandbox.auth || !sandbox.provider || sandbox.proxyCredentials === false) {
    return null;
  }
  try {
    const homeDir = os.homedir();
    const auth = JSON.parse(fs.readFileSync(path.join(homeDir, ".pi", "agent", "auth.json"), "utf8"));
    const proxy = await startCredentialProxy({
      homeDir,
      provider: sandbox.provider,
      model,
      authEntry: auth?.[sandbox.provider],
      onWarning: (message) => onProgress?.({ phase: "working", message }),
      // Ties the per-request telemetry to the run; without it the proxy
      // measures nothing rather than writing rows nothing can be joined to.
      jobId
    });
    if (proxy) {
      onProgress?.({ phase: "starting", message: `Credentials stay on the host: ${sandbox.provider} goes through a run-scoped proxy.` });
    }
    if (!proxy) {
      // Falling back means the provider's own credential goes into the
      // container. That is a downgrade of the boundary and has to be audible,
      // not a silent difference between two runs that look identical.
      onProgress?.({
        phase: "starting",
        message: `Credential proxy unavailable for ${sandbox.provider}; mounting that provider's credential instead.`
      });
    }
    return proxy;
  } catch (error) {
    onProgress?.({
      phase: "starting",
      message: `Credential proxy could not start (${error instanceof Error ? error.message : String(error)}); falling back to mounting credentials.`
    });
    return null;
  }
}

/**
 * Recovery after an answer cut off at the output ceiling.
 *
 * The failure is not rare and not cosmetic: a model that slips into repeating
 * itself generates until the ceiling, the truncated answer loses its tool call,
 * and if that was the last turn the run exits zero with the work half done.
 * Everything needed to carry on is still there — the session holds the whole
 * context — so the run continues itself rather than waiting for someone to
 * notice and type the continuation by hand.
 *
 * Bounded on purpose: a model stuck in a loop hits the ceiling every time, and
 * each attempt costs a full ceiling of tokens. After the last attempt the run
 * returns as truncated, which is what the phase and the ⚠️ are for.
 *
 * How many in a row are worth continuing through is generous on purpose: one
 * attempt costs a ceiling of tokens and a few seconds, while the alternative is
 * a run that ends mid-work and has to be picked up by hand. The counter resets
 * on every answer the agent completes, so this is the allowance for being stuck
 * right now — not a budget for the whole run.
 */
const DEFAULT_TRUNCATION_RETRIES = 10;

/**
 * Ход, ушедший ЦЕЛИКОМ в размышление: столько-то знаков рассуждения и ни одного
 * знака ответа. Порог отделяет обычное размышление от вырождения — на живых
 * прогонах медиана рассуждения на ход равна нулю, у чистых прогонов оно почти
 * никогда не доходит до этой величины, а у сорвавшихся такие ходы идут через один.
 */
export const THINKING_BLOAT_CHARS = 6000;
/**
 * Окно и порог: сколько таких ходов из последних N считать кругом, а не задумчивостью.
 *
 * Числа выбраны, а не выведены: распределения рассуждения по ОТДЕЛЬНЫМ ходам у нас
 * не замерено (в исследовании есть только средние по ходу), поэтому 6000/10/3 —
 * консервативная догадка, а не порог из данных. Менять их стоит по замеру, а не по
 * впечатлению; выключается всё целиком через PI_LOOP_NUDGE=0.
 */
export const THINKING_BLOAT_WINDOW = 10;
export const THINKING_BLOAT_HITS = 3;
/** Больше двух вмешательств за прогон — это уже разговор, а не подсказка. */
export const MAX_LOOP_NUDGES = 2;

/**
 * Что сказать агенту, который ходит по кругу в собственном рассуждении.
 *
 * Простое «ты зациклился, попробуй иначе» на этом классе не работает: сообщение
 * ничего не добавляет к тому, что модель уже знает, и она возвращается к тому же
 * рассуждению следующим ходом. Отсюда и строгий детектор, и текст, который несёт
 * не совет, а выход: цена ложного вмешательства выше цены пропуска — прерванный
 * агент теряет ход и нить, а незамеченный круг стоит нескольких ходов, которые
 * и так были бы потрачены впустую. Замера, который сравнил бы вмешательство с
 * бездействием на этом классе, у нас НЕТ (docs/RESEARCH-truncation-flash-vs-glm.md
 * меряет другое — обрывы на потолке вывода); это соображение, а не результат.
 *
 * Выход в том, что у исполнителя он уже есть по инструкции: упёрся — верни
 * блокер. Круг в рассуждении означает, что нужного факта в контексте нет, и
 * добыть его размышлением нельзя. Поэтому сообщение закрывает третью дверь —
 * «подумать ещё раз» — и оставляет ровно две.
 */
export const LOOP_NUDGE_PROMPT =
  "Стоп. Несколько ходов подряд ты тратишь ход целиком на размышление и не делаешь ничего: " +
  "возвращаешься к одному и тому же вопросу и перебираешь те же варианты. " +
  "Если бы ответ был в контексте, ты бы его уже нашёл — значит нужного факта там нет, " +
  "и размышлением он не появится.\n\n" +
  "Сделай одно из двух, третьего не предлагается:\n" +
  "1) ПРИМИ РЕШЕНИЕ из вариантов, которые уже рассмотрел. Запиши его как допущение: " +
  "что выбрал, почему и что осталось непроверенным.\n" +
  "2) ВЕРНИ БЛОКЕР: какой конкретно факт неизвестен, где он живёт и что нужно сделать, " +
  "чтобы его узнать.\n\n" +
  "Не начинай задачу заново, не перепроверяй проверенное и не объясняй, почему это трудно.";

/** Сколько хвоста оборванного ответа вернуть модели, чтобы ей было что продолжать. */
export const CONTINUATION_TAIL_CHARS = 800;

/**
 * Промпт продолжения после обрыва на потолке вывода.
 *
 * Обрезанный ответ НЕ остаётся в истории сессии: сообщение с недописанными
 * вызовами инструментов невалидно для API, поэтому движок его отбрасывает
 * целиком. Просить «продолжи ровно с места обрыва» после этого — просить
 * продолжить то, чего в контексте модели больше нет: она начинает ход заново,
 * упирается в тот же потолок на том же контексте, и это повторяется, пока не
 * кончится лимит. В журнале это видно как серия обрывов подряд, у которых вход
 * растёт ровно на длину самого промпта продолжения.
 *
 * Поэтому хвост оборванного текста возвращается модели явно. Текста нет вовсе
 * (весь ход ушёл в вызовы инструментов) — продолжать нечего, и честная просьба
 * другая: повторить шаг меньшими порциями, а не «продолжить».
 */
export function continuationPrompt(tail = "") {
  const text = typeof tail === "string" ? tail.trimEnd() : "";
  if (!text) {
    return (
      "Твой предыдущий ход был обрезан на потолке вывода и НЕ СОХРАНЁН: ни его текст, " +
      "ни вызовы инструментов из него не дошли — в контексте сессии его нет, продолжать нечего. " +
      "Повтори этот шаг заново, но меньшими порциями: один вызов инструмента за ход, " +
      "большой файл — по частям. Не пересказывай работу, сделанную до этого хода: она цела."
    );
  }
  const piece = text.length > CONTINUATION_TAIL_CHARS ? text.slice(-CONTINUATION_TAIL_CHARS) : text;
  return (
    "Твой предыдущий ответ был обрезан на потолке вывода, и в истории сессии его нет — " +
    "поэтому вот его концовка дословно:\n\n---\n" + piece + "\n---\n\n" +
    "Продолжи ровно с этого места, НЕ повторяя приведённый кусок и не начиная задачу заново. " +
    "Если там был вызов инструмента — он не выполнен, повтори его. " +
    "Пиши короче: ответ, который снова упрётся в потолок, снова пропадёт целиком."
  );
}

/** Прежняя форма — для случая, когда хвост недоступен. */
export const CONTINUATION_PROMPT = continuationPrompt("");


/**
 * What to do when the agent has settled: continue it, or let the run end.
 *
 * "reset" — the answer completed, so earlier truncations no longer predict
 * anything and the next one gets the full allowance again.
 * "recover" — the last answer was cut off and there is allowance left.
 * "stop" — nothing to recover, or the allowance is gone.
 *
 * The allowance counts CONSECUTIVE truncations only. A run lives for hours and
 * hundreds of turns; a truncation it recovered from an hour ago says nothing
 * about whether it is stuck now, and a counter that never reset would leave the
 * rest of the run undefended. There is deliberately no second cap for the run
 * as a whole: a run is bounded by its timeout and its budget, and another limit
 * on top of those would only obscure which one actually stopped the work.
 */
export function recoveryDecision({ stopReason, consecutive = 0, consecutiveLimit = 0, blocked = false } = {}) {
  if (!isTruncationReason(stopReason)) {
    return "reset";
  }
  if (blocked || consecutive >= consecutiveLimit) {
    return "stop";
  }
  return "recover";
}

export function truncationRetryLimit(env) {
  const raw = env?.PI_TRUNCATION_RETRIES;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_TRUNCATION_RETRIES;
  }
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TRUNCATION_RETRIES;
}

/**
 * Did the LAST answer of this run hit the ceiling? Mid-run truncation is not this.
 *
 * The agent's own report of why its last message ended is the primary signal,
 * because it exists in every run. The proxy's tally is the fallback and only
 * that: it exists solely when the run went through the credential proxy — that
 * is, only in a sandbox — and it names the last REQUEST of the job, which is not
 * always the agent's last answer (context compaction runs through the same
 * proxy and legitimately ends at its own ceiling).
 */
export function finishReasonOf(result) {
  return result?.stopReason ?? result?.proxyStats?.lastFinishReason ?? null;
}

export function wasTruncated(result) {
  return isTruncationReason(finishReasonOf(result));
}

/**
 * One run out of the original and its continuation.
 *
 * Counters are summed rather than replaced: the journal answers "what did this
 * job cost", and a recovery pass costs real tokens and real turns. The text and
 * the session come from the last pass, since that is where the work ended up.
 */
/**
 * Durations of both passes as durations of one job.
 *
 * The fields are named rather than summed by "every number I find": the shape
 * comes from `summarizeTiming`, where all three happen to be durations today,
 * and the day a timestamp or a percentile joins it, blind summing would put
 * quiet nonsense in the journal instead of failing.
 */
function mergeTiming(first, next) {
  if (!first || typeof first !== "object") return next;
  if (!next || typeof next !== "object") return first;
  const sum = (left, right) => (Number(left) || 0) + (Number(right) || 0);
  return {
    ...next,
    spanMs: sum(first.spanMs, next.spanMs),
    modelMs: sum(first.modelMs, next.modelMs),
    toolMs: sum(first.toolMs, next.toolMs)
  };
}

/** Two usage tallies as one. Numbers add up; anything else is taken from the later one. */
export function sumUsage(first, next) {
  const merged = { ...(first ?? {}) };
  for (const [key, value] of Object.entries(next ?? {})) {
    merged[key] = typeof value === "number" ? (Number(merged[key]) || 0) + value : value;
  }
  return merged;
}

/**
 * The answer of a run that had to be continued.
 *
 * A run reports its LAST message as the answer (`state.assistantTexts.at(-1)`),
 * which is right until the last message is a continuation: the half written
 * before the ceiling cut in is then dropped. For a run whose deliverable is the
 * text itself — a read-only explorer, a review — that dropped half is the work.
 * So the halves are joined, and the seam is marked: the first one ends
 * mid-sentence and a reader has to see why.
 */
export function joinRecoveredText(first, next) {
  if (!next) {
    return first ?? "";
  }
  if (!first) {
    return next;
  }
  return `${first}\n\n[продолжение после обрыва на потолке вывода]\n\n${next}`;
}

export function mergeRecoveredRun(first, next) {
  const sum = (left, right) => (Number(left) || 0) + (Number(right) || 0);
  return {
    ...next,
    text: joinRecoveredText(first.text, next.text),
    usage: sumUsage(first.usage, next.usage),
    turns: sum(first.turns, next.turns),
    toolCalls: Array.isArray(first.toolCalls) && Array.isArray(next.toolCalls)
      ? [...first.toolCalls, ...next.toolCalls]
      : sum(first.toolCalls, next.toolCalls),
    toolErrors: sum(first.toolErrors, next.toolErrors),
    errors: [...(first.errors ?? []), ...(next.errors ?? [])],
    // Timings and peaks describe the whole job, not its last leg.
    timing: mergeTiming(first.timing, next.timing),
    peakContext: Math.max(Number(first.peakContext) || 0, Number(next.peakContext) || 0),
    thinkingChars: sum(first.thinkingChars, next.thinkingChars),
    agentWork: mergeAgentWork(first.agentWork, next.agentWork),
    slotWaitMs: sum(first.slotWaitMs, next.slotWaitMs),
    recoveredTruncations: (Number(first.recoveredTruncations) || 0) + 1,
    proxyStats: next.proxyStats ?? first.proxyStats
  };
}

export async function runPiTurn({
  cwd,
  prompt,
  timeoutMs = 1_800_000,
  onProgress = null,
  onSpawn = null,
  env = process.env,
  sandbox = null,
  jobId = null,
  budget = null,
  ...options
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("Refusing to start pi with an empty prompt.");
  }
  const truncationRetries = truncationRetryLimit(env);

  // A profile may cap how many of its containers run at once, because the
  // provider behind it caps sessions. Queue here, before the container is
  // started, so the wait costs time instead of a failed run.
  // Credentials stay on the host: the container gets a token for a proxy that
  // lives exactly as long as this run. Falls back to the previous behaviour for
  // providers whose endpoint cannot be resolved.
  const proxy = await openCredentialProxy(sandbox, onProgress, options.model ?? null, jobId);
  if (proxy) {
    sandbox = {
      ...sandbox,
      credentialProxy: { url: proxy.url, token: proxy.token, providerEntry: proxy.providerEntry }
    };
    // pi is told to use the masked names; the proxy maps them back. Reported
    // usage still names the real model, which is what the journal records.
    options = { ...options, provider: MASKED_PROVIDER, model: MASKED_MODEL };
  }
  // Same bargain for forge credentials: the container is handed a run token and
  // a loopback URL, and the token that can read the repositories never leaves
  // this process.
  const gitProxy = await openGitProxy(sandbox, onProgress);
  sandbox = withGitProxy(sandbox, gitProxy);
  // Both proxies bind loopback, and the hop that carries the container's
  // connections there needs a moment to notice them. Waited out once, before the
  // container exists, rather than paid for by whichever request goes first.
  // Registered the moment both exist, because everything between here and the
  // end of the run can throw: a queue that gives up waiting for a slot, a
  // container that fails to spawn, a budget that stops the turn. Any of those
  // used to leave the listener alive with a live forge token behind it.
  const closeProxies = async () => {
    // Read before close, reported to the run header: a push the agent tried is
    // otherwise invisible — it fails inside the container and the host only sees
    // a 403 count that goes nowhere. Same for a run token someone else probed.
    const git = gitProxy?.stats?.();
    if (git && (git.blocked || git.rejected)) {
      const parts = [];
      if (git.blocked) parts.push(`${git.blocked} push/dumb-http request(s) refused`);
      if (git.rejected) parts.push(`${git.rejected} request(s) with a wrong run token`);
      onProgress?.({ phase: "working", message: `Git proxy blocked ${parts.join(", ")}.` });
    }
    await proxy?.close();
    await gitProxy?.close();
  };
  await settleProxyPorts(proxy, gitProxy);
  const piArgs = buildPiArgs(options);
  // The body runs inside a closure so the proxies are closed on every exit
  // from here on, not only the one that reaches the end: a slot wait that
  // gives up, a container that fails to spawn and a thrown budget stop all
  // used to leave a listener alive with a live forge token behind it.
  const runTurn = async ({
    resumeSession = null,
    resumePrompt = null,
    // What is left of the run's own deadline, not a fresh one. A continuation
    // finishes the work the first pass started, so it spends that work's time:
    // a per-pass timeout would multiply the run's stated ceiling by the number
    // of retries, and a three-hour preset would quietly become a day and a half.
    turnTimeoutMs = timeoutMs,
    // What earlier passes already spent. The budget bounds the JOB, so a pass
    // that starts with the allowance already gone must not get a fresh one.
    budgetBase = null
  } = {}) => {
    const slot = await awaitSandboxSlot(sandbox, { timeoutMs: turnTimeoutMs, onProgress });
    // A recovery pass reuses everything about the run except where it starts:
    // the session carries the whole context, so the continuation only has to say
    // where to pick up.
    const turnArgs = resumeSession ? buildPiArgs({ ...options, sessionId: resumeSession }) : piArgs;
    const turnPrompt = resumePrompt ?? prompt;
    const launch = resolveLaunch({ sandbox, binary: PI_BINARY, piArgs: turnArgs, cwd, jobId, env });
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
    // `spawn` returns before the docker client has even exec'd, so releasing here
    // would restore the very race the reservation exists for. The reservation
    // expires on its own; releasing it early is only an optimisation, and it can
    // wait until the container is actually visible.
    const releaseSlotWhenVisible = () => {
      if (!launch.containerName) {
        slot.release?.();
        return;
      }
      const deadline = Date.now() + 15_000;
      const poll = setInterval(() => {
        const visible = runCommand("docker", ["ps", "--filter", `name=${launch.containerName}`, "--format", "{{.Names}}"]);
        if (Date.now() >= deadline || String(visible.stdout ?? "").includes(launch.containerName)) {
          clearInterval(poll);
          slot.release?.();
        }
      }, 500);
      poll.unref?.();
    };
    releaseSlotWhenVisible();

    let stderr = "";
    let stdoutRest = "";
    let timedOut = false;
    let budgetStop = null;

    /**
     * Stop a run that has crossed one of its ceilings.
     *
     * The one-shot mode has no control channel, so unlike the rpc engine there is
     * no way to ask pi to wrap up: the only lever is the one the timeout already
     * uses. Whatever the agent has written to the workspace stays; the assistant
     * text of the message in flight is lost.
     */
    const enforceBudget = () => {
      if (budgetStop) {
        return;
      }
      const exceeded = budgetExceeded(budget, {
        usage: budgetBase ? sumUsage(budgetBase.usage, state.usage) : state.usage,
        turns: (budgetBase?.turns ?? 0) + state.turns
      });
      if (!exceeded) {
        return;
      }
      budgetStop = exceeded;
      report({ phase: "working", message: `Budget reached: ${exceeded}. Stopping pi.` });
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      if (isSandboxed(sandbox)) {
        removeSandboxContainer(launch.containerName);
      }
    };

    const timer =
      turnTimeoutMs > 0
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
          }, turnTimeoutMs)
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
            enforceBudget();
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

    // pi may exit before reading the prompt (unknown model, bad flag, docker
    // failing on its arguments). The write then fails asynchronously with EPIPE,
    // and without this handler that is an unhandled 'error' event that kills the
    // process before the job can be recorded as failed.
    child.stdin.on("error", () => {});
    child.stdin.end(String(turnPrompt));

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
      errors.push(
        `pi exceeded the ${Math.round(turnTimeoutMs / 1000)}s timeout and was terminated. ` +
          "That limit comes from --timeout, the preset's `timeoutMs`, or `defaults.timeoutMs` " +
          "in the config, in that order. The session is intact: continue it instead of re-running the task."
      );
    }
    if (budgetStop) {
      errors.push(`Stopped by the run budget: ${budgetStop}.`);
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
      stopReason: state.stopReason,
      // The agent was told a masked name, so its reported model is that mask.
      // Statistics are about what actually answered, and only the host knows it.
      model: proxy?.realModel ? `${proxyProviderOf(sandbox)}/${proxy.realModel}` : state.model,
      turns: state.turns,
      toolCalls: state.toolCalls,
      toolErrors: state.toolErrors,
      timing: summarizeTiming(state.timing),
      peakContext: state.peakContext ?? 0,
      thinkingChars: state.thinkingChars ?? 0,
      // How much code the run moved through its own tools.
      agentWork: summarizeAgentWork(state.agentWork),
      // Already measured by the slot queue and thrown away until now: the time
      // this run spent waiting for a container of its own pool, which is time no
      // model spent working.
      slotWaitMs: slot.waitedMs ?? 0,
      // Per-request telemetry the proxy collected, rolled up for the job row.
      proxyStats: proxy?.stats?.() ?? null,
      budgetStop,
      exitStatus: errors.length && exitStatus === 0 ? 1 : exitStatus,
      stderr: stderr.trim(),
      errors,
      timedOut,
      containerName: launch.containerName,
      command: `${launch.command} ${redactArgs(launch.args)}`
    };
  };

  // One deadline for the job, fixed before the first pass. `remainingMs` is
  // what a continuation is allowed to spend, and a run that has already used up
  // its time does not get another pass at all.
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
  const remainingMs = () => (deadline === null ? 0 : deadline - Date.now());

  try {
    let result = await runTurn({ turnTimeoutMs: timeoutMs });
    let recovered = 0;
    for (;;) {
      const decision = recoveryDecision({
        stopReason: finishReasonOf(result),
        consecutive: recovered,
        consecutiveLimit: truncationRetries,
        // Everything that means "do not start another pass": the previous one
        // was stopped rather than finished, there is nothing to resume from, or
        // the run has no time left to spend. Without this a run killed by its
        // budget would answer the ceiling with another full-priced pass.
        blocked:
          Boolean(result.budgetStop) ||
          Boolean(result.timedOut) ||
          !result.sessionId ||
          (deadline !== null && remainingMs() <= 0)
      });
      if (decision !== "recover") {
        break;
      }
      recovered += 1;
      onProgress?.({
        phase: "working",
        message: `Ответ обрезан на потолке вывода — работа не доведена. Продолжаю сессию (попытка ${recovered} из ${truncationRetries}).`
      });
      const next = await runTurn({
        resumeSession: result.sessionId,
        // Тот же довод, что в rpc: без хвоста оборванного ответа продолжать нечего.
        resumePrompt: continuationPrompt(result.text ?? ""),
        turnTimeoutMs: deadline === null ? 0 : remainingMs(),
        budgetBase: { usage: result.usage, turns: result.turns }
      });
      result = mergeRecoveredRun(result, next);
    }
    return result;
  } finally {
    await closeProxies();
  }
}
