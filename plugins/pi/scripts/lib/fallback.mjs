/**
 * Fallback presets: dispatching a run to the first live preset in a chain.
 *
 * A provider runs out of balance or falls over, and the task still goes to the
 * dead preset's slot pool, where it dies in seconds — the caller notices only
 * by hand. The chain already existed as configuration (`fallbackPreset`), but
 * nothing on the dispatch path asked for it. This module derives the chain and
 * tells a dead preset from a live one from the plugin's own run journal, so it
 * works on any machine the plugin is installed on, without reading files that
 * belong to a supervisor's setup.
 */

import { normalizeSandbox } from "./sandbox.mjs";

/**
 * Why a preset is presumed dead decides whether it may be swapped away.
 *
 * Only provider-side death (quota incl. exhausted balance, network) justifies
 * leaving the preset. "Pool busy" is deliberately first: a probe run that hit
 * full slots returns exactly that text, and reading it as quota would pull
 * healthy runs off their preset for no reason. Everything else — a typo in a
 * model name, a bad brief, a refused request — stays where the caller put it.
 */
const CLASSIFIER = [
  [
    "pool",
    /waiting for a free slot|is at its limit of|all of them are busy/i
  ],
  [
    "quota",
    /\b402\b|insufficient\s+(?:balance|funds|quota)|balance\s+(?:is\s+)?(?:too\s+low|exhausted)|\b429\b|"code"\s*:\s*"1310"|usage limit reached|quota exceeded|rate limit exceeded|weekly usage limit|使用上限/i
  ],
  [
    "network",
    /econn(refused|reset|aborted)|etimedout|enotfound|eai_again|epipe|socket hang up|network (?:error|unreachable)|tls handshake|getaddrinfo|fetch failed|connect(?:ion)? (?:refused|timed out|reset)|\b50[234]\b|endpoint could not be reached|bad gateway|service unavailable|gateway time-?out/i
  ]
];

/**
 * @param {string|null} text - refusal text of a failed run
 * @returns {"pool"|"quota"|"network"|"unknown"}
 */
export function classifyFailure(text) {
  const value = String(text ?? "");
  if (!value.trim()) {
    return "unknown";
  }
  for (const [kind, pattern] of CLASSIFIER) {
    if (pattern.test(value)) {
      return kind;
    }
  }
  return "unknown";
}

/**
 * The slot pool a preset draws from, by its profile's own name. A preset whose
 * selected model belongs to a pool is scoped by that pool at variant build
 * time, so here the profile name is the only remaining grouping. Two presets
 * on one profile hit the same provider allowance, which is what makes the
 * pool — not the preset — the unit a busy slot message speaks about.
 */
export function presetPool(preset, config) {
  let sandbox;
  try {
    sandbox = normalizeSandbox(preset?.sandbox ?? null, config?.sandboxProfiles ?? {});
  } catch {
    return null;
  }
  return sandbox?.profileName ?? null;
}

/**
 * Presets are named `<stack>-<role>-<provider>`. Anything shorter carries no
 * chain to derive: its fallback is only what `fallbackPreset` declares.
 *
 * @returns {{stack: string, role: string, provider: string}|null}
 */
export function parsePresetName(name) {
  const parts = String(name ?? "").split("-").filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  return { stack: parts[0], role: parts.slice(1, -1).join("-"), provider: parts.at(-1) };
}

/**
 * The fallback chain of a preset, first candidate first.
 *
 * A declared `fallbackPreset` is respected as the head of the chain. The rest
 * is derived from the name: presets serving the same stack and role through a
 * different provider, in name order. Cycle-prone config is handled by the walk
 * (it never revisits a preset), not here.
 */
export function deriveFallbackChain(presetName, config) {
  const presets = config?.presets ?? {};
  const chain = [];
  const seen = new Set([presetName]);
  const push = (name) => {
    if (name && presets[name] && !seen.has(name)) {
      seen.add(name);
      chain.push(name);
    }
  };

  push(presets[presetName]?.fallbackPreset);

  const parsed = parsePresetName(presetName);
  if (parsed) {
    for (const name of Object.keys(presets).sort()) {
      const other = parsePresetName(name);
      if (other && other.stack === parsed.stack && other.role === parsed.role) {
        push(name);
      }
    }
  }
  return chain;
}

/**
 * Whether the journal says a preset is dead.
 *
 * Only the preset's most recent run votes: a quota failure yesterday followed
 * by a success today means the preset is back, and a success after a network
 * failure means the same. A failure whose cause is `pool` or `unknown` keeps
 * the preset alive — an unidentified refusal is the caller's to judge, not a
 * reason to silently move the work elsewhere.
 *
 * Only `error_text` is read, never `result_text`: the result column holds the
 * agent's last answer, and an assistant that quotes a log line — "fetch failed:
 * ECONNREFUSED" — while working would otherwise be taken for a dead provider,
 * silently moving the whole fleet off a healthy preset.
 *
 * @param {Array<{preset: ?string, status: ?string, error_text: ?string}>} runs
 *        journal rows, newest first
 */
export function presetDead(presetName, runs) {
  const last = (runs ?? []).find((run) => run.preset === presetName);
  if (!last || last.status !== "failed") {
    return null;
  }
  const kind = classifyFailure(last.error_text);
  return kind === "quota" || kind === "network" ? { kind, text: String(last.error_text) } : null;
}

/**
 * The first live preset of the chain, or null when no substitution is due —
 * the preset is alive, or every candidate is as dead as the preset itself.
 * Depth is bounded by the chain never revisiting a preset, so a config cycle
 * degrades to "walked everything once".
 *
 * @returns {{preset: string, dead: {kind: string, text: string}}|null}
 */
export function resolvePresetFallback({ config, presetName, runs }) {
  if (!presetName || !config?.presets?.[presetName]) {
    return null;
  }
  const dead = presetDead(presetName, runs);
  if (!dead) {
    return null;
  }
  for (const candidate of deriveFallbackChain(presetName, config)) {
    if (!presetDead(candidate, runs)) {
      return { preset: candidate, dead };
    }
  }
  return null;
}
