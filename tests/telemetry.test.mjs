import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createStreamMeter, hasUnknownUsageKeys, normalizeUsage } from "../plugins/pi/scripts/lib/sse-meter.mjs";
import { createRequestRecorder, pruneRequests, queryRequests } from "../plugins/pi/scripts/lib/telemetry.mjs";
import { openDatabase } from "../plugins/pi/scripts/lib/db.mjs";

/** A clock the test drives, so timings are asserted rather than raced. */
function fakeClock(start = 1_000) {
  let value = start;
  return { now: () => value, advance: (ms) => (value += ms) };
}

function sse(meter, payload) {
  meter.push(Buffer.from(`data: ${JSON.stringify(payload)}\n\n`, "utf8"));
}

test("the first content frame starts the generation window, not the first byte", () => {
  const clock = fakeClock();
  const meter = createStreamMeter({ now: clock.now });

  // Providers differ in politeness: a role frame or a keep-alive arrives long
  // before the model has produced anything, and counting it as the first token
  // would measure the wire format instead of the prefill.
  clock.advance(300);
  sse(meter, { choices: [{ delta: { role: "assistant" } }] });
  clock.advance(700);
  sse(meter, { choices: [{ delta: { content: "he" } }] });
  clock.advance(50);
  sse(meter, { choices: [{ delta: { content: "llo" } }] });

  const summary = meter.summary();
  assert.equal(summary.ttft_ms, 1000, "1000ms of prefill, not 300ms to the polite frame");
  assert.equal(summary.stream_ms, 50);
  assert.equal(summary.chunks, 3);
});

test("a silence inside the stream is reported only when it is long enough to mean something", () => {
  const clock = fakeClock();
  const meter = createStreamMeter({ now: clock.now });
  sse(meter, { choices: [{ delta: { content: "a" } }] });
  clock.advance(200);
  sse(meter, { choices: [{ delta: { content: "b" } }] });
  assert.equal(meter.summary().max_gap_ms, null, "sub-second gaps are transport noise");

  clock.advance(4000);
  sse(meter, { choices: [{ delta: { content: "c" } }] });
  assert.equal(meter.summary().max_gap_ms, 4000);
});

test("usage is read whatever the provider calls its fields", () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 8 } }), {
    in_tokens: 10,
    out_tokens: 5,
    reasoning_tokens: null,
    cached_tokens: 8
  });
  assert.deepEqual(normalizeUsage({ input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 2 }), {
    in_tokens: 3,
    out_tokens: 4,
    reasoning_tokens: null,
    cached_tokens: 2
  });
  assert.equal(normalizeUsage(null), null);
});

test("the raw usage blob is kept only when the provider reports something unmapped", () => {
  // The blob exists for exactly one case — a provider saying something pi does
  // not carry forward — and that criterion keeps ordinary answers out of it.
  assert.equal(hasUnknownUsageKeys({ prompt_tokens: 1, completion_tokens: 2 }), false);
  assert.equal(hasUnknownUsageKeys({ prompt_tokens: 1, energy_joules: 42 }), true);

  const meter = createStreamMeter({ now: fakeClock().now });
  sse(meter, { choices: [{ delta: { content: "x" } }] });
  sse(meter, { usage: { prompt_tokens: 100, completion_tokens: 20 }, choices: [{ finish_reason: "stop" }] });
  const known = meter.summary();
  assert.equal(known.usage_json, null);
  assert.equal(known.in_tokens, 100);
  assert.equal(known.finish_reason, "stop");

  const odd = createStreamMeter({ now: fakeClock().now });
  sse(odd, { usage: { prompt_tokens: 1, queue_position: 7 } });
  assert.match(odd.summary().usage_json, /queue_position/);
});

test("anthropic-style frames are measured too", () => {
  const clock = fakeClock();
  const meter = createStreamMeter({ now: clock.now });
  clock.advance(120);
  meter.push(Buffer.from('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n', "utf8"));
  meter.push(Buffer.from('data: {"type":"message_delta","usage":{"output_tokens":11},"delta":{"stop_reason":"end_turn"}}\n\n', "utf8"));

  const summary = meter.summary();
  assert.equal(summary.ttft_ms, 120);
  assert.equal(summary.out_tokens, 11);
  assert.equal(summary.finish_reason, "end_turn");
});

