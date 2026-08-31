/**
 * Continuing a pi session, and the price of continuing it late.
 *
 * A resumed session replays its whole history to the provider. That is cheap
 * only while the provider still holds the prompt in its cache: past the cache
 * TTL the same context is billed again at the full input rate, and a long
 * session is exactly the case where that hurts — the bigger the history, the
 * bigger the bill for touching it one turn too late.
 *
 * The session file itself never expires (it is a jsonl on disk, or in the
 * sandbox volume), so nothing here is about losing work. What expires is the
 * cache behind it, and that is what the age of a session is measured against.
 */

const MINUTE_MS = 60_000;

/** What a provider is assumed to keep, absent anything better. */
export const DEFAULT_CACHE_TTL = "40m";

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i;

const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: MINUTE_MS,
  h: 60 * MINUTE_MS,
  d: 24 * 60 * MINUTE_MS
};

/**
 * "40m" / "90s" / "2h" / 2400000 → milliseconds.
 *
 * A bare number is minutes, not milliseconds: every value this parses is a
 * cache TTL written by hand, and nobody writes those in milliseconds.
 */
export function parseDuration(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.round(value * MINUTE_MS) : fallback;
  }
  const match = DURATION_PATTERN.exec(String(value).trim());
  if (!match) {
    return fallback;
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "m").toLowerCase();
  if (!Number.isFinite(amount) || !UNIT_MS[unit]) {
    return fallback;
  }
  return Math.round(amount * UNIT_MS[unit]);
}

/** Milliseconds → the same shorthand a human would have typed. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms ?? 0) / 1000));
  if (total < 60) {
    return `${total}s`;
  }
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/**
 * The cache TTL that applies to one run.
 *
 * Providers do not agree on how long a cached prompt lives — and most do not
 * publish it as a number the plugin could read — so the value is configured,
 * per provider where it is known and by a single default where it is not:
 *
 *   "cacheTtl": { "default": "40m", "providers": { "anthropic": "5m" } }
 */
export function resolveCacheTtlMs(config, { provider = null } = {}) {
  const section = config?.cacheTtl ?? {};
  const perProvider = provider ? section.providers?.[provider] : null;
  return (
    parseDuration(perProvider, null) ??
    parseDuration(section.default, null) ??
    parseDuration(DEFAULT_CACHE_TTL, 40 * MINUTE_MS)
  );
}

/**
 * Which provider a recorded job spoke to.
 *
 * The recipe carries it when a flag named one; otherwise the model id does,
 * because the catalog writes them as `provider/model`.
 */
export function providerOf(job) {
  const explicit = job?.rerunSettings?.provider ?? job?.provider ?? null;
  if (explicit) {
    return String(explicit);
  }
  const model = String(job?.model ?? "");
  return model.includes("/") ? model.split("/")[0] : null;
}

/** When the provider last saw this session's context. */
function lastActivityOf(job) {
  return job?.completedAt ?? job?.startedAt ?? job?.updatedAt ?? job?.createdAt ?? null;
}

function isLive(job) {
  return job?.status === "running" || job?.status === "pending";
}

/**
 * One row per pi session, newest first, built from the job records of a
 * workspace.
 *
 * Sessions are keyed by their pi session id, and several jobs share one: a run
 * and every continuation of it. Only the newest job of each session is kept —
 * it is the one that says how old the cache is and what contour the session
 * was last run with.
 */
