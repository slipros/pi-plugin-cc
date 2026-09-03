/**
 * Состав хуков: кто попадает в прогон, когда PI_HOOKS не задан.
 *
 * Дефолт «включить всё» однажды затащил test-only-guard в обычные прогоны
 * разработчика: хостовый запуск и continue от прогона без пресета приходят без
 * PI_HOOKS, QA-гейт вставал на git add/git commit, коммит прод-кода молча
 * отклонялся, и готовая работа оставалась незакоммиченной в рабочем дереве.
 * Отсюда profileOnly — и этот тест, который стоит на том, что признак работает.
 *
 * Прогон: node --experimental-strip-types ~/.pi/agent/extensions/hooks/tests/selection.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const src = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hooks-selection-"));
for (const file of fs.readdirSync(src).filter((name) => name.endsWith(".ts"))) {
  const text = fs
    .readFileSync(path.join(src, file), "utf8")
    .replace(/from "\.\/([a-z-]+)"/g, 'from "./$1.ts"');
  fs.writeFileSync(path.join(tmp, file), text);
}

/** Имена хуков, которые index.ts включает при данном окружении. */
async function selected(env) {
  for (const name of ["PI_HOOKS", "PI_HOOKS_ON", "PI_HOOKS_OFF"]) {
    delete process.env[name];
  }
  Object.assign(process.env, env);
  // Кеш модулей общий на весь процесс, а состав считается на импорте: у каждого
  // набора env своя копия index.ts, иначе второй вызов вернул бы первый ответ.
  const copy = path.join(tmp, `index-${Buffer.from(JSON.stringify(env)).toString("hex")}.ts`);
  fs.copyFileSync(path.join(tmp, "index.ts"), copy);
  const mod = await import(copy);
  const names = [];
  mod.default({ on: (event, matcher, fn) => names.push({ event, matcher, fn }) });
  return names.length;
}

const bare = await selected({});
const withGuard = await selected({ PI_HOOKS_ON: "test-only-guard" });
const explicit = await selected({ PI_HOOKS: "test-only-guard" });

assert.ok(bare > 0, "без PI_HOOKS состав не должен быть пустым");
assert.ok(withGuard > bare, "PI_HOOKS_ON=test-only-guard обязан добавить хук к дефолтному составу");
assert.ok(explicit > 0, "явный PI_HOOKS=test-only-guard обязан включить именно его");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`состав: без PI_HOOKS — ${bare} регистраций, с PI_HOOKS_ON=test-only-guard — ${withGuard}`);
