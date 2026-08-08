import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * System-prompt resolution for delegated pi agents.
 *
 * There is exactly one knob: `systemPrompt`. Its value can be
 *   - inline text                       "answer in one sentence"
 *   - a file                            "@./prompts/dba.md" or "./prompts/dba.md"
 *   - the name of a stored prompt       "reviewer"
 *
 * Stored prompts are looked up in the project first, then the user's home,
 * then the ones shipped with the plugin, so a project file named
 * `reviewer.md` shadows the built-in reviewer.
 *
 * Precedence between layers (flags > preset > command > defaults) is resolved
 * in config.mjs; this module only turns the winning value into text.
 * `.claude/pi/SYSTEM.md` is the workspace fallback when nothing is set, and
 * appends never replace the base prompt.
 */

const PROMPT_FILE_EXTENSIONS = [".md", ".txt"];
const NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

function expandHome(value) {
  if (value.startsWith("~/") || value === "~") {
    return path.join(os.homedir(), value.slice(1));
  }
  return value;
}

function looksLikePath(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\n")) {
    return false;
  }
  return (
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~/") ||
    PROMPT_FILE_EXTENSIONS.some((extension) => trimmed.endsWith(extension))
  );
}

function readFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const text = fs.readFileSync(filePath, "utf8").trim();
    return text ? { text, source: filePath } : null;
  }
  return null;
}

/** Directories searched for named prompts, most specific first. */
export function promptSearchPath(pluginRoot, workspaceRoot) {
  return [
    path.join(workspaceRoot, ".claude", "pi", "prompts"),
    path.join(os.homedir(), ".claude", "pi", "prompts"),
    path.join(pluginRoot, "prompts", "system")
  ];
}

/**
 * List the prompts available by name, project and user files shadowing the
 * built-in ones.
 */
export function listNamedPrompts(pluginRoot, workspaceRoot) {
  const found = new Map();
  for (const dir of promptSearchPath(pluginRoot, workspaceRoot)) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const entry of fs.readdirSync(dir)) {
      if (!PROMPT_FILE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
        continue;
      }
      const name = entry.replace(/\.(md|txt)$/, "");
      if (!found.has(name)) {
        found.set(name, path.join(dir, entry));
      }
    }
  }
  return found;
}

function resolveNamedPrompt(name, { pluginRoot, workspaceRoot }) {
  for (const dir of promptSearchPath(pluginRoot, workspaceRoot)) {
    for (const extension of PROMPT_FILE_EXTENSIONS) {
      const file = readFileIfExists(path.join(dir, `${name}${extension}`));
      if (file) {
        return file;
      }
    }
  }
  return null;
}

/**
 * Turn one `systemPrompt` value into prompt text.
 *
 * @returns {{ text: string, source: string|null, name: string|null }}
 */
export function resolvePromptValue(value, { workspaceRoot, pluginRoot = null, label = "system prompt" }) {
  const raw = String(value ?? "");
  if (!raw.trim()) {
    return { text: "", source: null, name: null };
  }

  const trimmed = raw.trim();
  const forcedFile = trimmed.startsWith("@");
  const candidate = expandHome(forcedFile ? trimmed.slice(1) : trimmed);

  if (forcedFile || looksLikePath(trimmed)) {
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(workspaceRoot, candidate);
    const file = readFileIfExists(absolute);
    if (file) {
      return { ...file, name: null };
    }
    if (forcedFile) {
      throw new Error(`Cannot read ${label} file "${candidate}".`);
    }
  }

  if (pluginRoot && NAME_PATTERN.test(trimmed)) {
    const named = resolveNamedPrompt(trimmed, { pluginRoot, workspaceRoot });
    if (named) {
      return { ...named, name: trimmed };
    }
    const available = [...listNamedPrompts(pluginRoot, workspaceRoot).keys()].sort();
    throw new Error(
      `No system prompt named "${trimmed}". Available: ${available.join(", ") || "none"}. ` +
        `Pass inline text, @path/to/file.md, or add .claude/pi/prompts/${trimmed}.md.`
    );
  }

  return { text: trimmed, source: null, name: null };
}

/**
 * Build the final system-prompt configuration for a pi run.
 *
 * @returns {{ systemPrompt: string|null, appends: string[], sources: string[], name: string|null }}
 */
export function buildSystemPrompt({ pluginRoot, workspaceRoot, settings }) {
  const sources = [];
  let systemPrompt = null;
  let name = null;

  if (settings.systemPrompt) {
    const resolved = resolvePromptValue(settings.systemPrompt, { workspaceRoot, pluginRoot });
    systemPrompt = resolved.text;
    name = resolved.name;
    sources.push(
      resolved.name
        ? `system prompt "${resolved.name}": ${resolved.source}`
        : resolved.source
          ? `system prompt: ${resolved.source}`
          : "system prompt: inline text"
    );
  } else {
    const projectSystem = readFileIfExists(path.join(workspaceRoot, ".claude", "pi", "SYSTEM.md"));
    if (projectSystem) {
      systemPrompt = projectSystem.text;
      sources.push(`system prompt: ${projectSystem.source}`);
    }
  }

  const appends = [];
  for (const value of settings.appendSystemPrompt ?? []) {
    const resolved = resolvePromptValue(value, {
      workspaceRoot,
      pluginRoot,
      label: "appended system prompt"
    });
    if (resolved.text) {
      appends.push(resolved.text);
      sources.push(resolved.source ? `append: ${resolved.source}` : "append: inline text");
    }
  }

  const projectAppend = readFileIfExists(path.join(workspaceRoot, ".claude", "pi", "APPEND_SYSTEM.md"));
  if (projectAppend) {
    appends.push(projectAppend.text);
    sources.push(`append: ${projectAppend.source}`);
  }

  return { systemPrompt, appends, sources, name };
}

export function loadTaskTemplate(pluginRoot, name) {
  const filePath = path.join(pluginRoot, "prompts", "tasks", `${name}.md`);
  const file = readFileIfExists(filePath);
  if (!file) {
    throw new Error(`Missing task template "${name}" at ${filePath}.`);
  }
  return file.text;
}

export function interpolate(template, values) {
  return String(template).replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    const value = values[key];
    return value == null ? "" : String(value);
  });
}
