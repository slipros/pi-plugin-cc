import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSystemPrompt,
  interpolate,
  listNamedPrompts,
  resolvePromptValue
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

test("the built-in prompts ship with the plugin", () => {
  withWorkspace((workspaceRoot) => {
    const names = [...listNamedPrompts(PLUGIN_ROOT, workspaceRoot).keys()].sort();
    for (const expected of ["adversarial", "explorer", "fixer", "reviewer"]) {
      assert.ok(names.includes(expected), `${expected} should be available`);
    }
  });
});

/**
 * Пустой домашний каталог на время проверки.
 *
 * Резолв промптов ищет в трёх слоях, средний из которых — дом пользователя.
 * Тест, не задавший его явно, читает настоящий: результат зависит от того,
 * какие промпты человек завёл себе, и падает ровно там, где перекрытие
 * работает как задумано.
 */
function withEmptyHome(run) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompts-home-"));
  try {
    return run(homeDir);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

test("inline text stays inline", () => {
  withWorkspace((workspaceRoot) => {
    const resolved = resolvePromptValue("be extremely terse", { workspaceRoot, pluginRoot: PLUGIN_ROOT });
    assert.equal(resolved.text, "be extremely terse");
    assert.equal(resolved.source, null);
    assert.equal(resolved.name, null);
  });
});

// Имя, которого заведомо нет ни в проекте, ни в домашнем каталоге: проверка
// про механику резолва, а не про содержимое конкретного промпта. Прежняя версия
// брала `explorer` и сверяла его текст — и краснела на машине, где такой промпт
// заведён у пользователя, то есть ровно там, где перекрытие работает как задумано.
test("a stored prompt is resolved by name", () => {
  withWorkspace((workspaceRoot) => {
    const resolved = resolvePromptValue("fixer", { workspaceRoot, pluginRoot: PLUGIN_ROOT });
    assert.equal(resolved.name, "fixer");
    assert.ok(resolved.text.trim().length > 0, "имя развернулось в текст промпта");
    assert.ok(resolved.source, "и в источник, из которого он взят");
  });
});

test("the built-in prompt is what a name resolves to when nothing shadows it", () => {
  withWorkspace((workspaceRoot) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompts-home-"));
    try {
      const resolved = resolvePromptValue("explorer", { workspaceRoot, pluginRoot: PLUGIN_ROOT, homeDir: home });
      assert.equal(resolved.name, "explorer");
      assert.match(resolved.text, /codebase investigator/i, "плагинный текст, а не пользовательский");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

test("a project prompt shadows the built-in one of the same name", () => {
  withWorkspace((workspaceRoot) => {
    writeFile(workspaceRoot, ".claude/pi/prompts/reviewer.md", "project reviewer");
    const resolved = resolvePromptValue("reviewer", { workspaceRoot, pluginRoot: PLUGIN_ROOT });
    assert.equal(resolved.text, "project reviewer");
  });
});

test("an unknown name fails loudly and lists what exists", () => {
  withWorkspace((workspaceRoot) => {
    assert.throws(
      () => resolvePromptValue("wizard", { workspaceRoot, pluginRoot: PLUGIN_ROOT }),
      /No system prompt named "wizard".*reviewer/s
    );
  });
});

test("@path reads the file relative to the workspace", () => {
  withWorkspace((workspaceRoot) => {
    writeFile(workspaceRoot, "prompts/custom.md", "custom prompt body\n");
    const resolved = resolvePromptValue("@prompts/custom.md", { workspaceRoot, pluginRoot: PLUGIN_ROOT });
    assert.equal(resolved.text, "custom prompt body");
    assert.equal(resolved.source, path.join(workspaceRoot, "prompts/custom.md"));
  });
});

test("@path on a missing file is an error, not silent text", () => {
  withWorkspace((workspaceRoot) => {
    assert.throws(() => resolvePromptValue("@nope.md", { workspaceRoot, pluginRoot: PLUGIN_ROOT }), /Cannot read/);
  });
});

test("a multi-word value is prompt text, never a name lookup", () => {
  withWorkspace((workspaceRoot) => {
    const resolved = resolvePromptValue("review the .md docs", { workspaceRoot, pluginRoot: PLUGIN_ROOT });
    assert.equal(resolved.text, "review the .md docs");
  });
});

test("the project SYSTEM.md is used when nothing is configured", () => {
  withWorkspace((workspaceRoot) => {
    writeFile(workspaceRoot, ".claude/pi/SYSTEM.md", "workspace system prompt");
    const built = buildSystemPrompt({
      pluginRoot: PLUGIN_ROOT,
      workspaceRoot,
      settings: { appendSystemPrompt: [] }
    });
    assert.equal(built.systemPrompt, "workspace system prompt");
  });
});

test("an explicit prompt wins over the project SYSTEM.md", () => {
  withWorkspace((workspaceRoot) => {
    writeFile(workspaceRoot, ".claude/pi/SYSTEM.md", "workspace system prompt");
    const built = buildSystemPrompt({
      pluginRoot: PLUGIN_ROOT,
      workspaceRoot,
      settings: { systemPrompt: "inline wins", appendSystemPrompt: [] }
    });
    assert.equal(built.systemPrompt, "inline wins");
  });
});

test("APPEND_SYSTEM.md stacks on top of a named prompt", () => {
  withWorkspace((workspaceRoot) => {
    withEmptyHome((homeDir) => {
      writeFile(workspaceRoot, ".claude/pi/APPEND_SYSTEM.md", "always answer in Russian");
      const built = buildSystemPrompt({
        pluginRoot: PLUGIN_ROOT,
        workspaceRoot,
        homeDir,
        settings: { systemPrompt: "fixer", appendSystemPrompt: ["and cite files"] }
      });
      assert.match(built.systemPrompt, /experienced engineer/i);
      assert.equal(built.name, "fixer");
      assert.deepEqual(built.appends, ["and cite files", "always answer in Russian"]);
    });
  });
});

// Средний слой поиска: между проектом и плагином. До того как `homeDir` стал
// параметром, проверить его было нечем — функция читала настоящий домашний
// каталог, и результат зависел от того, что там завёл человек.
test("a home prompt shadows the built-in one, and a project prompt shadows both", () => {
  withWorkspace((workspaceRoot) => {
    withEmptyHome((homeDir) => {
      fs.mkdirSync(path.join(homeDir, ".claude/pi/prompts"), { recursive: true });
      fs.writeFileSync(path.join(homeDir, ".claude/pi/prompts/explorer.md"), "home explorer", "utf8");

      const fromHome = resolvePromptValue("explorer", { workspaceRoot, pluginRoot: PLUGIN_ROOT, homeDir });
      assert.equal(fromHome.text, "home explorer", "домашний слой перекрывает плагинный");

      writeFile(workspaceRoot, ".claude/pi/prompts/explorer.md", "project explorer");
      const fromProject = resolvePromptValue("explorer", { workspaceRoot, pluginRoot: PLUGIN_ROOT, homeDir });
      assert.equal(fromProject.text, "project explorer", "проектный слой перекрывает домашний");

      const names = listNamedPrompts(PLUGIN_ROOT, workspaceRoot, homeDir);
      assert.equal(names.get("explorer"), path.join(workspaceRoot, ".claude/pi/prompts/explorer.md"));
    });
  });
});

// Ошибка про неизвестное имя тоже перечисляет промпты по переданному дому, а не
// по настоящему: иначе подсказка на чужой машине называет чужие имена.
test("the list in the error respects the home directory it was given", () => {
  withWorkspace((workspaceRoot) => {
    withEmptyHome((homeDir) => {
      fs.mkdirSync(path.join(homeDir, ".claude/pi/prompts"), { recursive: true });
      fs.writeFileSync(path.join(homeDir, ".claude/pi/prompts/homely.md"), "home only", "utf8");
      assert.throws(
        () => resolvePromptValue("wizard", { workspaceRoot, pluginRoot: PLUGIN_ROOT, homeDir }),
        /No system prompt named "wizard".*homely/s
      );
    });
  });
});

test("nothing configured leaves pi with its own default prompt", () => {
  withWorkspace((workspaceRoot) => {
    const built = buildSystemPrompt({
      pluginRoot: PLUGIN_ROOT,
      workspaceRoot,
      settings: { appendSystemPrompt: [] }
    });
    assert.equal(built.systemPrompt, null);
    assert.deepEqual(built.appends, []);
  });
});

test("interpolate replaces known placeholders and blanks the rest", () => {
  assert.equal(interpolate("a {{ONE}} b {{TWO}}", { ONE: "1" }), "a 1 b ");
});
