import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * System-prompt resolution for delegated pi agents.
 *
 * Precedence, highest first:
 *   1. --system-prompt <text|file>
 *   2. --role <name>            (built-in role file, project role, or config.roles entry)
 *   3. <workspace>/.claude/pi/SYSTEM.md
 *   4. nothing — pi keeps its own default coding-assistant prompt
 *
 * --append-system-prompt values and <workspace>/.claude/pi/APPEND_SYSTEM.md are
 * additive and never replace the base prompt.
 */

const ROLE_FILE_EXTENSIONS = [".md", ".txt"];

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
    trimmed.startsWith("@") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~/") ||
    ROLE_FILE_EXTENSIONS.some((extension) => trimmed.endsWith(extension))
  );
}

/**
 * Interpret a CLI value as either inline prompt text or a file reference.
 * `@path` forces the file interpretation.
 */
export function resolvePromptValue(value, { workspaceRoot, label = "prompt" }) {
  const raw = String(value ?? "");
  if (!raw.trim()) {
    return { text: "", source: null };
  }

  const forced = raw.trim().startsWith("@");
  const candidate = expandHome(forced ? raw.trim().slice(1) : raw.trim());

  if (forced || looksLikePath(raw)) {
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(workspaceRoot, candidate);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      return { text: fs.readFileSync(absolute, "utf8").trim(), source: absolute };
    }
    if (forced) {
      throw new Error(`Cannot read ${label} file "${candidate}".`);
    }
  }

  return { text: raw.trim(), source: null };
}

function readFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const text = fs.readFileSync(filePath, "utf8").trim();
    return text ? { text, source: filePath } : null;
  }
  return null;
}

export function listBuiltInRoles(pluginRoot) {
  const rolesDir = path.join(pluginRoot, "prompts", "roles");
  if (!fs.existsSync(rolesDir)) {
    return [];
  }
  return fs
    .readdirSync(rolesDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.replace(/\.md$/, ""))
    .sort();
}

/**
 * Locate the prompt file for a role name.
 * Project roles and config entries shadow the built-in ones.
 */
export function resolveRole(roleName, { pluginRoot, workspaceRoot, config }) {
  const name = String(roleName ?? "").trim();
  if (!name) {
    return null;
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid role name "${roleName}". Use letters, digits, dots, dashes or underscores.`);
  }

  const configured = config?.roles?.[name];
  if (configured) {
    const resolved = resolvePromptValue(configured.startsWith("@") ? configured : `@${configured}`, {
      workspaceRoot,
      label: `role "${name}"`
    });
    return { name, ...resolved };
  }

  const candidates = [
    path.join(workspaceRoot, ".claude", "pi", "roles", `${name}.md`),
    path.join(os.homedir(), ".claude", "pi", "roles", `${name}.md`),
    path.join(pluginRoot, "prompts", "roles", `${name}.md`)
  ];

  for (const candidate of candidates) {
    const file = readFileIfExists(candidate);
    if (file) {
      return { name, ...file };
    }
  }

  const available = listBuiltInRoles(pluginRoot);
  throw new Error(
    `Unknown role "${name}". Built-in roles: ${available.join(", ") || "none"}. ` +
      `Add a custom one at .claude/pi/roles/${name}.md or via "roles" in .claude/pi/config.json.`
  );
}

/**
 * Build the final system-prompt configuration for a pi run.
 *
 * @returns {{ systemPrompt: string|null, appends: string[], sources: string[], role: string|null }}
 */
export function buildSystemPrompt({ pluginRoot, workspaceRoot, config, settings }) {
  const sources = [];
  let systemPrompt = null;
  let role = null;

  if (settings.systemPrompt) {
    const resolved = resolvePromptValue(settings.systemPrompt, {
      workspaceRoot,
      label: "system prompt"
    });
    systemPrompt = resolved.text;
    sources.push(resolved.source ? `system prompt: ${resolved.source}` : "system prompt: inline text");
  } else if (settings.role) {
    const resolved = resolveRole(settings.role, { pluginRoot, workspaceRoot, config });
    systemPrompt = resolved.text;
    role = resolved.name;
    sources.push(`role "${resolved.name}": ${resolved.source ?? "config"}`);
  } else {
    const projectSystem = readFileIfExists(path.join(workspaceRoot, ".claude", "pi", "SYSTEM.md"));
    if (projectSystem) {
      systemPrompt = projectSystem.text;
      sources.push(`system prompt: ${projectSystem.source}`);
    }
  }

  const appends = [];
  for (const value of settings.appendSystemPrompt ?? []) {
    const resolved = resolvePromptValue(value, { workspaceRoot, label: "appended system prompt" });
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

  return { systemPrompt, appends, sources, role };
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
