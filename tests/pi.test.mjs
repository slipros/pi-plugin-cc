import assert from "node:assert/strict";
import test from "node:test";

import {
  READ_ONLY_TOOLS,
  applyPiEvent,
  buildPiArgs,
  createTurnState,
  mergeRecoveredRun,
  recoveryDecision,
  truncationRetryLimit,
  wasTruncated
} from "../plugins/pi/scripts/lib/pi.mjs";

test("a bare run only asks for non-interactive json output", () => {
  assert.deepEqual(buildPiArgs(), ["--print", "--mode", "json"]);
});

test("model, provider and thinking map onto pi flags", () => {
  const args = buildPiArgs({ model: "opencode-go/glm-5.2", provider: "opencode-go", thinking: "high" });
  assert.deepEqual(args, [
    "--print",
    "--mode",
    "json",
    "--provider",
    "opencode-go",
    "--model",
    "opencode-go/glm-5.2",
    "--thinking",
    "high"
  ]);
});

test("system prompt and appends are passed separately", () => {
  const args = buildPiArgs({ systemPrompt: "base", appends: ["extra one", "extra two"] });
  assert.deepEqual(args.slice(3), [
    "--system-prompt",
    "base",
    "--append-system-prompt",
    "extra one",
    "--append-system-prompt",
    "extra two"
  ]);
});

test("read-only runs restrict pi to the safe tool set", () => {
  const args = buildPiArgs({ readOnly: true });
  assert.deepEqual(args.slice(3), ["--tools", READ_ONLY_TOOLS.join(",")]);
});

test("the read-only set navigates with LSP but cannot mutate or diagnose", () => {
  for (const tool of ["lsp_definition", "lsp_references", "lsp_more"]) {
    assert.ok(READ_ONLY_TOOLS.includes(tool), `${tool} belongs to a look-but-do-not-touch run`);
  }
  for (const tool of ["bash", "edit", "write"]) {
    assert.ok(!READ_ONLY_TOOLS.includes(tool), `${tool} would let a read-only run change the tree`);
  }
  assert.ok(
    !READ_ONLY_TOOLS.includes("lsp_diagnostics"),
    "gates decide whether code is broken, not the language server"
  );
});

test("an explicit tool list overrides the read-only default", () => {
  const args = buildPiArgs({ readOnly: true, tools: ["read", "bash"] });
  assert.deepEqual(args.slice(3), ["--tools", "read,bash"]);
});

test("rpc mode swaps the one-shot flags for a live channel", () => {
  assert.deepEqual(buildPiArgs({ mode: "rpc" }), ["--mode", "rpc"]);
  assert.deepEqual(buildPiArgs({ mode: "rpc", model: "glm-5.2" }), ["--mode", "rpc", "--model", "glm-5.2"]);
});

test("extensions and skills are passed through, repeatably", () => {
  const args = buildPiArgs({
    extensions: ["npm:pi-mcp-adapter", "./local-ext.ts"],
    skills: ["./skills/db"],
    noExtensions: true
  });
  assert.deepEqual(args.slice(3), [
    "--no-extensions",
    "--extension",
    "npm:pi-mcp-adapter",
    "--extension",
    "./local-ext.ts",
    "--skill",
    "./skills/db"
  ]);
});

test("--no-tools overrides every other tool flag", () => {
  const args = buildPiArgs({ noTools: true, readOnly: true, tools: "read", excludeTools: "bash" });
  assert.deepEqual(args.slice(3), ["--no-tools"]);
});

test("--no-builtin-tools keeps extension tools alongside an allowlist", () => {
  const args = buildPiArgs({ noBuiltinTools: true, tools: "mcp" });
  assert.deepEqual(args.slice(3), ["--no-builtin-tools", "--tools", "mcp"]);
});

test("a session id resumes, and --no-session wins over it", () => {
  assert.deepEqual(buildPiArgs({ sessionId: "abc" }).slice(3), ["--session", "abc"]);
  assert.deepEqual(buildPiArgs({ sessionId: "abc", noSession: true }).slice(3), ["--no-session"]);
});

function drain(events) {
  const state = createTurnState();
  const progress = [];
  for (const event of events) {
    const update = applyPiEvent(state, event);
    if (update) {
      progress.push(update);
    }
  }
  return { state, progress };
}

test("the event stream yields the session id, tool calls and the final answer", () => {
  const { state, progress } = drain([
    { type: "session", id: "session-1", cwd: "/repo" },
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } },
    { type: "tool_execution_end", toolName: "read", isError: false },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final answer" }],
        provider: "opencode-go",
        model: "glm-5.2",
        stopReason: "stop",
        usage: { input: 100, output: 20, cost: { total: 0.5 } }
      }
    },
    { type: "agent_end", messages: [] }
  ]);

  assert.equal(state.sessionId, "session-1");
  assert.deepEqual(state.toolCalls, ["read: src/index.ts"]);
  assert.deepEqual(state.assistantTexts, ["final answer"]);
  assert.equal(state.model, "opencode-go/glm-5.2");
  assert.equal(state.stopReason, "stop");
  assert.deepEqual(progress.at(-1), { phase: "finishing", message: "pi finished a run." });
});

