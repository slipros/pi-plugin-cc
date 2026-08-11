/**
 * Measure a streaming model response without collecting it.
 *
 * Counting, never accumulating: deltas are measured and dropped, so memory does
 * not grow with the length of an answer and no buffer of somebody's code is one
 * unlucky log line away from disk. Out of the stream come timings, sizes and
 * the provider's own `usage` object — the last of which is the point, since pi
 * carries forward six keys and discards whatever else arrived.
 *
 * Both wire formats are handled: OpenAI-style `data: {choices:[{delta}]}` and
 * Anthropic-style `event: content_block_delta`. Anything unrecognised still
 * gets byte counts and timings, which is what a non-streaming answer is left
 * with anyway.
 */

/** Below this a silence is transport noise, not a provider stalling. */
const MIN_REPORTABLE_GAP_MS = 1000;

function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Pull the usage object out of a frame, whatever the provider calls its fields.
 *
 * OpenAI reports `prompt_tokens`/`completion_tokens`, Anthropic
 * `input_tokens`/`output_tokens`, and cached prefixes are named three different
 * ways again. Normalised here so a query does not have to know which provider
 * answered.
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const details = usage.prompt_tokens_details ?? usage.input_tokens_details ?? {};
  const output = usage.completion_tokens_details ?? usage.output_tokens_details ?? {};
  return {
    in_tokens: asNumber(usage.prompt_tokens) ?? asNumber(usage.input_tokens),
    out_tokens: asNumber(usage.completion_tokens) ?? asNumber(usage.output_tokens),
    reasoning_tokens:
      asNumber(output.reasoning_tokens) ?? asNumber(usage.reasoning_tokens) ?? asNumber(usage.thinking_tokens),
    cached_tokens:
      asNumber(details.cached_tokens) ??
      asNumber(usage.cache_read_input_tokens) ??
      asNumber(usage.cached_tokens)
  };
}

/**
 * Keys this plugin already understands, at any nesting level. A usage object
 * with nothing else in it is fully described by the columns, so the raw blob is
 * not stored — which keeps the blob for exactly the case it exists for: a
 * provider reporting something nobody has mapped yet.
 */
const KNOWN_USAGE_KEYS = new Set([
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "thinking_tokens",
  "cached_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "prompt_tokens_details",
  "completion_tokens_details",
  "input_tokens_details",
  "output_tokens_details",
  "cache_read",
  "cache_write",
  "server_tool_use"
]);

export function hasUnknownUsageKeys(usage) {
  if (!usage || typeof usage !== "object") {
    return false;
  }
  return Object.keys(usage).some((key) => !KNOWN_USAGE_KEYS.has(key));
}

/**
 * A stateful meter fed the raw response bytes.
 *
 * @param {() => number} now injectable clock, so the tests are not timing races
 */
export function createStreamMeter({ now = Date.now } = {}) {
  const startedAt = now();
  let partial = "";
  let bytes = 0;
  let chunks = 0;
  let firstContentAt = null;
  let lastContentAt = null;
  let maxGap = 0;
  let usage = null;
  let finishReason = null;

  /** One SSE `data:` payload. */
  const readFrame = (text) => {
    if (!text || text === "[DONE]") {
      return;
    }
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame?.usage) {
      // Later frames win: a terminal usage frame is the complete one.
      usage = frame.usage;
    }
    if (frame?.message?.usage) {
      usage = { ...(usage ?? {}), ...frame.message.usage };
    }
    const reason =
      frame?.choices?.[0]?.finish_reason ?? frame?.delta?.stop_reason ?? frame?.message?.stop_reason ?? null;
    if (reason) {
      finishReason = String(reason);
    }

    const delta = frame?.choices?.[0]?.delta ?? frame?.delta ?? null;
    const isContent =
      Boolean(delta?.content) ||
      Boolean(delta?.text) ||
      Boolean(delta?.reasoning_content) ||
      Boolean(delta?.thinking) ||
      frame?.type === "content_block_delta";
    if (!isContent) {
      // A `role` frame or a keep-alive says the provider is polite, not that
      // the model has started: counting it as the first token would measure the
      // wire format instead of the prefill.
      return;
    }
    const at = now();
    if (firstContentAt === null) {
      firstContentAt = at;
    } else if (lastContentAt !== null) {
      maxGap = Math.max(maxGap, at - lastContentAt);
    }
    lastContentAt = at;
  };

  return {
    /** @param {Buffer} chunk bytes as they arrive from the provider */
    push(chunk) {
      bytes += chunk.length;
      chunks += 1;
      partial += chunk.toString("utf8");
      let boundary = partial.indexOf("\n");
      while (boundary !== -1) {
        const line = partial.slice(0, boundary).trim();
        partial = partial.slice(boundary + 1);
        if (line.startsWith("data:")) {
          readFrame(line.slice(5).trim());
        }
        boundary = partial.indexOf("\n");
      }
      // A frame split across two chunks is common; a partial line is held back
      // rather than parsed as broken JSON.
      if (partial.length > 1_000_000) {
        partial = "";
      }
    },

    /**
     * Whatever was not framed as SSE — a non-streaming JSON body. Read once at
     * the end, and only for its usage.
     */
    finishNonStream(body) {
      try {
        const parsed = JSON.parse(body);
        if (parsed?.usage) {
          usage = parsed.usage;
        }
        const reason = parsed?.choices?.[0]?.finish_reason ?? parsed?.stop_reason ?? null;
        if (reason) {
          finishReason = String(reason);
        }
      } catch {
        // Not JSON; the byte counts and timings still stand.
      }
    },

    summary() {
      const normalized = normalizeUsage(usage) ?? {};
      return {
        response_bytes: bytes,
        chunks,
        ttft_ms: firstContentAt === null ? null : firstContentAt - startedAt,
        // The generation window: first real token to last. This is the honest
        // denominator for a token rate — `model_ms` carries the queue and the
        // prefill with it.
        stream_ms: firstContentAt === null || lastContentAt === null ? null : lastContentAt - firstContentAt,
        max_gap_ms: maxGap >= MIN_REPORTABLE_GAP_MS ? maxGap : null,
        finish_reason: finishReason,
        ...normalized,
        // Kept only when the provider said something the columns cannot hold.
        usage_json: hasUnknownUsageKeys(usage) ? JSON.stringify(usage).slice(0, 4096) : null
      };
    }
  };
}
