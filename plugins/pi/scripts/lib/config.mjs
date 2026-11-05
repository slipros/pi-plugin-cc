import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeBudget } from "./budget.mjs";
import { DEFAULT_CACHE_TTL } from "./sessions.mjs";

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
  // Named slot pools: `{"ollama-pro": 3}` means every preset whose selected
  // model's record sits in that pool draws from the same three slots. Optional
  // — a profile can also cap itself with `maxConcurrent` and share nothing.
  // A pool may also be a full object: `{limit, priority, models}` —
  // the models being an array of records `{id, provider, name,
  // samplingParams?, thinking?, tags?}` with globally unique ids, so a preset
  // lists model ids instead of restating model/thinking per provider. The pool
  // a model belongs to is where its record sits; the preset never names pools.
  concurrencyPools: {},
  // How long a run is willing to wait for a busy pool before moving on to the
  // next variant of the same role; 0 means "only a pool free right now".
  poolWaitMs: 30_000,
  // How long a pool proven dead stays out of the choice, per failure class.
  // Balance: an hour — money can arrive at any moment, a day of idle capacity
  // buys nothing. Quota: a day, unless the provider names its own window (then
  // the named span wins). Network: the first hold, doubled on consecutive
  // failures up to ten times this value (30s → 60s → 120s → 300s by default).
  poolCooldownBalanceMs: 3_600_000,
  poolCooldownQuotaMs: 86_400_000,
  poolCooldownNetworkMs: 30_000,
  // How long a provider is assumed to keep a cached prompt. A continued
  // session replays its whole history: inside this window the provider reads
  // it from cache, past it the same tokens are billed again at the input rate.
  // `{"default": "40m", "providers": {"anthropic": "5m"}}` — see `sessions.mjs`.
  cacheTtl: { default: DEFAULT_CACHE_TTL, providers: {} },
  // Forges a sandboxed run may fetch from, keyed by host. The credential stays
  // on the host and the container is given a run token instead; see
  // `git-proxy.mjs`.
  gitProxy: {},
  commands: {
    delegate: {},
    review: { systemPrompt: "reviewer", readOnly: true }
  }
};

/**
 * Turn one of the three owner-form blocks (`sandboxServices`,
 * `concurrencyPools`, `presets`) from an array into a map keyed by the entry's
 * own `id`/`pool` field, preserving order (a JS object keeps insertion order).
 *
 * The map is what every consumer downstream already reads, and the conversion
 * has to happen BEFORE config layers merge: `mergeConfigLayer` merges named
 * blocks entry by entry, so an array handed to it as-is would replace the
 * whole block and a project layer adding one pool would wipe the user's.
 * A duplicate key is a refusal, not "last one wins" — two pools answering to
 * one name is a config bug the owner has to see spelled out.
 */
function normalizeNamedArray(entries, block, keyField) {
  const map = {};
  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      throw new Error(`${block} entry must be an object, got ${JSON.stringify(entry) ?? "undefined"}.`);
    }
    const key = entry[keyField];
    if (typeof key !== "string" || !key.trim()) {
      throw new Error(`${block} entry needs a non-empty "${keyField}", got ${JSON.stringify(key ?? null)}.`);
    }
    if (map[key]) {
      throw new Error(`Duplicate ${keyField} "${key}" in "${block}". Names must be unique within the block.`);
    }
    map[key] = entry;
  }
  return map;
}

/**
 * Fields of the cancelled intermediate form. Keeping them as a second accepted
 * spelling would leave two ways to say one thing, and the two drift — the
 * exact failure this form exists to remove. A config carrying one is refused
 * with the new spelling named, so migration is mechanical.
 */
function refuseRemovedField(where, field, instead) {
  throw new Error(`${where} uses the removed "${field}" field. ${instead}`);
}

/**
 * Read one model record of a pool's `models` array.
 *
 * A model is an entity with a globally unique `id` and the `provider`+`name`
 * pair pi is addressed with (`provider/name`). Two ids may share one `name`
 * and differ only in `samplingParams` — that is how a production and a debug
 * variant of the same vLLM coexist.
 */
