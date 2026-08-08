/**
 * Human-readable rendering of pi's event stream.
 *
 * The raw events land in <job>.events.jsonl while a job runs; this turns them
 * into the kind of transcript you would see if you were sitting in front of the
 * pi TUI — tool calls, their outcome, reasoning and the answer as it arrives.
 */

const MAX_ARG_LENGTH = 120;
const MAX_RESULT_LENGTH = 200;

function clip(value, limit) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function describeArgs(toolName, args) {
  if (!args || typeof args !== "object") {
    return "";
  }
  const primary =
    args.command ?? args.path ?? args.file ?? args.filePath ?? args.pattern ?? args.query ?? null;
  if (primary != null) {
    return clip(primary, MAX_ARG_LENGTH);
  }
  return clip(JSON.stringify(args), MAX_ARG_LENGTH);
}

function describeResult(result) {
  if (result == null) {
    return "";
  }
  if (typeof result === "string") {
    return clip(result, MAX_RESULT_LENGTH);
  }
  if (Array.isArray(result?.content)) {
    const text = result.content
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join(" ");
    return clip(text, MAX_RESULT_LENGTH);
  }
  if (typeof result?.output === "string") {
    return clip(result.output, MAX_RESULT_LENGTH);
  }
  return clip(JSON.stringify(result), MAX_RESULT_LENGTH);
}

function formatUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return "";
  }
  const cost = usage.cost?.total;
  const parts = [
    typeof usage.input === "number" ? `in ${usage.input}` : null,
    typeof usage.output === "number" ? `out ${usage.output}` : null,
    typeof cost === "number" ? `$${cost.toFixed(4)}` : null
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/**
 * Convert one event into transcript lines.
 *
 * `state` carries streaming text between calls so deltas can be folded into
 * whole paragraphs instead of one line per token.
 */
export function renderTranscriptEvent(event, state) {
  if (!event || typeof event !== "object") {
    return [];
  }

  switch (event.type) {
    case "agent_start":
      return ["▶ agent started"];

    case "turn_start":
      state.turn = (state.turn ?? 0) + 1;
      return [`── turn ${state.turn}`];

    case "message_update": {
      const update = event.assistantMessageEvent ?? {};
      if (update.type === "text_delta" || update.type === "thinking_delta") {
        state.streaming = update.type;
        return [];
      }
      if (update.type === "thinking_end" && update.content) {
        return [`  · thinking: ${clip(update.content, MAX_RESULT_LENGTH)}`];
      }
      return [];
    }

    case "tool_execution_start":
      state.tools ??= new Map();
      state.tools.set(event.toolCallId, event.toolName);
      return [`  ▸ ${event.toolName} ${describeArgs(event.toolName, event.args)}`.trimEnd()];

    case "tool_execution_end": {
      const name = state.tools?.get(event.toolCallId) ?? event.toolName ?? "tool";
      state.tools?.delete(event.toolCallId);
      const detail = describeResult(event.result);
      return [`    ${event.isError ? "✗" : "✓"} ${name}${detail ? `: ${detail}` : ""}`];
    }

    case "message_end": {
      const message = event.message ?? {};
      if (message.role !== "assistant") {
        return [];
      }
      const text = (Array.isArray(message.content) ? message.content : [])
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      if (!text) {
        return [];
      }
      return ["", ...text.split("\n").map((line) => `  ${line}`), `  ${formatUsage(message.usage)}`.trimEnd(), ""];
    }

    case "queue_update": {
      const steering = Array.isArray(event.steering) ? event.steering : [];
      const followUp = Array.isArray(event.followUp) ? event.followUp : [];
      if (!steering.length && !followUp.length) {
        return [];
      }
      return [
        ...steering.map((entry) => `  ⇢ steering queued: ${clip(entry, MAX_ARG_LENGTH)}`),
        ...followUp.map((entry) => `  ⇢ follow-up queued: ${clip(entry, MAX_ARG_LENGTH)}`)
      ];
    }

    case "compaction_start":
      return ["  · compacting context"];

    case "auto_retry_start":
      return [`  · retrying (${clip(event.reason ?? "", 80)})`];

    case "agent_end":
      return event.willRetry ? ["  · run ended, retry pending"] : [];

    case "agent_settled":
      return ["■ agent settled"];

    case "error":
      return [`  ✗ error: ${clip(event.message ?? event.error ?? "unknown", MAX_RESULT_LENGTH)}`];

    default:
      return [];
  }
}

export function renderTranscript(events) {
  const state = {};
  const lines = [];
  for (const event of events) {
    lines.push(...renderTranscriptEvent(event, state));
  }
  return lines;
}