export function collectSessions(jobs, { now = Date.now() } = {}) {
  const byTimeDesc = [...(jobs ?? [])]
    .filter((job) => job?.sessionId)
    .sort((left, right) => Date.parse(lastActivityOf(right) ?? 0) - Date.parse(lastActivityOf(left) ?? 0));

  const sessions = new Map();
  for (const job of byTimeDesc) {
    if (sessions.has(job.sessionId)) {
      continue;
    }
    const lastActivityAt = lastActivityOf(job);
    const parsed = Date.parse(lastActivityAt ?? "");
    sessions.set(job.sessionId, {
      sessionId: job.sessionId,
      jobId: job.id,
      kind: job.kind ?? "delegate",
      title: job.title ?? null,
      status: job.status ?? null,
      live: isLive(job),
      lastActivityAt,
      // A live job is being talked to right now, so its cache is as warm as it
      // gets; an unparseable timestamp is treated as ancient rather than fresh,
      // because guessing "warm" is the guess that costs money.
      ageMs: isLive(job) ? 0 : Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : Math.max(0, now - parsed),
      model: job.model ?? null,
      provider: providerOf(job),
      preset: job.preset ?? job.rerunSettings?.preset ?? null,
      sandbox: job.sandbox ?? null,
      readOnly: Boolean(job.readOnly ?? job.rerunSettings?.readOnly),
      runRoot: job.runRoot ?? job.workspaceRoot ?? null,
      // Which bucket the job record came from, so a global listing can still
      // find the job file behind each row.
      workspaceRoot: job.workspaceRoot ?? null,
      recipe: job.rerunSettings ?? {}
    });
  }
  return [...sessions.values()];
}

/** Does this look like a session reference rather than the first word of a task? */
export function isSessionReference(token) {
  const value = String(token ?? "").trim();
  if (!value) {
    return false;
  }
  if (value === "last" || value === "latest") {
    return true;
  }
  if (/^(delegate|review)-[a-z0-9]+-[a-z0-9]+$/i.test(value)) {
    return true;
  }
  // A session id is a UUID; a prefix of one is still unmistakable at 8 hex
  // characters, which no ordinary first word of a task is.
  return /^[0-9a-f]{8}[0-9a-f-]*$/i.test(value);
}

/**
 * Resolve "last", a session id (or a prefix/suffix of one) or a job id against
 * the collected sessions.
 */
export function findSession(sessions, reference) {
  const list = sessions ?? [];
  const value = String(reference ?? "").trim();
  if (!value || value === "last" || value === "latest") {
    return list[0] ?? null;
  }
  // Exact ids first, then the shortened forms a report prints: a prefix of the
  // session id, or the tail of either id.
  const matchers = [
    (session) => session.sessionId === value,
    (session) => session.jobId === value,
    (session) => session.sessionId.startsWith(value),
    (session) => session.sessionId.endsWith(value),
    (session) => session.jobId.endsWith(value)
  ];
  for (const matches of matchers) {
    const hit = list.find(matches);
    if (hit) {
      return hit;
    }
  }
  return null;
}

/**
 * How the cache behind a session should be read:
 *   live — the job is still running, there is nothing to continue yet
 *   warm — within the TTL, the history replays from cache
 *   cold — past it, the whole context is billed again at the input rate
 */
export function cacheState(session, ttlMs) {
  if (!session) {
    return "cold";
  }
  if (session.live) {
    return "live";
  }
  return session.ageMs > ttlMs ? "cold" : "warm";
}

function shortSession(sessionId) {
  const value = String(sessionId ?? "");
  return value.length > 13 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

/**
 * The refusal a stale session gets.
 *
 * It has to answer three things at once, because the caller is about to decide
 * with money on the line: how stale, against what TTL, and how much context
 * would be re-billed.
 */
export function staleSessionMessage(session, { ttlMs, contextTokens = null, command = "continue" } = {}) {
  const provider = session.provider ? `provider \`${session.provider}\`` : "this provider";
  const size = contextTokens ? ` Its context was ~${Number(contextTokens).toLocaleString("en-US")} tokens.` : "";
  return (
    `Session \`${shortSession(session.sessionId)}\` was last touched ${formatDuration(session.ageMs)} ago, ` +
    `past the ${formatDuration(ttlMs)} cache TTL configured for ${provider}. ` +
    `Continuing it now re-sends the whole history at the full input rate — nothing is read from cache.${size} ` +
    `Use \`--stale-ok\` to continue anyway, or \`${command} --fresh\` to start a new session with the same agent.`
  );
}
