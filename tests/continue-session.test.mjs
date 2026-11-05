import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * `continue` продолжает именно ту сессию, которую назвали, и с тем
 * оборудованием, которое назвали.
 *
 * Каждая сессия заводится настоящим прогоном `delegate` через CLI с двойником
 * вместо pi; факт сверяется по аргументам, реально ушедшим в запуск
 * (PI_FAKE_LOG), а не по тексту предупреждений.
 */

const CLI = fileURLToPath(new URL("../plugins/pi/scripts/pi-companion.mjs", import.meta.url));

const SESSION_A = "11111111-1111-1111-1111-111111111111";
const SESSION_B = "22222222-2222-2222-2222-222222222222";

const FAKE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-continue-bin-"));
const FAKE_BINARY = path.join(FAKE_ROOT, "fake-pi.mjs");
fs.writeFileSync(
  FAKE_BINARY,
  `#!/usr/bin/env node
import fs from "node:fs";
process.stdin.setEncoding("utf8");
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  fs.appendFileSync(process.env.PI_FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), prompt }) + "\\n");
  say({ type: "session", id: process.env.PI_FAKE_SESSION });
  say({ type: "turn_start" });
  say({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 1, output: 1 }, content: [{ type: "text", text: "done" }] } });
});
`,
  { encoding: "utf8", mode: 0o755 }
);

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-continue-home-"));
  fs.mkdirSync(path.join(home, ".claude", "pi"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "pi", "config.json"),
    JSON.stringify({
      presets: {
        // Пресеты разведены по КАЖДОМУ полю, которое продолжение наследует от
        // рецепта: одинаковое значение у обоих делает ассерт декоративным —
        // «взял у нового пресета» и «унаследовал от сессии» неразличимы.
        alpha: { model: "deepseek-chat", provider: "deepseek", engine: "json", thinking: "high" },
        beta: { model: "glm-5", provider: "zai", engine: "json", thinking: "low" }
      }
    })
  );
  return home;
}

function cli({ home, workspace, args, input = "", env = {} }) {
  const log = path.join(workspace, "pi-calls.jsonl");
  const before = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: workspace,
    input,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: path.join(workspace, "data"),
      PI_PLUGIN_BINARY: FAKE_BINARY,
      PI_FAKE_LOG: log,
      ...env
    }
  });
  const calls = () =>
    fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const newCalls = () => calls().slice(before ? before.split("\n").filter(Boolean).length : 0);
  return { result, calls, newCalls };
}