test("a frame split across two chunks is still one frame", () => {
  const meter = createStreamMeter({ now: fakeClock().now });
  meter.push(Buffer.from('data: {"choices":[{"delta":{"cont', "utf8"));
  meter.push(Buffer.from('ent":"split"}}]}\n\n', "utf8"));
  assert.equal(meter.summary().ttft_ms, 0, "the content frame was recognised once whole");
});

test("a run with no id records nothing at all", () => {
  // An orphaned row answers no question and cannot be joined to anything.
  assert.equal(createRequestRecorder(null), null);
});

test("requests are written in batches and rolled up for the job row", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telemetry-"));
  const file = path.join(dir, "jobs.db");
  try {
    const recorder = createRequestRecorder("delegate-9", { databaseFile: file });
    recorder.record({ status: 200, stream: true, ttft_ms: 100, stream_ms: 900, out_tokens: 90, model: "m" });
    recorder.record({ status: 200, stream: true, ttft_ms: 300, stream_ms: 1100, out_tokens: 110, model: "m" });
    recorder.record({ status: 200, stream: true, ttft_ms: 500, model: "m" });
    recorder.record({ status: 429, error_kind: null, stream: true, model: "m" });
    recorder.record({ status: 0, error_kind: "transport", stream: true, model: "m" });

    const stats = recorder.stats();
    assert.equal(stats.count, 5);
    assert.equal(stats.failed, 2, "a 429 and a request that never arrived both count");
    assert.equal(stats.ttftP50Ms, 300);
    // Only requests with both a window and tokens contribute to the rate: the
    // third one would otherwise add tokens with no time to divide them by.
    assert.equal(stats.genMs, 2000);
    assert.equal(stats.genOutTokens, 200);

    assert.equal(recorder.close(), 5, "everything still buffered is flushed when the run ends");

    const handle = openDatabase(file);
    const rows = queryRequests(handle, "delegate-9");
    assert.deepEqual(rows.map((row) => row.seq), [1, 2, 3, 4, 5], "order within the run is preserved");
    assert.equal(rows[3].status, 429);
    assert.equal(rows[4].error_kind, "transport");
    assert.equal(rows[0].job_id, "delegate-9");
    handle.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("old request rows are dropped while the run they belonged to stays", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telemetry-prune-"));
  const handle = openDatabase(path.join(dir, "jobs.db"));
  try {
    const old = new Date(Date.now() - 120 * 86_400_000).toISOString();
    handle.db
      .prepare("INSERT INTO requests (job_id, seq, started_at, status) VALUES ('old', 1, $at, 200)")
      .run({ at: old });
    handle.db
      .prepare("INSERT INTO requests (job_id, seq, started_at, status) VALUES ('new', 1, $at, 200)")
      .run({ at: new Date().toISOString() });

    assert.equal(pruneRequests(handle, { days: 90 }), 1);
    assert.equal(queryRequests(handle, "old").length, 0);
    assert.equal(queryRequests(handle, "new").length, 1);
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the rate is measured on generation windows, and short answers do not count", async () => {
  const { queryStats, recordJob } = await import("../plugins/pi/scripts/lib/db.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rate-"));
  const handle = openDatabase(path.join(dir, "jobs.db"));
  try {
    const base = { kind: "delegate", status: "completed", createdAt: new Date().toISOString() };
    // Two real answers on one model: 4000 tokens over 20s of generation.
    recordJob(handle, {
      ...base,
      id: "long-1",
      model: "prov/model",
      usage: { output: 2000 },
      proxyStats: { count: 3, failed: 0, ttftP50Ms: 200, genMs: 10_000, genOutTokens: 2000 }
    });
    recordJob(handle, {
      ...base,
      id: "long-2",
      model: "prov/model",
      usage: { output: 2000 },
      proxyStats: { count: 3, failed: 0, ttftP50Ms: 250, genMs: 10_000, genOutTokens: 2000 }
    });
    // A one-word answer: its first frame was generated before the window even
    // opened, so counting it would inflate the rate without limit.
    recordJob(handle, {
      ...base,
      id: "short",
      model: "prov/model",
      usage: { output: 6 },
      proxyStats: { count: 1, failed: 0, ttftP50Ms: 90, genMs: 5, genOutTokens: 6 }
    });
    // No telemetry at all — an unsandboxed run, or one recorded before this
    // existed. It must not be folded in on the old measurement.
    recordJob(handle, { ...base, id: "untimed", model: "prov/model", usage: { output: 5000 }, timing: { modelMs: 1000 } });

    const [row] = queryStats(handle, { by: "model", days: 1 });
    assert.equal(row.runs, 4);
    assert.equal(row.tokensPerSecond, 200, "4000 tokens over 20s of generation");
    assert.equal(row.outputPerRun, 2000, "the answer length behind the rate, so buckets can be compared honestly");
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Единственный производитель `lastFinishReason`, на котором держатся фаза
// джоба и запасной сигнал восстановления. До этого поле не проверялось ничем:
// downstream-тесты кормились рукописным `proxyStats`, и рекордер мог перестать
// его заполнять незаметно.
test("the summary reports why the LAST request ended, not the last reason seen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telemetry-finish-"));
  const file = path.join(dir, "jobs.db");
  try {
    const recorder = createRequestRecorder("delegate-finish", { databaseFile: file });
    recorder.record({ status: 200, stream: true, model: "m", finish_reason: "length" });
    recorder.record({ status: 200, stream: true, model: "m", finish_reason: "tool_calls" });
    recorder.record({ status: 200, stream: true, model: "m", finish_reason: "stop" });

    const stats = recorder.stats();
    assert.equal(stats.lastFinishReason, "stop");
    assert.equal(stats.truncated, 1, "обрыв в середине прогона считается, но приговором не становится");

    // Запрос без причины — это оборванное соединение, а не «как раньше».
    // Пока значение залипало, прогон, у которого связь умерла после обрезанного
    // ответа, получал фазу truncated по ответу, которого не было.
    recorder.record({ status: 0, error_kind: "transport", stream: true, model: "m" });
    assert.equal(recorder.stats().lastFinishReason, null);

    recorder.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the truncation tally understands every provider's spelling", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telemetry-spellings-"));
  const file = path.join(dir, "jobs.db");
  try {
    const recorder = createRequestRecorder("delegate-spellings", { databaseFile: file });
    recorder.record({ status: 200, stream: true, model: "m", finish_reason: "length" });
    recorder.record({ status: 200, stream: true, model: "m", finish_reason: "max_tokens" });
    recorder.record({ status: 200, stream: true, model: "m", finish_reason: "MAX_TOKENS" });
    recorder.record({ status: 200, stream: true, model: "m", finish_reason: "stop" });

    assert.equal(recorder.stats().truncated, 3);
    recorder.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("серия ответов одинаковой длины подряд поднимает repeatRun", () => {
  // Повтор, укладывающийся в потолок, ничем не помечен: finish_reason здоровый,
  // джоб числится сделанным. Ловит его только одинаковая длина ответов подряд.
  const recorder = createRequestRecorder("job-repeat", { databaseFile: ":memory:" });
  for (const out of [1283, 1283, 1290, 1283, 1283]) {
    recorder.record({ out_tokens: out, status: 200, finish_reason: "tool_calls" });
  }
  assert.ok(recorder.stats().repeatRun >= 5, `ждали серию, получили ${recorder.stats().repeatRun}`);

  // Короткие подтверждения совпадают по длине сами собой — это не повтор.
  const short = createRequestRecorder("job-short", { databaseFile: ":memory:" });
  for (let i = 0; i < 8; i += 1) {
    short.record({ out_tokens: 12, status: 200, finish_reason: "stop" });
  }
  assert.equal(short.stats().repeatRun, 0);

  // Разные ответы серию рвут.
  const varied = createRequestRecorder("job-varied", { databaseFile: ":memory:" });
  for (const out of [900, 1500, 300, 2200, 700]) {
    varied.record({ out_tokens: out, status: 200, finish_reason: "tool_calls" });
  }
  assert.ok(varied.stats().repeatRun <= 1, `ждали отсутствие серии, получили ${varied.stats().repeatRun}`);
});