function normalizePoolModel(entry, poolName, index) {
  const where = `Model #${index} of pool "${poolName}"`;
  if (!isPlainObject(entry)) {
    throw new Error(`${where} must be an object, got ${JSON.stringify(entry) ?? "undefined"}.`);
  }
  if (typeof entry.id !== "string" || !entry.id.trim()) {
    throw new Error(`${where} needs a non-empty "id".`);
  }
  if (!entry.provider || !entry.name) {
    throw new Error(
      `Model "${entry.id}" of pool "${poolName}" needs "provider" and "name" — the pair pi is addressed with as provider/name.`
    );
  }
  return entry;
}

function normalizePreset(preset, name) {
  if (!isPlainObject(preset)) {
    return preset;
  }
  if (preset.pools !== undefined) {
    refuseRemovedField(
      `Preset "${name}"`,
      "pools",
      'List model ids in preference order under "models" instead; the pool each model belongs to is where its record sits.'
    );
  }
  if (preset.requires !== undefined) {
    refuseRemovedField(
      `Preset "${name}"`,
      "requires",
      'Name one sandbox for the role with "sandboxService"; the pool of the selected model provides the slots.'
    );
  }

  if (preset.models !== undefined && !Array.isArray(preset.models)) {
    throw new Error(`Preset "${name}" has "models" that is not an array of model ids.`);
  }
  if (preset.sandboxService !== undefined) {
    // The preset's sandbox is a single named service, not per-provider halves.
    // Translated to the field every consumer already reads (capability reports,
    // `--sandbox` overrides, slot accounting) so there is no second path.
    //
    // An object form carries the role's own additions (its pi-hook env set,
    // GIT_CONFIG_*): `{"id": "agent", "env": [...]}` means "the agent service
    // plus this env", not a service redefinition — exactly how an object
    // `sandbox: {profile, env}` has always merged. Folding it into that shape
    // reuses the additive merge instead of opening a second one.
    const service = preset.sandboxService;
    if (typeof service === "string") {
      const translated = { ...preset, sandbox: service };
      delete translated.sandboxService;
      return translated;
    }
    if (!isPlainObject(service) || typeof service.id !== "string" || !service.id.trim()) {
      throw new Error(
        `Preset "${name}" has "sandboxService" that is neither a service id nor an object with a string "id", ` +
          `got ${JSON.stringify(service ?? null)}.`
      );
    }
    const { id, ...extras } = service;
    const translated = { ...preset, sandbox: { profile: id, ...extras } };
    delete translated.sandboxService;
    return translated;
  }
  return preset;
}

/**
 * Accept the owner-form arrays alongside the historical maps.
 *
 * `sandboxServices` and `sandboxProfiles` share one namespace (a service is
 * the newer spelling of a profile, `extend` its word for `profile`), with the
 * service winning a name collision — it is the more specific spelling. Pools
 * keep the historical number-of-slots map untouched and gain the array form.
 */
/**
 * Timings that steer pool waiting and cooldowns reach the run as milliseconds
 * through `Number()`. A spelling like `"30s"` normalizes to NaN there: the run
 * then camps on a busy pool forever, and a `RangeError: Invalid time value`
 * after the run masks the original failure. Same rule as a pool's "limit": a
 * non-finite or negative value is refused with the field named, never silently
 * defaulted.
 */
function refuseBadPoolTiming(layer) {
  for (const field of ["poolWaitMs", "poolCooldownBalanceMs", "poolCooldownQuotaMs", "poolCooldownNetworkMs"]) {
    if (layer[field] === undefined) {
      continue;
    }
    const ms = Number(layer[field]);
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(
        `Config field "${field}" must be a non-negative number of milliseconds, got ${JSON.stringify(layer[field])}.`
      );
    }
  }
}