test("only agent_settled ends the job — agent_end may be followed by a retry", () => {
  const afterEnd = drain([{ type: "agent_end", willRetry: true }]);
  assert.equal(afterEnd.state.settled, false);
  assert.deepEqual(afterEnd.progress, [{ phase: "finishing", message: "pi will retry." }]);

  const afterSettle = drain([{ type: "agent_end", willRetry: false }, { type: "agent_settled" }]);
  assert.equal(afterSettle.state.settled, true);
});

test("queue updates are tracked and reported only when non-empty", () => {
  const { state, progress } = drain([
    { type: "queue_update", steering: ["focus on auth"], followUp: [] },
    { type: "queue_update", steering: [], followUp: [] }
  ]);
  assert.deepEqual(state.queue, { steering: [], followUp: [] }, "the last update wins");
  assert.deepEqual(progress, [{ phase: "working", message: "Queued: 1 steering, 0 follow-up." }]);
});

test("usage accumulates across assistant messages", () => {
  const { state } = drain([
    {
      type: "message_end",
      message: { role: "assistant", content: [], usage: { input: 10, output: 1, cost: { total: 0.1 } } }
    },
    {
      type: "message_end",
      message: { role: "assistant", content: [], usage: { input: 5, output: 2, cost: { total: 0.2 } } }
    }
  ]);
  assert.equal(state.usage.input, 15);
  assert.equal(state.usage.output, 3);
  assert.ok(Math.abs(state.usage.cost - 0.3) < 1e-9);
});

test("user messages never overwrite the assistant answer", () => {
  const { state } = drain([
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "the prompt" }] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "the answer" }] } }
  ]);
  assert.deepEqual(state.assistantTexts, ["the answer"]);
});

test("tool errors and stream errors are recorded", () => {
  const { state } = drain([
    { type: "tool_execution_end", toolName: "bash", isError: true },
    { type: "error", message: "provider rejected the request" }
  ]);
  assert.equal(state.toolErrors, 1);
  assert.deepEqual(state.errors, ["provider rejected the request"]);
});

test("unknown or malformed events are ignored", () => {
  const { state, progress } = drain([{ type: "something_new" }, null, "not an object"]);
  assert.deepEqual(progress, []);
  assert.equal(state.settled, false);
});

test("an empty tool list means no restriction, not an empty flag value", () => {
  const args = buildPiArgs({ tools: [], excludeTools: [] });
  assert.deepEqual(args, ["--print", "--mode", "json"]);
});

test("excluded tools are passed as one comma separated list", () => {
  const args = buildPiArgs({ excludeTools: ["ask_question", "bash"] });
  assert.deepEqual(args.slice(3), ["--exclude-tools", "ask_question,bash"]);
});

test("timings split a run into model time and tool time, counting overlaps once", async () => {
  const { applyPiEvent, createTurnState, summarizeTiming } = await import("../plugins/pi/scripts/lib/pi.mjs");
  const state = createTurnState();
  const at = (ms, event) => applyPiEvent(state, event, ms);

  at(1000, { type: "agent_start" });
  // Two tools running at once: the run waits 3s for them, not 5s.
  at(2000, { type: "tool_execution_start", toolCallId: "a", toolName: "lsp_references" });
  at(2500, { type: "tool_execution_start", toolCallId: "b", toolName: "lsp_definition" });
  at(4500, { type: "tool_execution_end", toolCallId: "b" });
  at(5000, { type: "tool_execution_end", toolCallId: "a" });
  at(6000, { type: "agent_settled" });

  const timing = summarizeTiming(state.timing);
  assert.equal(timing.spanMs, 5000);
  assert.equal(timing.toolMs, 3000, "2000-5000 covered once, not 3000+2000");
  assert.equal(timing.modelMs, 2000, "the rest of the span is waiting on the model");
});

test("a tool left open when the run ends does not swallow the run", async () => {
  const { applyPiEvent, createTurnState, summarizeTiming } = await import("../plugins/pi/scripts/lib/pi.mjs");
  const state = createTurnState();
  applyPiEvent(state, { type: "agent_start" }, 0);
  applyPiEvent(state, { type: "tool_execution_start", toolCallId: "x", toolName: "bash" }, 1000);
  applyPiEvent(state, { type: "agent_settled" }, 9000);

  const timing = summarizeTiming(state.timing);
  assert.equal(timing.toolMs, 0);
  assert.equal(timing.modelMs, 9000);
});

// A run whose last answer hit the output ceiling has not finished: the truncated
// answer lost its tool call, and the work stopped mid-sentence. The run
// continues itself from the session rather than waiting to be noticed.
test("only a truncation on the LAST answer asks for a continuation", () => {
  assert.equal(wasTruncated({ proxyStats: { lastFinishReason: "length" } }), true);
  // Cut off earlier in the run: cost tokens and a retry, then finished normally.
  assert.equal(wasTruncated({ proxyStats: { lastFinishReason: "tool_calls", truncated: 2 } }), false);
  assert.equal(wasTruncated({ proxyStats: { lastFinishReason: "stop" } }), false);
  assert.equal(wasTruncated({ proxyStats: null }), false, "no telemetry is not a truncation");
  assert.equal(wasTruncated({}), false);
});

