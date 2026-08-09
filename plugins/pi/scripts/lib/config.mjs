import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Plugin configuration.
 *
 * A preset is a complete agent profile: model, thinking level, system prompt,
 * tools, extensions, skills and limits. Everything a run needs lives in one
 * place, and command-line flags override individual fields.
 *
 * Layering, lowest priority first:
 *   1. built-in defaults below
 *   2. user config    ~/.claude/pi/config.json
 *   3. project config <workspace>/.claude/pi/config.json
 *   4. command line flags (applied by the caller)
 *
 * Layers merge field by field, so a project can tune one detail of a global
 * preset — a model, an extra mount — without restating the whole thing. See
 * `mergeConfigLayer` for what "tune" means per field type.
 */

export const USER_CONFIG_RELATIVE = path.join(".claude", "pi", "config.json");
export const PROJECT_CONFIG_RELATIVE = path.join(".claude", "pi", "config.json");

const BUILT_IN = {
  defaults: {
    model: null,
    provider: null,
    thinking: null,
    systemPrompt: null,
    // Nobody is at the keyboard during a delegated run, so a question tool
    // would burn a turn waiting for an answer that never comes. Set
    // `"excludeTools": []` in a preset or config layer to hand it back.
    excludeTools: ["ask_question"],
    sandbox: null,
    timeoutMs: 1_800_000
  },
  presets: {},
  // Named sandbox profiles: the toolchain an agent needs inside the container
  // (mounted binaries, PATH, gate extensions), referenced by `"sandbox": "go"`.
  sandboxProfiles: {},
  commands: {
    delegate: {},
    review: { systemPrompt: "reviewer", readOnly: true }
  }
};

export function userConfigPath() {
  return path.join(os.homedir(), USER_CONFIG_RELATIVE);
}