export function normalizeConfigLayer(layer) {
  if (!isPlainObject(layer)) {
    return layer;
  }
  refuseBadPoolTiming(layer);
  const clean = { ...layer };

  if (Array.isArray(clean.sandboxServices)) {
    const profiles = isPlainObject(clean.sandboxProfiles) ? clean.sandboxProfiles : {};
    const merged = { ...profiles };
    for (const service of Object.values(normalizeNamedArray(clean.sandboxServices, "sandboxServices", "id"))) {
      const profile = { ...service };
      delete profile.id;
      if (profile.extend != null) {
        profile.profile = profile.extend;
        delete profile.extend;
      }
      merged[service.id] = profile;
    }
    clean.sandboxProfiles = merged;
    delete clean.sandboxServices;
  }


  if (Array.isArray(clean.concurrencyPools)) {
    clean.concurrencyPools = normalizeNamedArray(clean.concurrencyPools, "concurrencyPools", "pool");
  }
  if (isPlainObject(clean.concurrencyPools)) {
    const pools = {};
    for (const [name, pool] of Object.entries(clean.concurrencyPools)) {
      pools[name] = normalizeConcurrencyPool(pool, name);
    }
    clean.concurrencyPools = pools;
  }

  if (Array.isArray(clean.presets)) {
    clean.presets = normalizeNamedArray(clean.presets, "presets", "id");
  }
  if (isPlainObject(clean.presets)) {
    const presets = {};
    for (const [name, preset] of Object.entries(clean.presets)) {
      presets[name] = normalizePreset(preset, name);
    }
    clean.presets = presets;
  }
  return clean;
}

/**
 * Refuse the removed `concurrencyGroup` field on a normalized layer.
 *
 * Lives outside `normalizeConfigLayer` on purpose: the migrator
 * (`migrate-config.mjs`) reads the OLD form and reuses the normalizer, so a
 * refusal there would break migration of other machines' configs. This check
 * runs only on the plugin's own config load, where the field can no longer
 * mean anything — and refuses instead of ignoring, because a silently ignored
 * field leaves a config that looks tuned and does not work.
 */
export function refuseRemovedConcurrencyGroup(layer) {
  if (!isPlainObject(layer)) {
    return;
  }
  for (const [name, profile] of Object.entries(layer.sandboxProfiles ?? {})) {
    if (isPlainObject(profile) && profile.concurrencyGroup !== undefined) {
      refuseRemovedField(
        `Sandbox profile "${name}"`,
        "concurrencyGroup",
        'The pool is determined by the selected model\'s entry in "concurrencyPools" — remove the field.'
      );
    }
  }
  for (const [name, preset] of Object.entries(layer.presets ?? {})) {
    if (!isPlainObject(preset)) {
      continue;
    }
    if (preset.concurrencyGroup !== undefined) {
      refuseRemovedField(
        `Preset "${preset.id ?? name}"`,
        "concurrencyGroup",
        'The pool is determined by the selected model\'s entry in "concurrencyPools" — list model ids under "models" and remove the field.'
      );
    }
    // The object sandbox (`{profile, env, …}`) carries per-role extras, and the
    // removed field used to be read from exactly that normalized object — so
    // refusing only the preset-level spelling would let a config that looks
    // tuned lose its pool limit silently. `sandboxService` folds into the same
    // object (its extras become sandbox fields), hence the second check.
    const objectSandbox =
      isPlainObject(preset.sandbox) ? preset.sandbox : isPlainObject(preset.sandboxService) ? preset.sandboxService : null;
    if (objectSandbox && objectSandbox.concurrencyGroup !== undefined) {
      refuseRemovedField(
        `Preset "${preset.id ?? name}" (sandbox)`,
        "concurrencyGroup",
        'The pool is determined by the selected model\'s entry in "concurrencyPools" — remove the field from the sandbox.'
      );
    }
  }
  const defaults = layer.defaults;
  if (isPlainObject(defaults) && isPlainObject(defaults.sandbox) && defaults.sandbox.concurrencyGroup !== undefined) {
    refuseRemovedField(
      'defaults (sandbox)',
      "concurrencyGroup",
      'The pool is determined by the selected model\'s entry in "concurrencyPools" — remove the field from the sandbox.'
    );
  }
}

