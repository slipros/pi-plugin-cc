import assert from "node:assert/strict";
import test from "node:test";

import { BUILT_IN_CONFIG, mergeConfigLayer } from "../plugins/pi/scripts/lib/config.mjs";
import {
  cacheState,
  collectSessions,
  findSession,
  formatDuration,
  isSessionReference,
  parseDuration,
  providerOf,
  resolveCacheTtlMs,
  staleSessionMessage
} from "../plugins/pi/scripts/lib/sessions.mjs";
import { renderSessionsReport } from "../plugins/pi/scripts/lib/render.mjs";

const NOW = Date.parse("2026-08-31T20:00:00.000Z");
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

function job(overrides = {}) {
  return {
    id: "delegate-aaa-111",
    kind: "delegate",
    status: "completed",
    sessionId: "01a05965-a85e-7b3b-8eea-3a3bd032f0ce",
    completedAt: minutesAgo(10),
    model: "deepseek/deepseek-v4-flash",
    preset: "go-developer",
    sandbox: "docker pi-sandbox-agent:latest",
    runRoot: "/repo",
    workspaceRoot: "/repo",
    rerunSettings: { preset: "go-developer", model: "deepseek/deepseek-v4-flash", sandbox: "agent-dind" },
    ...overrides
  };
}

test("durations are read the way a human writes them, minutes by default", () => {
  assert.equal(parseDuration("40m"), 40 * 60_000);
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("2h"), 2 * 3_600_000);
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration(40), 40 * 60_000, "a bare number is minutes, not milliseconds");
  assert.equal(parseDuration("nonsense", 7), 7, "an unreadable value falls back instead of becoming NaN");
  assert.equal(parseDuration(null, null), null);
});

test("durations print back as the shorthand they came from", () => {
  assert.equal(formatDuration(40 * 60_000), "40m");
  assert.equal(formatDuration(2 * 3_600_000), "2h");
  assert.equal(formatDuration(130 * 60_000), "2h 10m");
  assert.equal(formatDuration(45_000), "45s");
});

test("the cache TTL falls back from provider to default to the built-in", () => {
  const config = mergeConfigLayer(BUILT_IN_CONFIG, {
    cacheTtl: { default: "30m", providers: { anthropic: "5m" } }
  });
  assert.equal(resolveCacheTtlMs(config, { provider: "anthropic" }), 5 * 60_000);
  assert.equal(resolveCacheTtlMs(config, { provider: "deepseek" }), 30 * 60_000);
  assert.equal(resolveCacheTtlMs(BUILT_IN_CONFIG, { provider: "deepseek" }), 40 * 60_000);
  assert.equal(resolveCacheTtlMs({}, {}), 40 * 60_000, "a config without the section still has a TTL");
});

test("a project layer can tune one provider without restating the rest", () => {
  const user = mergeConfigLayer(BUILT_IN_CONFIG, { cacheTtl: { default: "30m", providers: { anthropic: "5m" } } });
  const merged = mergeConfigLayer(user, { cacheTtl: { providers: { deepseek: "2h" } } });
  assert.equal(resolveCacheTtlMs(merged, { provider: "deepseek" }), 2 * 3_600_000);
  assert.equal(resolveCacheTtlMs(merged, { provider: "anthropic" }), 5 * 60_000);
  assert.equal(resolveCacheTtlMs(merged, {}), 30 * 60_000);
});

test("the provider comes from the recipe, or from the model id when it does not", () => {
  assert.equal(providerOf(job({ rerunSettings: { provider: "ollama-pro" } })), "ollama-pro");
  assert.equal(providerOf(job({ rerunSettings: {} })), "deepseek");
  assert.equal(providerOf(job({ rerunSettings: {}, model: "local-model" })), null);
});

test("sessions are collected newest first, one row per session", () => {
  const sessions = collectSessions(
    [
      job({ id: "delegate-aaa-111", completedAt: minutesAgo(90) }),
      job({ id: "delegate-bbb-222", completedAt: minutesAgo(10) }),
      job({ id: "delegate-ccc-333", sessionId: "01a05964-0000-0000-0000-000000000000", completedAt: minutesAgo(50) }),
      { id: "delegate-ddd-444", status: "completed", completedAt: minutesAgo(1) }
    ],
    { now: NOW }
  );

  assert.equal(sessions.length, 2, "a run without a session id is not a session");
  assert.equal(sessions[0].jobId, "delegate-bbb-222", "the newest job of a session speaks for it");
  assert.equal(sessions[0].ageMs, 10 * 60_000);
  assert.equal(sessions[0].preset, "go-developer");
  assert.equal(sessions[1].sessionId, "01a05964-0000-0000-0000-000000000000");
});

