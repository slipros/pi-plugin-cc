/**
 * Pool liveness, as the plugin itself sees it.
 *
 * A pool with free slots is not a pool that works: a run dispatched to an
 * account with an exhausted balance dies in seconds (402 Insufficient Balance),
 * and the next run walks straight into the same wall, because nothing on the
 * dispatch path remembers the death. The journal and the job records already
 * hold every outcome, but they are history, not state the choice can read
 * before spending a container and minutes on a pool that cannot answer.
 *
 * This module keeps that state: one machine-wide JSON file next to the plugin's
 * other records (same reasoning as `fleet-events.jsonl` — pools belong to the
 * machine's config, not to one workspace bucket, so a run started from a
 * subdirectory must see the same liveness as one started from the root).
 *
 * Only provider-side death is recorded here, in three classes: balance (the
 * account cannot pay — returns whenever money does), quota (a windowed limit —
 * returns when the window rolls over), network (the endpoint is unreachable —
 * usually brief). A failure that belongs to the task or the brief (`400`, an
 * unknown model, a parse error) must NOT touch this state: one mistyped
 * command would otherwise evict a perfectly live pool.
 *
 * Both eviction and return are automatic (owner's decision D-12): a dead pool
 * stops being offered until its probe deadline, then re-enters the choice in
 * its normal order; a successful run on it erases the record entirely. No
 * manual "revive" step exists in the normal loop — the `pools` command is
 * debugging, not part of the circuit.
 */

import fs from "node:fs";
import path from "node:path";

import { nowIso, pluginStateRoot, withStateLock, writeFileAtomic } from "./state.mjs";

const STATE_FILE_NAME = "pool-health.json";

/** Free text is a reason, not a transcript; the run's own records hold the rest. */
const MAX_REASON_CHARS = 200;

/**
 * Failure classes that count as the POOL failing, with the patterns that
 * recognize each. Order matters: `402 Insufficient Balance` also matches
 * nothing in quota, but a body mentioning both a status code and rate-limit
 * wording should land on the more specific class first.
 */
const POOL_FAILURE_CLASSES = [
  [
    "balance",
    /\b402\b|insufficient\s+(?:balance|funds|credit)|balance\s+(?:is\s+)?(?:too\s+low|exhausted|empty)/i
  ],
  [
    "quota",
    /\b429\b|"code"\s*:\s*"?1310"?\b|usage limit reached|quota exceeded|rate limit exceeded|weekly usage limit/i
  ],
  [
    "network",
    /econnrefused|etimedout|eai_again|econnreset|socket hang up|fetch failed|network (?:error|unreachable)|getaddrinfo|connect(?:ion)? (?:refused|timed out|reset)/i
  ]
];

/**
 * @param {string|null} text - stderr / error lines of a failed run
 * @returns {{class: "balance"|"quota"|"network", reason: string}|null}
 *          null when the failure belongs to the task, not to the pool
 */
export function classifyPoolFailure(text) {
  const value = String(text ?? "");
  if (!value.trim()) {
    return null;
  }
  for (const [failureClass, pattern] of POOL_FAILURE_CLASSES) {
    if (pattern.test(value)) {
      return {
        class: failureClass,
        reason: value.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARS)
      };
    }
  }
  return null;
}

/**
 * Quota windows are sometimes named by the provider itself ("retry after
 * 30 minutes"); when it does, waiting the named span beats waiting a day.
 */
function parseNamedDuration(text) {
  const value = String(text ?? "");
  const match = /(?:retry|try)\s+after\s+(\d+)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hour|hours)\b/i.exec(value);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const seconds = unit.startsWith("s") ? amount : unit.startsWith("m") ? amount * 60 : amount * 3600;
    return seconds * 1000;
  }
  // Header form: `Retry-After: 3600` carries bare seconds and no unit; the
  // provider named its window either way, so the day default would be idle
  // capacity the provider explicitly offered back sooner.
  const headerMatch = /retry[-\s]?after\s*[:=]\s*(\d+)\b/i.exec(value);
  return headerMatch ? Number(headerMatch[1]) * 1000 : null;
}

/**
 * How long the pool stays out, per class, given the configured defaults.
 * Network failures stack: one refusal may be a blip, but repeated ones within
 * the health record mean the endpoint is actually down, so the hold grows
 * 30s → 60s → 120s → 300s (capped at ten times the base) instead of always
 * letting the next run re-probe a dead endpoint at full frequency.
 */
export function poolHoldMs({ failureClass, reason, failures, balanceMs, quotaMs, networkMs }) {
  if (failureClass === "balance") {
    return balanceMs;
  }
  if (failureClass === "quota") {
    return parseNamedDuration(reason) ?? quotaMs;
  }
  const step = [1, 2, 4, 10][Math.min(Math.max(failures, 1), 4) - 1];
  return Math.min(networkMs * step, networkMs * 10);
}