export function projectConfigPath(workspaceRoot) {
  return path.join(workspaceRoot, PROJECT_CONFIG_RELATIVE);
}

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { value: null, error: null };
  }
  try {
    return { value: JSON.parse(fs.readFileSync(filePath, "utf8")), error: null };
  } catch (error) {
    return { value: null, error: `${filePath}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Fields that describe equipment rather than a choice: a later layer adds to
 * them instead of replacing them, so a project can hand a global preset one
 * more mount or one more note without repeating the ones it already has.
 *
 * `tools` and `excludeTools` are deliberately absent — they are a decision
 * about what the agent may do, and a project restating them means exactly
 * those and no others.
 */
const ADDITIVE_KEYS = new Set(["appendSystemPrompt", "extensions", "skills", "mounts", "env", "args"]);

/**
 * How two values of an additive field are keyed against each other, so the
 * later layer overrides the matching entry instead of piling a second one on
 * top: mounts by their container path, env by variable name.
 */
const ADDITIVE_IDENTITY = {
  mounts: (value) => String(value).split(":")[1] ?? String(value),
  env: (value) => String(value).split("=")[0]
};

/**
 * Merge one additive field the way config layers do. Exported because a sandbox
 * object naming a profile is the same situation: `{"profile": "go", "env": [...]}`
 * has to keep the profile's PATH, not replace it with one entry.
 */
export function concatAdditive(key, base = [], layer = []) {
  return concatUnique(base, layer, ADDITIVE_IDENTITY[key]);
}

function concatUnique(base, layer, identity = (value) => value) {
  const merged = new Map();
  for (const value of [...base, ...layer]) {
    // Map keeps the position of the first insertion and takes the later value,
    // so an overriding entry lands where the inherited one stood.
    merged.set(identity(value), value);
  }
  return [...merged.values()];
}

/**
 * Merge one named entry (a preset, a sandbox profile, a command) field by field.
 *
 * - additive fields concatenate, later layers overriding matching entries
 * - nested objects merge recursively, so `sandbox: {network}` keeps the rest
 * - `null` removes an inherited field, the way out of a merge
 * - everything else is replaced
 */
function mergeEntry(base, layer) {
  if (!isPlainObject(base) || !isPlainObject(layer)) {
    return layer;
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    if (value === null) {
      delete merged[key];
      continue;
    }
    if (ADDITIVE_KEYS.has(key) && Array.isArray(merged[key]) && Array.isArray(value)) {
      merged[key] = concatUnique(merged[key], value, ADDITIVE_IDENTITY[key]);
      continue;
    }
    if (isPlainObject(merged[key]) && isPlainObject(value)) {
      merged[key] = mergeEntry(merged[key], value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function mergeNamed(base, layer) {
  const merged = { ...base };
  for (const [name, value] of Object.entries(isPlainObject(layer) ? layer : {})) {
    merged[name] = mergeEntry(merged[name], value);
  }
  return merged;
}

export function mergeConfigLayer(base, layer) {
  if (!isPlainObject(layer)) {
    return base;
  }
  return {
    defaults: mergeEntry(base.defaults, isPlainObject(layer.defaults) ? layer.defaults : {}),
    presets: mergeNamed(base.presets, layer.presets),
    sandboxProfiles: mergeNamed(base.sandboxProfiles, layer.sandboxProfiles),
    commands: mergeNamed(base.commands, layer.commands)
  };
}

/**
 * @returns {{ config: object, sources: string[], errors: string[] }}
 */
export function loadConfig(workspaceRoot) {
  const sources = [];
  const errors = [];
  let config = BUILT_IN;

  for (const filePath of [userConfigPath(), projectConfigPath(workspaceRoot)]) {
    const { value, error } = readJsonFile(filePath);
    if (error) {
      errors.push(error);
      continue;
    }
    if (value) {
      sources.push(filePath);
      config = mergeConfigLayer(config, value);
    }
  }

  return { config, sources, errors };
}

/**
 * Resolve the run settings for one command invocation.
 *
 * @param {object} config    merged plugin config
 * @param {string} command   "delegate" | "review"
 * @param {object} overrides flags coming from the command line
 */
export function resolveRunSettings(config, command, overrides = {}) {
  const commandDefaults = config.commands?.[command] ?? {};
  const presetName = overrides.preset ?? commandDefaults.preset ?? null;
  let preset = {};

  if (presetName) {
    preset = config.presets?.[presetName] ?? null;
    if (!preset) {
      const available = Object.keys(config.presets ?? {});
      throw new Error(
        available.length
          ? `Unknown preset "${presetName}". Available presets: ${available.join(", ")}.`
          : `Unknown preset "${presetName}". No presets are configured; add one to ${userConfigPath()}.`
      );
    }
  }

  const pick = (key) => {
    for (const layer of [overrides, preset, commandDefaults, config.defaults ?? {}]) {
      const value = layer?.[key];
      if (value !== undefined && value !== null && value !== "") {
        return value;
      }
    }
    return null;
  };

  /**
   * The system prompt is resolved per layer, not per key: a preset carries its
   * own prompt, so `--system-prompt` on the command line replaces it whole
   * instead of merging with it.
   */
  const promptSource =
    [overrides, preset, commandDefaults, config.defaults ?? {}].find((layer) => layer?.systemPrompt) ?? {};

  // Later layers win, so the lists run from lowest to highest priority.
  const layers = [config.defaults ?? {}, commandDefaults, preset, overrides];
  const flagOf = (key) =>
    layers.reduce((acc, layer) => (typeof layer?.[key] === "boolean" ? layer[key] : acc), false);
  const mergeLists = (key) => {
    const values = layers.flatMap((layer) => (Array.isArray(layer?.[key]) ? layer[key] : []));
    return ADDITIVE_IDENTITY[key] ? concatUnique([], values, ADDITIVE_IDENTITY[key]) : values;
  };

  const readOnly = flagOf("readOnly");

  /**
   * Commit identity for the agent. Merged across layers rather than picked, so
   * a preset can set the name and a project only the address.
   */
  const git = layers.reduce(
    (acc, layer) => (isPlainObject(layer?.git) ? { ...acc, ...layer.git } : acc),
    {}
  );
  if ((git.name && !git.email) || (git.email && !git.name)) {
    throw new Error(
      `Commit identity needs both a name and an email; got ${JSON.stringify(git)}. ` +
        "Git refuses to commit with half of one."
    );
  }

  return {
    presetName,
    model: pick("model"),
    provider: pick("provider"),
    thinking: pick("thinking"),
    systemPrompt: promptSource.systemPrompt ?? null,
    // Appends stack across every layer instead of replacing each other.
    appendSystemPrompt: mergeLists("appendSystemPrompt"),
    tools: pick("tools"),
    excludeTools: pick("excludeTools"),
    readOnly,
    noTools: flagOf("noTools"),
    noBuiltinTools: flagOf("noBuiltinTools"),
    noExtensions: flagOf("noExtensions"),
    noSkills: flagOf("noSkills"),
    // Extra capabilities are additive across layers: a project can hand pi more
    // tools without a preset having to know about them.
    extensions: mergeLists("extensions"),
    skills: mergeLists("skills"),
    // Raw value; the caller normalizes it, because "docker" and a full sandbox
    // object have to resolve to the same thing.
    sandbox: pick("sandbox"),
    git: git.name ? git : null,
    // Mounts named outside the sandbox descriptor: a preset or a `--mount` flag
    // adding one directory to whatever profile the run ended up with, without
    // having to restate the profile.
    mounts: mergeLists("mounts"),
    engine: pick("engine") ?? "rpc",
    timeoutMs: Number(pick("timeoutMs") ?? BUILT_IN.defaults.timeoutMs)
  };
}

export { BUILT_IN as BUILT_IN_CONFIG };