test("a running job leaves its session live rather than aged", () => {
  const [session] = collectSessions([job({ status: "running", completedAt: null, startedAt: minutesAgo(120) })], {
    now: NOW
  });
  assert.equal(session.live, true);
  assert.equal(session.ageMs, 0);
  assert.equal(cacheState(session, 40 * 60_000), "live");
});

test("an unreadable timestamp counts as cold, never as warm", () => {
  const [session] = collectSessions([job({ completedAt: "not-a-date" })], { now: NOW });
  assert.equal(cacheState(session, 40 * 60_000), "cold");
});

test("the TTL boundary is the moment the cache stops being read", () => {
  const ttl = 40 * 60_000;
  const [warm] = collectSessions([job({ completedAt: minutesAgo(40) })], { now: NOW });
  const [cold] = collectSessions([job({ completedAt: minutesAgo(41) })], { now: NOW });
  assert.equal(cacheState(warm, ttl), "warm", "exactly at the TTL is still inside it");
  assert.equal(cacheState(cold, ttl), "cold");
});

test("a reference is told apart from the first word of a task", () => {
  assert.equal(isSessionReference("last"), true);
  assert.equal(isSessionReference("delegate-mthntfki-5b6f0q"), true);
  assert.equal(isSessionReference("01a05965"), true);
  assert.equal(isSessionReference("добавь"), false);
  assert.equal(isSessionReference("fix"), false, "a short word is a task, not a session");
  assert.equal(isSessionReference("deadbeef-ish"), false);
});

test("sessions resolve by prefix, by tail and by job id", () => {
  const sessions = collectSessions([job(), job({ id: "delegate-bbb-222", sessionId: "01a05964-1111", completedAt: minutesAgo(30) })], {
    now: NOW
  });
  assert.equal(findSession(sessions, "last").jobId, "delegate-aaa-111");
  assert.equal(findSession(sessions, "01a05964").sessionId, "01a05964-1111");
  assert.equal(findSession(sessions, "f0ce").jobId, "delegate-aaa-111", "the tail printed in a report resolves");
  assert.equal(findSession(sessions, "delegate-bbb-222").sessionId, "01a05964-1111");
  assert.equal(findSession(sessions, "nothing-like-it"), null);
  assert.equal(findSession([], "last"), null);
});

test("the refusal names the age, the TTL and what would be re-billed", () => {
  const [session] = collectSessions([job({ completedAt: minutesAgo(130) })], { now: NOW });
  const message = staleSessionMessage(session, { ttlMs: 40 * 60_000, contextTokens: 84_000, command: "continue" });
  assert.match(message, /2h 10m ago/);
  assert.match(message, /40m cache TTL/);
  assert.match(message, /deepseek/);
  assert.match(message, /84,000 tokens/);
  assert.match(message, /--stale-ok/, "the way through is part of the refusal");
  assert.match(message, /--fresh/);
});

test("the sessions report separates warm from cold and says what each costs", () => {
  const sessions = collectSessions(
    [job({ completedAt: minutesAgo(12) }), job({ id: "delegate-bbb-222", sessionId: "01a05964-1111", completedAt: minutesAgo(130), preset: null, sandbox: null })],
    { now: NOW }
  ).map((session) => ({ ...session, ttlMs: 40 * 60_000, contextTokens: 84_000 }));

  const report = renderSessionsReport(sessions, { workspace: "/repo", ttlMs: 40 * 60_000 });
  assert.match(report, /\| 12m \| warm \|/);
  assert.match(report, /\| 2h 10m \| cold \|/);
  assert.match(report, /go-developer/);
  assert.match(report, /84,000/);
  assert.match(report, /Cache TTL in force: 40m/);
});

test("an empty listing explains the bucket instead of claiming nothing exists", () => {
  const report = renderSessionsReport([], { workspace: "/repo", ttlMs: 40 * 60_000 });
  assert.match(report, /No pi session recorded/);
  assert.match(report, /bucketed by the directory/, "a session started elsewhere is not a missing session");
  assert.match(report, /--global/);
});
