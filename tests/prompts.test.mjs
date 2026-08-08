import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSystemPrompt,
  interpolate,
  listBuiltInRoles,
  resolvePromptValue,
  resolveRole
} from "../plugins/pi/scripts/lib/prompts.mjs";

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..", "plugins", "pi");

function withWorkspace(run) {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-test-"));
  try {
    return run(workspaceRoot);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function writeFile(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

test("the built-in roles ship with the plugin", () => {
  const roles = listBuiltInRoles(PLUGIN_ROOT);
  assert.deepEqual(roles, ["adversarial", "explorer", "fixer", "reviewer"]);
});

test("inline text stays inline", () => {
  const resolved = resolvePromptValue("be extremely terse", { workspaceRoot: "/tmp" });
  assert.equal(resolved.text, "be extremely terse");
  assert.equal(resolved.source, null);
});

test("@path reads the file relative to the workspace", () => {
  withWorkspace((workspaceRoot) => {
    writeFile(workspaceRoot, "prompts/custom.md", "custom prompt body\n");
    const resolved = resolvePromptValue("@prompts/custom.md", { workspaceRoot });
    assert.equal(resolved.text, "custom prompt body");
    assert.equal(resolved.source, path.join(workspaceRoot, "prompts/custom.md"));
  });
});

test("@path on a missing file is an error, not silent text", () => {
  withWorkspace((workspaceRoot) => {
    assert.throws(() => resolvePromptValue("@nope.md", { workspaceRoot }), /Cannot read/);
  });
});

test("a bare .md value that does not exist is treated as prompt text", () => {
  withWorkspace((workspaceRoot) => {
    const resolved = resolvePromptValue("review the .md docs", { workspaceRoot });
    assert.equal(resolved.text, "review the .md docs");
  });
});

test("project roles shadow the built-in ones", () => {
  withWorkspace((workspaceRoot) => {
    writeFile(workspaceRoot, ".claude/pi/roles/reviewer.md", "project reviewer");
    const resolved = resolveRole("reviewer", { pluginRoot: PLUGIN_ROOT, workspaceRoot, config: {} });
    assert.equal(resolved.text, "project reviewer");
  });
});

test("a built-in role resolves from the plugin directory", () => {
  withWorkspace((workspaceRoot) => {
    const resolved = resolveRole("explorer", { pluginRoot: PLUGIN_ROOT, workspaceRoot, config: {} });
    assert.match(resolved.text, /codebase investigator/i);
    assert.equal(resolved.name, "explorer");
  });
});

test("an unknown role lists the available ones", () => {
  withWorkspace((workspaceRoot) => {
    assert.throws(
      () => resolveRole("wizard", { pluginRoot: PLUGIN_ROOT, workspaceRoot, config: {} }),
      /Built-in roles: adversarial, explorer, fixer, reviewer/
    );
  });
});

test("a role name with path separators is rejected", () => {
  withWorkspace((workspaceRoot) => {
    assert.throws(
      () => resolveRole("../../etc/passwd", { pluginRoot: PLUGIN_ROOT, workspaceRoot, config: {} }),
      /Invalid role name/
    );
  });
});

test("--system-prompt wins over --role", () => {
  withWorkspace((workspaceRoot) => {
    const built = buildSystemPrompt({
      pluginRoot: PLUGIN_ROOT,
      workspaceRoot,
      config: {},
      settings: { systemPrompt: "inline wins", role: "reviewer", appendSystemPrompt: [] }
    });
    assert.equal(built.systemPrompt, "inline wins");
    assert.equal(built.role, null);
  });
});

test("the project SYSTEM.md is used when no role or flag is given", () => {
  withWorkspace((workspaceRoot) => {
    writeFile(workspaceRoot, ".claude/pi/SYSTEM.md", "workspace system prompt");
    const built = buildSystemPrompt({
      pluginRoot: PLUGIN_ROOT,
      workspaceRoot,
      config: {},
      settings: { appendSystemPrompt: [] }
    });
    assert.equal(built.systemPrompt, "workspace system prompt");
  });
});

test("APPEND_SYSTEM.md is added on top of an explicit role", () => {
  withWorkspace((workspaceRoot) => {
    writeFile(workspaceRoot, ".claude/pi/APPEND_SYSTEM.md", "always answer in Russian");
    const built = buildSystemPrompt({
      pluginRoot: PLUGIN_ROOT,
      workspaceRoot,
      config: {},
      settings: { role: "fixer", appendSystemPrompt: ["and cite files"] }
    });
    assert.match(built.systemPrompt, /experienced engineer/i);
    assert.deepEqual(built.appends, ["and cite files", "always answer in Russian"]);
  });
});

test("nothing configured leaves pi with its own default prompt", () => {
  withWorkspace((workspaceRoot) => {
    const built = buildSystemPrompt({
      pluginRoot: PLUGIN_ROOT,
      workspaceRoot,
      config: {},
      settings: { appendSystemPrompt: [] }
    });
    assert.equal(built.systemPrompt, null);
    assert.deepEqual(built.appends, []);
  });
});

test("interpolate replaces known placeholders and blanks the rest", () => {
  assert.equal(interpolate("a {{ONE}} b {{TWO}}", { ONE: "1" }), "a 1 b ");
});
