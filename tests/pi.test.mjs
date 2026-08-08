import assert from "node:assert/strict";
import test from "node:test";

import { applyPiEvent, buildPiArgs, READ_ONLY_TOOLS } from "../plugins/pi/scripts/lib/pi.mjs";

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

test("a session id resumes, and --no-session wins over it", () => {
  assert.deepEqual(buildPiArgs({ sessionId: "abc" }).slice(3), ["--session", "abc"]);
  assert.deepEqual(buildPiArgs({ sessionId: "abc", noSession: true }).slice(3), ["--no-session"]);
});

function drain(events) {
  const state = {
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
  assert.equal(state.settled, true);
  assert.deepEqual(progress.at(-1), { phase: "finishing", message: "pi finished its work." });
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