export function poolHealthPath() {
  return path.join(pluginStateRoot(), STATE_FILE_NAME);
}

function readState() {
  return { pools: loadPoolHealthState().pools };
}

/**
 * Read the file with a verdict: `corrupted` separates "nothing has died yet"
 * from "the file exists but cannot be parsed". Both behave the same on the
 * dispatch path (fail-open), but the `pools` command exists to SHOW damage —
 * it must not print a reassuring line over a torn file.
 */
export function loadPoolHealthState() {
  let raw;
  try {
    raw = fs.readFileSync(poolHealthPath(), "utf8");
  } catch {
    return { pools: {}, corrupted: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (isPlainObject(parsed?.pools)) {
      return { pools: parsed.pools, corrupted: false };
    }
  } catch {
    // Fall through to the corrupted verdict.
  }
  return { pools: {}, corrupted: true };
}

function writeState(state) {
  const filePath = poolHealthPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // rename, not truncate-in-place: a concurrent reader must see the old record
  // or the new one, never half of each (a torn file fail-opens to "nothing is
  // dead", which is exactly the wrong default here).
  writeFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

/** The pool-health file is machine-wide, so its lock lives next to it. */
function withHealthLock(fn) {
  // The lock is a plain mkdir: the parent directory must exist first, or every
  // early acquisition fails with ENOENT, burns the wait deadline and degrades
  // into an unlocked write — the very race this lock exists to close.
  fs.mkdirSync(path.dirname(poolHealthPath()), { recursive: true });
  return withStateLock(`${poolHealthPath()}.lock`, fn);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Record that `pool` failed with a provider-side death. Consecutive failures
 * accumulate only while the pool stays dead: a success wipes the record, so
 * the next network blip starts from the short hold again.
 */
export function recordPoolFailure(pool, failureClass, reason, { now = Date.now(), balanceMs, quotaMs, networkMs } = {}) {
  // Read-modify-write under the lock: simultaneous failures on different pools
  // land within the same second (one provider outage fans out to every fleet
  // run), and two unlocked writers would each write back the pool it saw — the
  // slower one silently dropping the other's death.
  return withHealthLock(() => {
    const state = readState();
    const previous = isPlainObject(state.pools[pool]) ? state.pools[pool] : null;
    const failures = previous ? (previous.failures ?? 1) + 1 : 1;
    const holdMs = poolHoldMs({ failureClass, reason, failures, balanceMs, quotaMs, networkMs });
    state.pools[pool] = {
      class: failureClass,
      reason: String(reason ?? "").slice(0, MAX_REASON_CHARS),
      failures,
      failedAt: nowIso(),
      // Deadline as epoch ms plus the ISO form: the choice compares numerically,
      // the `pools` command prints a date a person can read.
      retryAtMs: now + holdMs,
      retryAt: new Date(now + holdMs).toISOString()
    };
    writeState(state);
    return state.pools[pool];
  });
}

/** A successful run proves the pool works: the record goes, hold and all. */
export function clearPool(pool) {
  return withHealthLock(() => {
    const state = readState();
    if (!isPlainObject(state.pools[pool])) {
      return false;
    }
    delete state.pools[pool];
    writeState(state);
    return true;
  });
}

export function clearAllPools() {
  return withHealthLock(() => {
    const count = Object.keys(readState().pools).length;
    writeState({ pools: {} });
    return count;
  });
}

/** Records whose probe deadline has not passed yet — the pools to skip. */
export function deadPools({ now = Date.now() } = {}) {
  const state = readState();
  const dead = {};
  for (const [pool, record] of Object.entries(state.pools)) {
    if (Number(record.retryAtMs) > now) {
      dead[pool] = record;
    }
  }
  return dead;
}

/**
 * Split a variant list into live and dead candidates.
 *
 * A dead candidate is one whose POOL is under an unexpired hold — every model
 * of one account shares one quota, so the pool, not the model, is the unit of
 * liveness. Returns the dead ones sorted by nearest probe deadline, which is
 * also what "every candidate is dead" needs: waiting for the pool that comes
 * back first beats falling over immediately.
 *
 * @returns {{alive: Array, dead: Array, deadByPool: Object}}
 */
export function partitionByPoolHealth(variants, { now = Date.now() } = {}) {
  const deadByPool = deadPools({ now });
  const alive = [];
  const dead = [];
  for (const variant of variants ?? []) {
    (deadByPool[variant.pool] ? dead : alive).push(variant);
  }
  dead.sort((a, b) => Number(deadByPool[a.pool].retryAtMs) - Number(deadByPool[b.pool].retryAtMs));
  return { alive, dead, deadByPool };
}

export function readPoolHealth() {
  return loadPoolHealthState().pools;
}
