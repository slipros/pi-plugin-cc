/**
 * Ceilings a run is not allowed to cross.
 *
 * The only limit a run had until now was time, which is a poor proxy for what
 * one actually wants to bound: a model that answers fast can burn a dollar in
 * two minutes, and a cheap one can idle for an hour and cost nothing. These
 * limits read the numbers the run already reports — usage rides along with
 * every progress event — and stop it the moment one is crossed.
 *
 * Enforcement is deliberately "stop after", not "predict before": the caller
 * learns the size of a message only once it has been paid for, so a budget can
 * be exceeded by the last message and no earlier. Set them as ceilings you do
 * not want crossed, not as exact allowances.
 */

/** Tokens the run has consumed, cache included — the number the journal keeps. */
export function totalTokensOf(usage) {
  if (!usage || typeof usage !== "object") {
    return 0;
  }
  const value = (key) => (typeof usage[key] === "number" ? usage[key] : 0);
  return value("input") + value("output") + value("cacheRead") + value("cacheWrite");
}

function positiveOrNull(value, key) {
  if (value === undefined || value === null || value === "" || value === false) {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(
      `${key} must be a positive number, got ${JSON.stringify(value)}. Remove it to run without that ceiling.`
    );
  }
  return number;
}

/**
 * @returns {{maxCostUsd: number|null, maxTokens: number|null, maxTurns: number|null}|null}
 *   null when nothing is capped, so the hot path can skip the check entirely.
 */
export function normalizeBudget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const budget = {
    maxCostUsd: positiveOrNull(value.maxCostUsd, "maxCostUsd"),
    maxTokens: positiveOrNull(value.maxTokens, "maxTokens"),
    maxTurns: positiveOrNull(value.maxTurns, "maxTurns")
  };
  return Object.values(budget).some((limit) => limit !== null) ? budget : null;
}

/**
 * @returns {string|null} why the run has to stop, phrased for the report, or
 *   null while it is still within every ceiling it was given.
 */
export function budgetExceeded(budget, { usage = {}, turns = 0 } = {}) {
  if (!budget) {
    return null;
  }
  const cost = typeof usage.cost === "number" ? usage.cost : 0;
  if (budget.maxCostUsd !== null && cost > budget.maxCostUsd) {
    return `cost $${cost.toFixed(4)} passed the $${budget.maxCostUsd} budget`;
  }
  const tokens = totalTokensOf(usage);
  if (budget.maxTokens !== null && tokens > budget.maxTokens) {
    return `${tokens} tokens passed the ${budget.maxTokens} token budget`;
  }
  if (budget.maxTurns !== null && turns > budget.maxTurns) {
    return `${turns} turns passed the ${budget.maxTurns} turn budget`;
  }
  return null;
}

/** One-line description for reports; null when the run is uncapped. */
export function describeBudget(budget) {
  if (!budget) {
    return null;
  }
  const parts = [
    budget.maxCostUsd !== null ? `$${budget.maxCostUsd}` : null,
    budget.maxTokens !== null ? `${budget.maxTokens} tokens` : null,
    budget.maxTurns !== null ? `${budget.maxTurns} turns` : null
  ].filter(Boolean);
  return parts.join(" · ");
}