/**
 * Read one `concurrencyPools` entry.
 *
 * The historical shape is a bare number of slots; it still reads as `{limit}`.
 * A full pool object carries the same limit, a `priority` (BIGGER runs earlier
 * — the number is a rank the way people write it, 10 beating 1) and the model
 * registry under `models` — an array of records keyed by their globally unique
 * `id`.
 */
export function normalizeConcurrencyPool(value, name = "pool") {
  if (typeof value === "number") {
    return { limit: value };
  }
  if (!isPlainObject(value)) {
    throw new Error(
      `Concurrency pool "${name}" must be a number of slots or an object with a "limit", got ${JSON.stringify(value) ?? "undefined"}.`
    );
  }
  const limit = Number(value.limit);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`Concurrency pool "${name}" needs a positive "limit", got ${JSON.stringify(value.limit ?? null)}.`);
  }
  if (value.priority !== undefined) {
    const priority = Number(value.priority);
    if (!Number.isFinite(priority)) {
      throw new Error(
        `Concurrency pool "${name}" needs a finite numeric "priority", got ${JSON.stringify(value.priority)}.`
      );
    }
  }
  if (value.aliases !== undefined) {
    refuseRemovedField(
      `Pool "${name}"`,
      "aliases",
      'A preset is pinned by the pool\'s own name ("<role>-vllm"); `*-local` spellings are gone — address the pool as it is named.'
    );
  }
  if (value.default !== undefined) {
    refuseRemovedField(
      `Pool "${name}"`,
      "default",
      "A preset lists model ids in the order it prefers them; there is no per-pool default to fall back to."
    );
  }
  if (value.sandbox !== undefined) {
    refuseRemovedField(
      `Pool "${name}"`,
      "sandbox",
      'The sandbox belongs to the preset ("sandboxService"); the pool of the selected model provides the slots.'
    );
  }
  if (value.models !== undefined) {
    if (!Array.isArray(value.models)) {
      refuseRemovedField(
        `Pool "${name}"`,
        "models",
        'Use the array form: [{"id": …, "provider": …, "name": …}, …]. Named variant maps are gone.'
      );
    }
    const models = {};
    value.models.forEach((entry, index) => {
      const model = normalizePoolModel(entry, name, index);
      if (models[model.id]) {
        throw new Error(`Duplicate model id "${model.id}" in pool "${name}". Model ids are globally unique.`);
      }
      models[model.id] = model;
    });
    return { ...value, models };
  }
  return value;
}

/**
 * Find a preset by name, or by its historical `<role>-<pool>` alias.
 *
 * The old compound names are contracts with the skills of a neighbouring
 * repository — briefs, hooks and texts spell them out — so `python-developer-zai`
 * keeps working: when the exact name is unknown, the tail after the last dash
 * is read as a pool pin on the role preset that lists that pool.
 */
export function resolvePresetReference(config, name) {
  const presets = config.presets ?? {};
  if (presets[name]) {
    return { preset: presets[name], presetName: name, requestedName: name, poolPin: null };
  }
  // Pool names may contain dashes themselves, so the split point is not the
  // last dash: match "<preset>-<tail>" against what the role's model list
  // implies. The tail names the pool itself (`go-developer-zai` → pool `zai`)
  // or a model id of the preset — the pinned pool is whichever of the two
  // answers. Pool `aliases` are gone: one pool answered to two names, and the
  // `*-local` spelling died with them.
  const pools = config.concurrencyPools ?? {};
  for (const [base, preset] of Object.entries(presets)) {
    if (!preset || !Array.isArray(preset.models) || !name.startsWith(`${base}-`)) {
      continue;
    }
    const tail = name.slice(base.length + 1);
    let pin = null;
    if (pools[tail] != null) {
      pin = tail;
    }
    if (!pin && preset.models.includes(tail)) {
      pin = poolOfModel(pools, tail);
    }
    if (pin) {
      return { preset, presetName: base, requestedName: name, poolPin: pin };
    }
  }
  return null;
}

