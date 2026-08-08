/**
 * Minimal argv parser shared by every companion command.
 *
 * Claude Code hands slash-command arguments over as a single raw string, so
 * the parser also has to understand shell-style quoting.
 */

export function splitRawArgumentString(raw) {
  const input = String(raw ?? "");
  const tokens = [];
  let current = "";
  let quote = null;
  let started = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quote) {
      if (char === "\\" && quote === '"' && index + 1 < input.length) {
        current += input[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  if (started) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * @param {string[]} argv
 * @param {{ booleans?: string[], strings?: string[], collect?: string[], aliases?: Record<string,string> }} schema
 */
export function parseArgs(argv, schema = {}) {
  const booleans = new Set(schema.booleans ?? []);
  const strings = new Set(schema.strings ?? []);
  const collect = new Set(schema.collect ?? []);
  const aliases = schema.aliases ?? {};

  const flags = {};
  const positional = [];
  const unknown = [];

  const canonical = (name) => aliases[name] ?? name;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }

    if (typeof token !== "string" || !token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const equalsIndex = token.indexOf("=");
    const rawName = equalsIndex === -1 ? token.slice(2) : token.slice(2, equalsIndex);
    const inlineValue = equalsIndex === -1 ? null : token.slice(equalsIndex + 1);
    const name = canonical(rawName);

    if (booleans.has(name)) {
      flags[name] = inlineValue == null ? true : inlineValue !== "false";
      continue;
    }

    if (strings.has(name) || collect.has(name)) {
      const value = inlineValue ?? argv[++index];
      if (value == null) {
        throw new Error(`Flag --${rawName} expects a value.`);
      }
      if (collect.has(name)) {
        flags[name] = [...(flags[name] ?? []), value];
      } else {
        flags[name] = value;
      }
      continue;
    }

    unknown.push(token);
  }

  return { flags, positional, unknown };
}
