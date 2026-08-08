import assert from "node:assert/strict";
import test from "node:test";

import { renderTranscript, renderTranscriptEvent } from "../plugins/pi/scripts/lib/transcript.mjs";

test("tool calls render with their target and outcome", () => {
  const lines = renderTranscript([
    { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "src/a.ts" } },
    { type: "tool_execution_end", toolCallId: "c1", result: "file contents here", isError: false }
  ]);
  assert.deepEqual(lines, ["  ▸ read src/a.ts", "    ✓ read: file contents here"]);
});

test("a failed tool call is marked as such", () => {
  const lines = renderTranscript([
    { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "npm test" } },
    { type: "tool_execution_end", toolCallId: "c1", result: "exit 1", isError: true }
  ]);
  assert.match(lines[1], /^ {4}✗ bash: exit 1$/);
});

test("turns are numbered as they arrive", () => {
  const state = {};
  assert.deepEqual(renderTranscriptEvent({ type: "turn_start" }, state), ["── turn 1"]);
  assert.deepEqual(renderTranscriptEvent({ type: "turn_start" }, state), ["── turn 2"]);
});

test("assistant text is indented and carries usage", () => {
  const lines = renderTranscript([
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "line one\nline two" }],
        usage: { input: 10, output: 2, cost: { total: 0.0123 } }
      }
    }
  ]);
  assert.deepEqual(lines, ["", "  line one", "  line two", "   (in 10, out 2, $0.0123)", ""]);
});

test("streaming deltas do not produce one line per token", () => {
  const state = {};
  const lines = [
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "he" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "llo" } }
  ].flatMap((event) => renderTranscriptEvent(event, state));
  assert.deepEqual(lines, []);
});

test("queued steering is visible in the transcript", () => {
  const lines = renderTranscript([
    { type: "queue_update", steering: ["focus on auth"], followUp: [] },
    { type: "queue_update", steering: [], followUp: [] }
  ]);
  assert.deepEqual(lines, ["  ⇢ steering queued: focus on auth"]);
});

test("user messages and unknown events stay out of the transcript", () => {
  const lines = renderTranscript([
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "the prompt" }] } },
    { type: "something_new" },
    null
  ]);
  assert.deepEqual(lines, []);
});

test("lifecycle and error events are surfaced", () => {
  assert.deepEqual(renderTranscript([{ type: "agent_start" }]), ["▶ agent started"]);
  assert.deepEqual(renderTranscript([{ type: "agent_settled" }]), ["■ agent settled"]);
  assert.deepEqual(renderTranscript([{ type: "agent_end", willRetry: true }]), ["  · run ended, retry pending"]);
  assert.deepEqual(renderTranscript([{ type: "agent_end", willRetry: false }]), []);
  assert.deepEqual(renderTranscript([{ type: "error", message: "boom" }]), ["  ✗ error: boom"]);
});

test("long tool arguments are clipped", () => {
  const lines = renderTranscript([
    { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "x".repeat(400) } }
  ]);
  assert.ok(lines[0].length < 140, lines[0]);
  assert.match(lines[0], /\.\.\.$/);
});