/** Which pool holds the model with this id, or null. */
function poolOfModel(pools, id) {
  for (const [poolName, pool] of Object.entries(pools)) {
    if (isPlainObject(pool) && isPlainObject(pool.models) && pool.models[id]) {
      return poolName;
    }
  }
  return null;
}

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
/**
 * Fields that are an argv rather than a set. Docker reads repeatable flags
 * (`--security-opt`, `--device`, `--cap-add`) by position, so folding two
 * identical flag tokens into one leaves the orphaned value standing where the
 * image name belongs — the daemon then answers "invalid reference format",
 * naming neither the flag nor the profile it came from. Duplicates are the
 * caller's business: docker lets the last occurrence of a single-valued flag win.
 */
const POSITIONAL_KEYS = new Set(["args"]);

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
  if (POSITIONAL_KEYS.has(key)) {
    return [...base, ...layer];
  }
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
    concurrencyPools: { ...base.concurrencyPools, ...(isPlainObject(layer.concurrencyPools) ? layer.concurrencyPools : {}) },
    poolWaitMs: layer.poolWaitMs ?? base.poolWaitMs,
    poolCooldownBalanceMs: layer.poolCooldownBalanceMs ?? base.poolCooldownBalanceMs,
    poolCooldownQuotaMs: layer.poolCooldownQuotaMs ?? base.poolCooldownQuotaMs,
    poolCooldownNetworkMs: layer.poolCooldownNetworkMs ?? base.poolCooldownNetworkMs,
    cacheTtl: mergeEntry(base.cacheTtl ?? {}, isPlainObject(layer.cacheTtl) ? layer.cacheTtl : {}),
    gitProxy: mergeNamed(base.gitProxy ?? {}, layer.gitProxy),
    commands: mergeNamed(base.commands, layer.commands)
  };
}

/**
 * Settings a repository must not be able to choose for the machine it is
 * checked out on.
 *
 * The project layer is read from the workspace — the same directory a sandboxed
 * agent has write access to, and the same directory that arrives with an
 * untrusted repository. Every key here weakens the boundary the sandbox exists
 * to draw: turning it off, mounting the host into it, running as root, or
 * putting the agent directory (sessions, credentials) back on the host. A repo
 * may still describe its own model, prompts and toolchain — that is what the
 * project layer is for.
 */
const PROJECT_FORBIDDEN_SANDBOX_KEYS = [
  "args",
  "mounts",
  "agentDir",
  "user",
  "image",
  "auth",
  "network",
  // `{"mode": "none"}` disables the sandbox exactly like the string form does.
  "mode",
  "env",
  "proxyCredentials",
  // Which forges the run may reach at all: a repository choosing this would be
  // widening its own network boundary.
  "gitProxy",
  // Both decide whether this run shares state with the next one. `volume` names
  // the agent directory an untrusted repository would otherwise put back on the
  // shared one, and `isolateCaches` is the switch that separates them at all.
  "volume",
  "isolateCaches",
  // Since the preset-pools work `samplingParams` travels from the resolved
  // sandbox into every paid request body (`pi.mjs`/`rpc.mjs` → the credential
  // proxy). Before that it only came from the owner's model registry, so a
  // repository able to set it would be setting its own price ceiling — say,
  // `max_tokens` in the millions — on the owner's account.
  "samplingParams"
];