function delegate({ home, workspace, preset, sessionEnv, extra = [] }) {
  const { result, calls } = cli({
    home,
    workspace,
    args: ["delegate", "--preset", preset, "--json", ...extra, "сделай задачу"],
    env: { PI_FAKE_SESSION: sessionEnv }
  });
  assert.equal(result.status, 0, `delegate прошёл:\n${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).sessionId, sessionEnv, "у джоба записалась сессия двойника");
  return JSON.parse(result.stdout).job;
}

function freshCase() {
  const home = makeHome();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-continue-ws-"));
  const jobA = delegate({ home, workspace, preset: "alpha", sessionEnv: SESSION_A });
  delegate({ home, workspace, preset: "beta", sessionEnv: SESSION_B });
  return { home, workspace, jobA };
}

function argOf(args, flag) {
  return args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
}

test("continue <id> --stdin уходит на названную сессию с её оборудованием, id не попадает в промпт", () => {
  const { home, workspace } = freshCase();

  const { result, calls } = cli({
    home,
    workspace,
    args: ["continue", SESSION_A, "--stdin"],
    input: "продолжи фикс-раунд"
  });
  assert.equal(result.status, 0, `continue прошёл:\n${result.stderr}`);
  const last = calls().at(-1);
  assert.equal(argOf(last.args, "--session"), SESSION_A, "запуск ушёл на сессию S1, а не на последнюю");
  assert.equal(argOf(last.args, "--model"), "deepseek-chat", "модель — от сессии S1");
  assert.equal(argOf(last.args, "--provider"), "deepseek", "провайдер — от сессии S1");
  assert.match(last.prompt, /продолжи фикс-раунд/);
  assert.ok(!last.prompt.includes(SESSION_A), "id сессии не протёк в текст промпта");
});

test("continue last \"сделай X\" и \"починить фикстуру last\" ведут себя как раньше", () => {
  const { home, workspace } = freshCase();

  const byFlag = cli({ home, workspace, args: ["continue", "last", "сделай X"] });
  assert.equal(byFlag.result.status, 0, `continue прошёл:\n${byFlag.result.stderr}`);
  const first = byFlag.calls().at(-1);
  assert.equal(argOf(first.args, "--session"), SESSION_B, "last — новейшая сессия");
  assert.match(first.prompt, /сделай X/);

  const asTask = cli({ home, workspace, args: ["continue", "починить фикстуру last"] });
  assert.equal(asTask.result.status, 0, `continue прошёл:\n${asTask.result.stderr}`);
  const second = asTask.calls().at(-1);
  assert.equal(argOf(second.args, "--session"), SESSION_B, "без сопоставимой ссылки — последняя сессия");
  assert.equal(second.prompt, "починить фикстуру last", "фраза целиком осталась задачей");
});

test("continue <id> без текста задачи — отказ с формой вызова, запуск не стартует", () => {
  const { home, workspace } = freshCase();

  const { result, newCalls } = cli({ home, workspace, args: ["continue", SESSION_A] });
  assert.notEqual(result.status, 0, "без текста задача не запускается");
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.match(combined, /Usage: continue/, "в отказе названа форма вызова");
  assert.equal(newCalls().length, 0, "двойник pi не стартовал");
});

test("continue с несуществующей ссылкой — отказ, откат на last запрещён", () => {
  const { home, workspace } = freshCase();

  const { result, newCalls } = cli({
    home,
    workspace,
    args: ["continue", "0badc0de", "--stdin"],
    input: "продолжи фикс-раунд"
  });
  assert.notEqual(result.status, 0, "несопоставленная ссылка — отказ");
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.match(combined, /0badc0de/, "в отказе названа ссылка, которая не нашлась");
  assert.equal(newCalls().length, 0, "last вместо названной сессии не запускался");
});

test("--preset другого агента отменяет унаследованную модель и провайдера; явный --model старше всего", () => {
  const { home, workspace } = freshCase();

  const switched = cli({
    home,
    workspace,
    args: ["continue", SESSION_A, "--preset", "beta", "--stdin"],
    input: "продолжи фикс-раунд"
  });
  assert.equal(switched.result.status, 0, `continue прошёл:\n${switched.result.stderr}`);
  const args = switched.calls().at(-1).args;
  assert.equal(argOf(args, "--model"), "glm-5", "модель — от нового пресета, не от прошлого прогона");
  assert.equal(argOf(args, "--provider"), "zai", "провайдер — от нового пресета");
  assert.equal(argOf(args, "--thinking"), "low", "уровень размышления — от нового пресета, а не унаследованный high");

  const explicit = cli({
    home,
    workspace,
    args: ["continue", SESSION_A, "--model", "custom-x", "--stdin"],
    input: "продолжи фикс-раунд"
  });
  assert.equal(explicit.result.status, 0, `continue прошёл:\n${explicit.result.stderr}`);
  assert.equal(argOf(explicit.calls().at(-1).args, "--model"), "custom-x", "явный флаг старше рецепта сессии");
});

test("delegate --session <job-id> уходит на сессию джоба; несуществующая ссылка — отказ", () => {
  const { home, workspace, jobA } = freshCase();

  const byJob = cli({
    home,
    workspace,
    args: ["delegate", "--engine", "json", "--session", jobA, "--json", "ещё задачу"],
    env: { PI_FAKE_SESSION: SESSION_A }
  });
  assert.equal(byJob.result.status, 0, `delegate прошёл:\n${byJob.result.stderr}`);
  assert.equal(argOf(byJob.calls().at(-1).args, "--session"), SESSION_A, "job-id развёрнут в id сессии pi");

  const unknown = cli({
    home,
    workspace,
    args: ["delegate", "--session", "никакой-такой-нет", "--json", "ещё задачу"]
  });
  assert.notEqual(unknown.result.status, 0, "несопоставленная ссылка — отказ");
  const combined = `${unknown.result.stdout}\n${unknown.result.stderr}`;
  assert.match(combined, /никакой-такой-нет/, "в отказе названа ссылка");
  // Слово «sessions» стоит в подсказке «run `sessions`» и краснеет даже у
  // отказа, потерявшего перечень: спрашиваем сами идентификаторы.
  assert.ok(
    combined.includes(SESSION_A.slice(0, 8)) || combined.includes(SESSION_B.slice(0, 8)),
    `в отказе перечислены доступные сессии:\n${combined}`
  );
});

test("сессия БЕЗ пресета в рецепте: --preset отменяет модель прошлого прогона", () => {
  // Класс, который условие `recipe.preset &&` пропускало: родительский прогон
  // шёл на голых флагах, рецепт ключа preset не содержит вовсе — и смена агента
  // оставляла ему модель прошлого запуска, хотя пресет применён.
  const home = makeHome();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-continue-ws-"));
  const bare = cli({
    home,
    workspace,
    args: ["delegate", "--model", "custom-x", "--provider", "deepseek", "--engine", "json", "--json", "сделай задачу"],
    env: { PI_FAKE_SESSION: SESSION_A }
  });
  assert.equal(bare.result.status, 0, `delegate без пресета прошёл:\n${bare.result.stderr}`);

  const switched = cli({
    home,
    workspace,
    args: ["continue", SESSION_A, "--preset", "beta", "--stdin"],
    input: "продолжи фикс-раунд"
  });
  assert.equal(switched.result.status, 0, `continue прошёл:\n${switched.result.stderr}`);
  const args = switched.calls().at(-1).args;
  assert.equal(argOf(args, "--model"), "glm-5", "модель — от названного пресета, а не custom-x прошлого прогона");
  assert.equal(argOf(args, "--provider"), "zai", "провайдер — от названного пресета");
});

test("явный --model старше и нового пресета: --preset beta --model custom-x", () => {
  const { home, workspace } = freshCase();

  const { result, calls } = cli({
    home,
    workspace,
    args: ["continue", SESSION_A, "--preset", "beta", "--model", "custom-x", "--stdin"],
    input: "продолжи фикс-раунд"
  });
  assert.equal(result.status, 0, `continue прошёл:\n${result.stderr}`);
  const args = calls().at(-1).args;
  assert.equal(argOf(args, "--model"), "custom-x", "явный флаг старше и пресета, и рецепта");
  assert.equal(argOf(args, "--provider"), "zai", "остальное оборудование — от названного пресета");
});

test("пустой --stdin — такой же отказ, как отсутствие текста вовсе", () => {
  // Реализация, считающая текстом сам факт флага, запустила бы прогон с пустой
  // задачей: агент получает пустой промпт и идёт изобретать себе работу.
  const { home, workspace } = freshCase();

  const { result, newCalls } = cli({
    home,
    workspace,
    args: ["continue", SESSION_A, "--stdin"],
    input: "   \n  \n"
  });
  assert.notEqual(result.status, 0, "пустой канал — не текст задачи");
  assert.match(`${result.stdout}\n${result.stderr}`, /Usage: continue/, "в отказе названа форма вызова");
  assert.equal(newCalls().length, 0, "двойник pi не стартовал");
});

/** Отсоединённый прогон пишет в лог позже возврата команды — ждём его появления. */
function awaitCall(log, matcher, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = fs.existsSync(log)
      ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    const hit = rows.find(matcher);
    if (hit) {
      return hit;
    }
    // Ожидание без таймера: цикл держит поток, пока отсоединённый процесс пишет.
    spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 250)"]);
  }
  return null;
}

test("--background: ссылка снимается в родителе, отсоединённый прогон идёт на НАЗВАННУЮ сессию", () => {
  // Форма, на которой дефект и воспроизводился в живой работе: текст в stdin,
  // прогон отсоединяется, а сессию родитель передаёт потомку через окружение.
  const { home, workspace } = freshCase();
  const log = path.join(workspace, "pi-calls.jsonl");

  const { result } = cli({
    home,
    workspace,
    args: ["continue", SESSION_A, "--stdin", "--background"],
    input: "продолжи фикс-раунд"
  });
  assert.equal(result.status, 0, `отсоединение прошло:\n${result.stderr}`);

  const call = awaitCall(log, (row) => row.prompt.includes("продолжи фикс-раунд"));
  assert.ok(call, "отсоединённый прогон дошёл до запуска двойника");
  assert.equal(argOf(call.args, "--session"), SESSION_A, "фоновый прогон ушёл на названную сессию, а не на последнюю");
  assert.equal(argOf(call.args, "--model"), "deepseek-chat", "оборудование — от названной сессии");
  assert.ok(!call.prompt.includes(SESSION_A), "id сессии не протёк в текст промпта");
});

test.after(() => {
  fs.rmSync(FAKE_ROOT, { recursive: true, force: true });
});
