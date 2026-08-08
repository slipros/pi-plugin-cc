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
 */

export const USER_CONFIG_RELATIVE = path.join(".claude", "pi", "config.json");
export const PROJECT_CONFIG_RELATIVE = path.join(".claude", "pi", "config.json");

const BUILT_IN = {
  defaults: {
    model: null,
    provider: null,
    thinking: null,
    systemPrompt: null,
    timeoutMs: 1_800_000
  },
  presets: {},
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

function mergeLayer(base, layer) {
  if (!isPlainObject(layer)) {
    return base;
  }
  return {
    defaults: { ...base.defaults, ...(isPlainObject(layer.defaults) ? layer.defaults : {}) },
    presets: { ...base.presets, ...(isPlainObject(layer.presets) ? layer.presets : {}) },
    commands: {
      ...base.commands,
      ...Object.fromEntries(
        Object.entries(isPlainObject(layer.commands) ? layer.commands : {}).map(([name, value]) => [
          name,
          { ...(base.commands[name] ?? {}), ...(isPlainObject(value) ? value : {}) }
        ])
      )
    },
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
      config = mergeLayer(config, value);
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
  const mergeLists = (key) =>
    layers.flatMap((layer) => (Array.isArray(layer?.[key]) ? layer[key] : []));

  const readOnly = flagOf("readOnly");

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
    engine: pick("engine") ?? "rpc",
    timeoutMs: Number(pick("timeoutMs") ?? BUILT_IN.defaults.timeoutMs)
  };
}

export { BUILT_IN as BUILT_IN_CONFIG };
