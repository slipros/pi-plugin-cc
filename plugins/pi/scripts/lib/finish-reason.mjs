/**
 * One word for "the answer stopped at the output ceiling", whatever the
 * provider called it.
 *
 * Every API spells it differently — OpenAI `length`, Anthropic `max_tokens`,
 * Google `MAX_TOKENS` — and both the proxy and the agent record whatever they
 * were told, unnormalised, because a journal is a record of what happened and
 * not an interpretation of it. Interpreting is this module's job.
 *
 * It lives on its own so that everything which decides anything about
 * truncation — the proxy, the telemetry, the run, the job row — shares one
 * answer. Comparing against the bare string `"length"` in four places is how
 * the feature silently switched itself off for every provider that is not
 * OpenAI-shaped.
 */

const TRUNCATION_REASONS = new Set(["length", "max_tokens", "max_output_tokens"]);

export function isTruncationReason(value) {
  return TRUNCATION_REASONS.has(String(value ?? "").trim().toLowerCase());
}
