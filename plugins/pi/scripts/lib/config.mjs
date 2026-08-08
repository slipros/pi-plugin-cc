import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Plugin configuration: model presets, per-command defaults and custom roles.
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
    role: null,
    timeoutMs: 1_800_000
  },
  presets: {},
  commands: {
    delegate: {},
    review: { role: "reviewer", readOnly: true }
  },
  roles: {}
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
    roles: { ...base.roles, ...(isPlainObject(layer.roles) ? layer.roles : {}) }
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

  // Later layers win, so the list runs from lowest to highest priority.
  const readOnly = [commandDefaults, preset, overrides].reduce(
    (acc, layer) => (typeof layer?.readOnly === "boolean" ? layer.readOnly : acc),
    false
  );

  return {
    presetName,
    model: pick("model"),
    provider: pick("provider"),
    thinking: pick("thinking"),
    role: pick("role"),
    systemPrompt: pick("systemPrompt"),
    appendSystemPrompt: [
      ...(Array.isArray(commandDefaults.appendSystemPrompt) ? commandDefaults.appendSystemPrompt : []),
      ...(Array.isArray(preset.appendSystemPrompt) ? preset.appendSystemPrompt : []),
      ...(Array.isArray(overrides.appendSystemPrompt) ? overrides.appendSystemPrompt : [])
    ],
    tools: pick("tools"),
    excludeTools: pick("excludeTools"),
    readOnly,
    timeoutMs: Number(pick("timeoutMs") ?? BUILT_IN.defaults.timeoutMs)
  };
}

export { BUILT_IN as BUILT_IN_CONFIG };