function sanitizeUntrustedEntry(entry, path, warnings) {
  if (!isPlainObject(entry)) {
    return entry;
  }
  const clean = { ...entry };

  if ("mounts" in clean) {
    warnings.push(`${path}.mounts ignored: the project config cannot mount host directories.`);
    delete clean.mounts;
  }

  if ("env" in clean) {
    // A bare NAME forwards the host's value into a container the repository
    // controls, so the repository would be choosing which host variables leak.
    warnings.push(`${path}.env ignored: the project config cannot pass host environment into the container.`);
    delete clean.env;
  }

  if ("onFinish" in clean) {
    // The hook runs on the host, outside the container, with the caller's own
    // permissions — the exact thing the sandbox exists to prevent. Worse, the
    // agent inside the sandbox can write `.claude/pi/config.json` through the
    // mounted workspace, so without this a run could hand itself host execution
    // on the *next* run.
    warnings.push(`${path}.onFinish ignored: the project config cannot run commands on the host.`);
    delete clean.onFinish;
  }

  if ("sandbox" in clean) {
    const sandbox = clean.sandbox;
    const disables =
      sandbox == null ||
      sandbox === false ||
      (typeof sandbox === "string" && /^(none|off|false|no)$/i.test(sandbox.trim())) ||
      (isPlainObject(sandbox) && typeof sandbox.mode === "string" && /^(none|off|false|no)$/i.test(sandbox.mode.trim()));
    if (disables) {
      warnings.push(`${path}.sandbox ignored: the project config cannot turn the sandbox off.`);
      delete clean.sandbox;
    } else if (isPlainObject(sandbox)) {
      const cleanSandbox = { ...sandbox };
      for (const key of PROJECT_FORBIDDEN_SANDBOX_KEYS) {
        if (key in cleanSandbox) {
          warnings.push(`${path}.sandbox.${key} ignored: the project config cannot change container isolation.`);
          delete cleanSandbox[key];
        }
      }
      clean.sandbox = cleanSandbox;
    }
  }

  return clean;
}

/**
 * Strip the keys a workspace is not allowed to decide for its host.
 *
 * Skipped entirely when the user has marked the workspace as trusted, which is
 * the normal case for one's own repositories.
 */
/**
 * Keys a repository never gets to set, however much the workspace is trusted.
 *
 * Trust says "the code in this checkout is mine", which is a statement about the
 * code — not a grant of host execution to whoever writes a file in it. And the
 * one who writes files in it is, among others, a sandboxed agent: the workspace
 * is mounted read-write, so anything the project layer may decide is decided by
 * a process the sandbox exists to contain. `onFinish` runs a command on the
 * host, and `gitProxy.tokenCommand` is executed on the host to fetch a secret —
 * both are host execution reachable from inside the container, one run later.
 *
 * The rest of the project layer survives: a repository still describes its model,
 * prompts, toolchain and — through `gitProxy` entries without `tokenCommand` —
 * which of the host's already-configured forges it needs.
 */
function stripHostExecution(layer, warnings = []) {
  if (!isPlainObject(layer)) {
    return layer;
  }
  const clean = { ...layer };

  if (isPlainObject(clean.defaults) && "onFinish" in clean.defaults) {
    warnings.push("defaults.onFinish ignored: a checkout cannot run commands on the host, trusted or not.");
    clean.defaults = { ...clean.defaults, onFinish: undefined };
    delete clean.defaults.onFinish;
  }
  for (const section of ["presets", "commands"]) {
    if (!isPlainObject(clean[section])) {
      continue;
    }
    const entries = {};
    for (const [name, entry] of Object.entries(clean[section])) {
      if (isPlainObject(entry) && "onFinish" in entry) {
        warnings.push(`${section}.${name}.onFinish ignored: a checkout cannot run commands on the host, trusted or not.`);
        const stripped = { ...entry };
        delete stripped.onFinish;
        entries[name] = stripped;
        continue;
      }
      entries[name] = entry;
    }
    clean[section] = entries;
  }

  if (isPlainObject(clean.gitProxy)) {
    const hosts = {};
    for (const [host, spec] of Object.entries(clean.gitProxy)) {
      if (isPlainObject(spec) && "tokenCommand" in spec) {
        warnings.push(`gitProxy.${host}.tokenCommand ignored: a checkout cannot name a command the host will run.`);
        const stripped = { ...spec };
        delete stripped.tokenCommand;
        hosts[host] = stripped;
        continue;
      }
      hosts[host] = spec;
    }
    clean.gitProxy = hosts;
  }

  return clean;
}

