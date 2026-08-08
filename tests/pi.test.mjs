import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPiEvent,
  buildPiArgs,
  createTurnState,
  READ_ONLY_TOOLS
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
