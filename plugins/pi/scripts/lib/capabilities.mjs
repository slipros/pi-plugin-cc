import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveRunSettings } from "./config.mjs";
import { isSandboxed, normalizeSandbox, sandboxMountGaps } from "./sandbox.mjs";

/**
 * What an agent can do beyond what its model can do.
 *
 * "Which agent do I hand this to" is answered from `presets`, and some of the
 * answer does not live in the preset at all: a skill mounted by the sandbox
 * profile, a tool the read-only flag took away. Working that out by reading the
 * config is exactly the kind of thing a caller gets wrong once and then trusts
 * forever, so it is computed here from the same resolution the run uses.
 *
 * Computed, never declared. A hand-written `vision: true` on a preset survives
 * the mount being removed and keeps claiming a capability that is gone —
 * whereas a value derived from the resolved settings simply stops being true.
 * Hand-written `tags` stay for what cannot be derived: domain, cost, house
 * rules.
 */

/**
 * A skill directory with this name is what gives a text-only agent eyes.
 *
 * The convention is the whole contract: this file knows that a skill called
 * `vision` lets an agent look at an image, and nothing about how it does it —
 * which model answers, on whose machine, over which protocol. Swap the skill's
 * insides and this still holds.
 */
export const VISION_SKILL_NAME = "vision";

/** Tools a preset needs before any skill that shells out can help it. */
const SHELL_TOOL = "bash";

function asList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Can this agent run a shell command?
 *
 * A skill is a directory of instructions plus scripts; without a shell the
 * agent can read the instructions and do nothing about them. `coverage-auditor`
 * is the deliberate case — blind by allow-list — and it should not be offered
 * as an agent that can look at a screenshot.
 */
export function hasShell(settings) {
  if (settings.noTools || settings.readOnly) {
    return false;
  }
  const excluded = asList(settings.excludeTools);
  if (excluded.includes(SHELL_TOOL)) {
    return false;
  }
  const allowed = asList(settings.tools);
  return allowed.length ? allowed.includes(SHELL_TOOL) : true;
}

/**
 * The skills a run would actually get, container paths and host paths alike.
 *
 * Sandboxed runs see only what the profile mounts — the host's skill directory
 * does not travel — so the two cases are answered from different places, and
 * conflating them is how a preset gets credited with a skill it cannot open.
 */
export function resolvedSkills(settings, config, { homeDir = os.homedir() } = {}) {
  if (settings.noSkills) {
    return [];
  }
  const sandbox = normalizeSandbox(settings.sandbox, config.sandboxProfiles ?? {});
  const named = [...(settings.skills ?? [])];
  if (isSandboxed(sandbox)) {
    return [...(sandbox.skills ?? []), ...named];
  }
  // Outside a sandbox pi discovers the host's own skill directory, which no
  // config lists. Reading it here keeps the answer honest for `--sandbox none`
  // runs; a missing directory simply contributes nothing.
  const hostSkills = path.join(homeDir, ".pi", "agent", "skills");
  let discovered = [];
  try {
    discovered = fs
      .readdirSync(hostSkills, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(hostSkills, entry.name));
  } catch {
    discovered = [];
  }
  return [...discovered, ...named];
}

function hasSkillNamed(skills, name) {
  return skills.some((entry) => path.basename(String(entry).replace(/\/+$/, "")) === name);
}

/**
 * One preset's capabilities, as the run would resolve them.
 *
 * `vision` is deliberately three-valued rather than a boolean: "the model takes
 * images" and "the agent can ask a vision model on its behalf" are different
 * costs and different failure modes, and a caller choosing between agents wants
 * to see which one it is getting. Whether the model itself accepts images is
 * not answered here — that needs the model catalogue, which `presets` refuses
 * to walk on purpose.
 */
export function presetCapabilities(config, presetName, { homeDir = os.homedir() } = {}) {
  const preset = config.presets?.[presetName] ?? {};
  const tags = asList(preset.tags);
  let settings;
  try {
    settings = resolveRunSettings(config, "delegate", { preset: presetName });
  } catch {
    // A preset that cannot be resolved cannot be described. The command that
    // runs it will report the reason; here it is simply an agent with no
    // computed capabilities.
    return { vision: null, shell: false, tags, skills: [], mountGaps: [] };
  }
  const skills = resolvedSkills(settings, config, { homeDir });
  const shell = hasShell(settings);
  // Equipment named by the preset that the container will not have. Listed here
  // so the answer is visible where agents are CHOSEN, not only when one is
  // launched: the run itself refuses, but by then a wave is already half issued.
  const sandbox = normalizeSandbox(settings.sandbox, config.sandboxProfiles ?? {});
  const mountGaps = sandboxMountGaps(sandbox, {
    workspaceRoot: process.cwd(),
    extensions: settings.extensions ?? [],
    skills: settings.noSkills ? [] : (skills ?? [])
  }).map(({ value }) => value);
  return {
    vision: hasSkillNamed(skills, VISION_SKILL_NAME) && shell ? "skill" : null,
    shell,
    tags,
    skills,
    mountGaps
  };
}

/** Capabilities for every configured preset, keyed by name. */
export function allPresetCapabilities(config, options = {}) {
  const names = Object.keys(config.presets ?? {});
  return Object.fromEntries(names.map((name) => [name, presetCapabilities(config, name, options)]));
}