export function sanitizeProjectLayer(layer, warnings = []) {
  if (!isPlainObject(layer)) {
    return layer;
  }
  const clean = { ...layer };

  if ("gitProxy" in clean) {
    // Its entries name a forge and how to obtain a credential for it, and
    // `tokenCommand` is executed on the host. A checkout describing that would
    // be choosing both what the run may reach and what runs outside the
    // container.
    warnings.push("gitProxy ignored: the project config cannot describe host credentials.");
    delete clean.gitProxy;
  }

  if (isPlainObject(clean.concurrencyPools)) {
    // A model record carries the provider the run authenticates against, so a
    // project layer restating or adding models of a pool the host defines
    // would be choosing whose endpoint the fleet's presets hit. Limits and
    // priority are capacity, not identity: a project may still throttle or
    // deprioritize a pool, it just cannot point its models anywhere.
    const pools = {};
    for (const [name, pool] of Object.entries(clean.concurrencyPools)) {
      if (isPlainObject(pool) && pool.models !== undefined) {
        warnings.push(`concurrencyPools.${name}.models ignored: the project config cannot point a pool's models at a provider.`);
        const { models, ...rest } = pool;
        pools[name] = rest;
        continue;
      }
      pools[name] = pool;
    }
    clean.concurrencyPools = pools;
  }

  // These decide how fast a pool the run killed comes back to life and how
  // long a run camps on a busy one. They are top-level, not sandbox keys, but
  // `mergeConfigLayer` reads them from the project layer all the same — a
  // repository shortening its own cooldowns could keep re-triggering a dead
  // provider on every run of the fleet.
  for (const key of ["poolWaitMs", "poolCooldownBalanceMs", "poolCooldownQuotaMs", "poolCooldownNetworkMs"]) {
    if (key in clean) {
      warnings.push(`${key} ignored: the project config cannot tune pool cooldowns and waits.`);
      delete clean[key];
    }
  }

  if (isPlainObject(clean.defaults)) {
    clean.defaults = sanitizeUntrustedEntry(clean.defaults, "defaults", warnings);
  }
  for (const section of ["presets", "sandboxProfiles", "commands"]) {
    if (!isPlainObject(clean[section])) {
      continue;
    }
    const entries = {};
    for (const [name, entry] of Object.entries(clean[section])) {
      if (section === "sandboxProfiles") {
        const checked = sanitizeUntrustedEntry({ sandbox: entry }, `${section}.${name}`, warnings);
        // A profile the sanitizer rejected outright is dropped, not restored:
        // `?? entry` used to hand the original value straight back, so a profile
        // of "none" printed a warning and disabled the sandbox anyway.
        if ("sandbox" in checked) {
          entries[name] = checked.sandbox;
        }
        continue;
      }
      entries[name] = sanitizeUntrustedEntry(entry, `${section}.${name}`, warnings);
    }
    clean[section] = entries;
  }
  return clean;
}

/**
 * Whether the user has vouched for this workspace.
 *
 * Two things hang off this answer: whether the project layer is read as written
 * (below) and whether the run shares build caches and an agent directory with
 * every other run (`sandbox.mjs`). Both ask the same question — is the code in
 * this checkout allowed to affect the next run — so both read the same list.
 * Entries match by prefix, so `~/github` vouches for everything under it.
 */
function isTrustedWorkspace(userLayer, workspaceRoot) {
  if (userLayer?.trustProjectConfig === true) {
    return true;
  }
  const trusted = Array.isArray(userLayer?.trustedProjects) ? userLayer.trustedProjects : [];
  const target = path.resolve(workspaceRoot ?? ".");
  return trusted.some((entry) => {
    const root = path.resolve(String(entry).replace(/^~(?=\/|$)/, os.homedir()));
    return target === root || target.startsWith(`${root}${path.sep}`);
  });
}

/**
 * The same question asked about a directory the caller names.
 *
 * The run root is not always the workspace — `--cwd` points the agent at another
 * tree, and it is that tree's code which decides whether sharing a build cache
 * is safe. Reads the user layer itself so the answer never depends on which
 * directory the config happened to be loaded for.
 */