test("the retry limit is bounded, and a bad value does not disable it silently", () => {
  assert.equal(truncationRetryLimit({}), 10, "default");
  assert.equal(truncationRetryLimit({ PI_TRUNCATION_RETRIES: "0" }), 0, "off is a valid choice");
  assert.equal(truncationRetryLimit({ PI_TRUNCATION_RETRIES: "5" }), 5);
  assert.equal(truncationRetryLimit({ PI_TRUNCATION_RETRIES: "nonsense" }), 10, "garbage falls back, not to zero");
  assert.equal(truncationRetryLimit({ PI_TRUNCATION_RETRIES: "-3" }), 10, "negative is not 'never'");
});

test("a recovered run is journalled as one job, not as the last leg alone", () => {
  const first = {
    text: "", sessionId: "s1", usage: { input: 100, output: 16384 }, turns: 13,
    toolCalls: ["read"], toolErrors: 700, peakContext: 170_000, thinkingChars: 10,
    slotWaitMs: 5, timing: { generationMs: 1000, toolMs: 50 }, errors: ["cut off"],
    proxyStats: { lastFinishReason: "length" }
  };
  const next = {
    text: "СТАТУС\ncommit: abc1234", sessionId: "s1", usage: { input: 40, output: 900 }, turns: 4,
    toolCalls: ["edit"], toolErrors: 0, peakContext: 180_000, thinkingChars: 3,
    slotWaitMs: 2, timing: { generationMs: 300, toolMs: 20 }, errors: [],
    proxyStats: { lastFinishReason: "stop" }
  };
  const merged = mergeRecoveredRun(first, next);

  assert.equal(merged.text, "СТАТУС\ncommit: abc1234", "the answer is where the work ended up");
  assert.deepEqual(merged.usage, { input: 140, output: 17284 }, "a recovery pass costs real tokens");
  assert.equal(merged.turns, 17);
  assert.deepEqual(merged.toolCalls, ["read", "edit"]);
  assert.equal(merged.toolErrors, 700);
  assert.equal(merged.peakContext, 180_000, "peaks are maxima, not sums");
  assert.deepEqual(merged.timing, { generationMs: 1300, toolMs: 70 });
  assert.equal(merged.slotWaitMs, 7);
  assert.deepEqual(merged.errors, ["cut off"], "the reason it had to recover is not lost");
  assert.equal(merged.recoveredTruncations, 1);
  assert.equal(merged.proxyStats.lastFinishReason, "stop", "the verdict is about the final answer");

  // Two recoveries in a row keep counting.
  assert.equal(mergeRecoveredRun(merged, next).recoveredTruncations, 2);
});

// The allowance is on CONSECUTIVE truncations, not on the run as a whole: a run
// works for hours, and an early truncation that the agent recovered from says
// nothing about whether it is stuck now.

// The allowance is on CONSECUTIVE truncations, not on the run as a whole: a run
// works for hours, and a truncation it recovered from an hour ago says nothing
// about whether it is stuck now.
test("a completed answer restores the full allowance", () => {
  assert.equal(recoveryDecision({ stopReason: "stop", consecutive: 9, consecutiveLimit: 10 }), "reset");
  assert.equal(recoveryDecision({ stopReason: "tool_calls", consecutive: 3, consecutiveLimit: 10 }), "reset");
});

test("consecutive truncations are continued until the allowance runs out", () => {
  assert.equal(recoveryDecision({ stopReason: "length", consecutive: 0, consecutiveLimit: 10 }), "recover");
  assert.equal(recoveryDecision({ stopReason: "length", consecutive: 9, consecutiveLimit: 10 }), "recover");
  assert.equal(recoveryDecision({ stopReason: "length", consecutive: 10, consecutiveLimit: 10 }), "stop",
    "ten in a row means stuck, not unlucky");
});

test("nothing else caps recoveries — the run's timeout and budget do", () => {
  // A model that breaks every other turn keeps its allowance refreshed by the
  // good answers in between, and that is intentional: it is making progress,
  // and it pays for the breakage out of the same budget as everything else.
  assert.equal(recoveryDecision({ stopReason: "length", consecutive: 0, consecutiveLimit: 10 }), "recover");
});

test("a run already ending is never continued", () => {
  assert.equal(
    recoveryDecision({ stopReason: "length", consecutive: 0, consecutiveLimit: 10, blocked: true }),
    "stop",
    "cancelled, over budget or shutting down"
  );
});

test("turning recovery off leaves nothing to continue", () => {
  assert.equal(recoveryDecision({ stopReason: "length", consecutive: 0, consecutiveLimit: 0 }), "stop");
});
