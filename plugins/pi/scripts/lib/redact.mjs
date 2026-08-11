/**
 * Keep obvious secrets out of the journal.
 *
 * Storing prompts and answers means storing the contents of whatever repository
 * a run touched, and those contents sometimes include a key someone pasted into
 * a task ("here is the token, check why the API rejects it"). `redactArgs`
 * already does this for command lines; this is the same idea for free text.
 *
 * What it cannot do: recognise a secret with no recognisable shape. A random
 * 20-character password is indistinguishable from any other word, and this will
 * store it. Patterns catch the formats that announce themselves — provider
 * keys, bearer tokens, JWTs, `password=` assignments — and nothing else.
 */

const PATTERNS = [
  // Provider keys that carry their own prefix.
  [/\b(sk-[A-Za-z0-9_-]{16,})/g, "<redacted key>"],
  [/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, "<redacted token>"],
  [/\b(xox[baprs]-[A-Za-z0-9-]{10,})/g, "<redacted token>"],
  [/\b(AKIA[0-9A-Z]{16})\b/g, "<redacted key id>"],
  [/\b(AIza[0-9A-Za-z_-]{20,})/g, "<redacted key>"],
  // A JWT: three base64url segments, the first of which decodes to a header.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<redacted jwt>"],
  // `Authorization: Bearer …`, whatever the token looks like.
  [/\b(bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, "$1<redacted>"],
  // An assignment that says what it holds: token=…, api_key: "…", password=…
  [
    /\b((?:api[_-]?key|secret|token|password|passwd|access[_-]?key)\s*[:=]\s*)["']?([^\s"',;]{8,})["']?/gi,
    "$1<redacted>"
  ],
  // A URL with credentials in it.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@]+)@/gi, "$1:<redacted>@"]
];

export function redactSecrets(text) {
  let out = String(text ?? "");
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Cap a stored text field.
 *
 * A prompt can be a 200KB review diff and an answer can be just as long; the
 * journal is for finding and repeating runs, not for archiving their contents.
 * The tail is what gets dropped, and the cut says so — silently storing half a
 * prompt would make `rerun` quietly run something else.
 */
export function capText(text, limit) {
  const value = String(text ?? "");
  if (value.length <= limit) {
    return value;
  }
  const notice = `\n\n[... truncated for the journal, ${value.length - limit} more characters ...]`;
  return value.slice(0, limit) + notice;
}

/** What the journal stores for one text field: redacted, then bounded. */
export function forJournal(text, limit = 32 * 1024) {
  if (text === null || text === undefined) {
    return null;
  }
  return capText(redactSecrets(text), limit);
}