export function workspaceIsTrusted(workspaceRoot) {
  return isTrustedWorkspace(readJsonFile(userConfigPath()).value, workspaceRoot);
}

/**
 * @returns {{ config: object, sources: string[], errors: string[], warnings: string[] }}
 */
export function loadConfig(workspaceRoot) {
  const sources = [];
  const errors = [];
  const warnings = [];
  let config = BUILT_IN;

  const user = readJsonFile(userConfigPath());
  if (user.error) {
    errors.push(user.error);
  }
  if (user.value) {
    sources.push(userConfigPath());
    // Owner-form arrays become maps before any merging: `mergeConfigLayer`
    // merges named blocks entry by entry, and an array would replace the block
    // whole — a project layer adding one pool would wipe the user's.
        refuseRemovedConcurrencyGroup(user.value);
    config = mergeConfigLayer(config, normalizeConfigLayer(user.value));
  }

  const trusted = isTrustedWorkspace(user.value, workspaceRoot);

  const project = readJsonFile(projectConfigPath(workspaceRoot));
  if (project.error) {
    errors.push(project.error);
  }
  if (project.value) {
    sources.push(projectConfigPath(workspaceRoot));
    // Normalized first: the sanitizer walks maps (`sandboxProfiles`,
    // `concurrencyPools`), and a raw owner-form array would slip past it —
    // exactly the mounts a service names would then reach docker untouched.
        refuseRemovedConcurrencyGroup(project.value);
    const normalized = normalizeConfigLayer(project.value);
    const layer = trusted ? stripHostExecution(normalized, warnings) : sanitizeProjectLayer(normalized, warnings);
    config = mergeConfigLayer(config, layer);
  }

  return { config, sources, errors, warnings };
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
  const requestedPreset = overrides.preset ?? commandDefaults.preset ?? null;
  let presetName = requestedPreset;
  let preset = {};

  let requestedName = presetName;
  let poolPin = null;
  if (presetName) {
    const reference = resolvePresetReference(config, presetName);
    if (!reference) {
      const available = Object.keys(config.presets ?? {});
      throw new Error(
        available.length
          ? `Unknown preset "${presetName}". Available presets: ${available.join(", ")}.`
          : `Unknown preset "${presetName}". No presets are configured; add one to ${userConfigPath()}.`
      );
    }
    preset = reference.preset;
    presetName = reference.presetName;
    requestedName = reference.requestedName;
    poolPin = reference.poolPin;
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
    // What the caller asked for, kept apart from what was resolved: `rerun`
    // repeats the request, while the job record shows the preset that ran.
    requestedPresetName: requestedName,
    presetPool: poolPin,
    model: pick("model"),
    provider: pick("provider"),
    thinking: pick("thinking"),
    // A model record's `thinking` overrides the preset's (that is how
    // `*-local` with `thinking: off` collapses into one preset with `*-zai`),
    // but a flag outranks both — so the source is carried, not re-derived.
    thinkingFromFlag: overrides.thinking != null,
    systemPrompt: promptSource.systemPrompt ?? null,
    // Appends stack across every layer instead of replacing each other.
    appendSystemPrompt: mergeLists("appendSystemPrompt"),
    tools: pick("tools"),
    excludeTools: pick("excludeTools"),
    readOnly,
    // Preset-level tags, additive across layers; a chosen model's own tags are
    // folded in at slot time, when the model is actually known.
    tags: mergeLists("tags"),
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
    // Runs on the host when the job ends. Only ever from the user layer or a
    // flag — `sanitizeUntrustedEntry` strips it from a project config.
    onFinish: pick("onFinish"),
    timeoutMs: Number(pick("timeoutMs") ?? BUILT_IN.defaults.timeoutMs),
    // Merged like `git` rather than picked: a preset can cap the cost while the
    // command line adds a turn limit, and neither erases the other.
    budget: normalizeBudget(
      layers.reduce((acc, layer) => (isPlainObject(layer?.budget) ? { ...acc, ...layer.budget } : acc), {})
    )
  };
}

export { BUILT_IN as BUILT_IN_CONFIG };
