import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Вмешательство в прогон, который ходит по кругу в собственном рассуждении.
 *
 * Двойник выдаёт ходы, целиком ушедшие в размышление: блок thinking есть,
 * текста нет. Проверяется то, ради чего фича заведена, — что плагин САМ
 * замечает круг и САМ отправляет сообщение в живую сессию, и что он молчит,
 * когда круга нет: ложное вмешательство на этом классе вредит сильнее, чем
 * отсутствие всякого.
 */

const FAKE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nudge-"));
const FAKE_BINARY = path.join(FAKE_ROOT, "fake-pi.mjs");

fs.writeFileSync(
  FAKE_BINARY,
  `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const log = process.env.PI_FAKE_LOG;
const turns = Number(process.env.PI_FAKE_TURNS ?? 5);
const bloatChars = Number(process.env.PI_FAKE_THINK ?? 8000);
const withText = process.env.PI_FAKE_WITH_TEXT === "1";
const withTool = process.env.PI_FAKE_WITH_TOOL === "1";
// Ходы обрываются на потолке вывода: pi отбрасывает обрезанное сообщение
// целиком и оседает после КАЖДОГО такого хода — так выглядит живой срыв.
const truncate = process.env.PI_FAKE_TRUNCATE === "1";
const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const note = (entry) => fs.appendFileSync(log, JSON.stringify(entry) + "\\n");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let prompts = 0;
// Настоящий pi отвергает голый prompt, пока агент занят, и подсказывает поле,
// которым сообщение ставится в очередь. Двойник, принимающий его всегда, не
// поймал бы ровно тот дефект, из-за которого вмешательство не доезжало.
let streaming = false;
let heard = false;

const turnContent = (i) => {
  const content = [{ type: "thinking", thinking: "думаю ".repeat(Math.ceil(bloatChars / 6)) }];
  if (withText) content.push({ type: "text", text: "и вот что решил " + i });
  // Ход с одним вызовом инструмента: pi шлёт его как [thinking, toolCall],
  // текста в нём нет вовсе — так выглядит обычная пофайловая работа.
  if (withTool) {
    content.push({ type: "toolCall", toolCallId: "call-" + i, toolName: "edit", args: { path: "file" + i + ".go" } });
  }
  return content;
};

async function runLoop() {
  streaming = true;
  for (let i = 0; i < turns; i += 1) {
    if (withTool) {
      say({ type: "tool_execution_start", toolCallId: "call-" + i, toolName: "edit", args: { path: "file" + i + ".go" } });
    }
    say({ type: "turn_start" });
    note({ type: "fake_turn" });
    say({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: truncate ? "length" : "stop",
        usage: { input: 10, output: 20 },
        content: turnContent(i)
      }
    });
    // Пауза даёт плагину увидеть ход и успеть вмешаться, пока агент ещё занят.
    await sleep(15);
    if (truncate) {
      // Обрыв заканчивает не только ход, но и весь заход агента.
      streaming = false;
      say({ type: "agent_settled" });
      return;
    }
    if (heard && process.env.PI_FAKE_KEEP_LOOPING !== "1") {
      break;
    }
  }
  streaming = false;
  say({ type: "agent_settled" });
}

async function answer() {
  streaming = true;
  say({ type: "turn_start" });
  say({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 20 }, content: [{ type: "text", text: "решение принято" }] } });
  await sleep(5);
  streaming = false;
  say({ type: "agent_settled" });
}

let chain = Promise.resolve();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  note(command);
  if (command.type === "get_state") {
    say({ type: "response", command: "get_state", success: true, data: { sessionId: "sess-nudge" } });
    return;
  }
  if (command.type !== "prompt") return;
  if (process.env.PI_FAKE_REJECT_NUDGE === "1" && String(command.id ?? "").startsWith("nudge-")) {
    say({ type: "response", command: "prompt", success: false, id: command.id, error: "nope" });
    return;
  }
  if (streaming && !command.streamingBehavior) {
    say({
      type: "response",
      command: "prompt",
      success: false,
      id: command.id,
      error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
    });
    return;
  }
  prompts += 1;
  say({ type: "response", command: "prompt", success: true, id: command.id });
  if (prompts > 1) {
    heard = true;
  }
  if (command.streamingBehavior) {
    // Поставлено в очередь текущего хода — нового захода агента не будет.
    return;
  }
  // Агент, послушавший вмешательство, перестаёт крутиться — если тест не просит
  // обратного (PI_FAKE_KEEP_LOOPING=1 нужен для проверки лимита).
  chain = chain.then(() =>
    prompts > 1 && process.env.PI_FAKE_KEEP_LOOPING !== "1" ? answer() : runLoop()
  );
});
`,
  { encoding: "utf8", mode: 0o755 }
);

process.env.PI_PLUGIN_BINARY = FAKE_BINARY;
const { runPiRpcTurn } = await import("../plugins/pi/scripts/lib/rpc.mjs");
const { LOOP_NUDGE_PROMPT, MAX_LOOP_NUDGES } = await import("../plugins/pi/scripts/lib/pi.mjs");

test.after(() => fs.rmSync(FAKE_ROOT, { recursive: true, force: true }));

function withRun(env, run) {
  const dir = fs.mkdtempSync(path.join(FAKE_ROOT, "run-"));
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(log, "", "utf8");
  const entries = () =>
    fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const nudges = () => entries().filter((command) => command.type === "prompt" && command.message === LOOP_NUDGE_PROMPT);
  const continuations = () =>
    entries().filter(
      (command) => command.type === "prompt" && command.id !== "prompt-1" && command.message !== LOOP_NUDGE_PROMPT
    );
  const turns = () => entries().filter((entry) => entry.type === "fake_turn");
  return run({ cwd: dir, nudges, continuations, turns, env: { ...process.env, PI_FAKE_LOG: log, ...env } });
}

test("три хода целиком в размышление — плагин сам вмешивается", async () => {
  await withRun({ PI_FAKE_TURNS: "3", PI_FAKE_THINK: "8000" }, async ({ cwd, nudges, env }) => {
    const result = await runPiRpcTurn({ cwd, prompt: "задача", sandbox: null, settleGraceMs: 200, env });
    assert.equal(nudges().length, 1, "вмешательство отправлено в живую сессию");
    assert.equal(result.loopNudges, 1, "счётчик доезжает до результата");
    // Текст несёт выход, а не совет: круг размышлением не разрывается.
    assert.match(LOOP_NUDGE_PROMPT, /ВЕРНИ БЛОКЕР/);
    assert.match(LOOP_NUDGE_PROMPT, /ПРИМИ РЕШЕНИЕ/);
  });
});

test("размышление с ответом кругом не считается", async () => {
  // Задумчивый ход, который всё-таки что-то произвёл, — работа, а не круг.
  await withRun({ PI_FAKE_TURNS: "6", PI_FAKE_THINK: "9000", PI_FAKE_WITH_TEXT: "1" }, async ({ cwd, nudges, env }) => {
    const result = await runPiRpcTurn({ cwd, prompt: "задача", sandbox: null, settleGraceMs: 200, env });
    assert.equal(nudges().length, 0);
    assert.equal(result.loopNudges, 0);
  });
});

test("ход с вызовом инструмента — работа, а не круг", async () => {
  // Самый частый вид работы под высоким уровнем рассуждения: длинное thinking и
  // один вызов инструмента, прозы нет ни в одном ходе. По тексту такой прогон
  // неотличим от круга — вмешательства уходили бы в исправно работающего агента,
  // а «ходов впустую» показывало бы 100% у прогона, правящего файл за файлом.
  await withRun(
    { PI_FAKE_TURNS: "6", PI_FAKE_THINK: "9000", PI_FAKE_WITH_TOOL: "1" },
    async ({ cwd, nudges, env }) => {
      const result = await runPiRpcTurn({ cwd, prompt: "задача", sandbox: null, settleGraceMs: 200, env });
      assert.equal(nudges().length, 0, "в живую сессию ничего не отправлено");
      assert.equal(result.loopNudges, 0);
      assert.equal(result.turnsIdle, 0, "ходы с вызовом инструмента пустыми не считаются");
    }
  );
});

test("двух пустых ходов мало — порог не срабатывает", async () => {
  await withRun({ PI_FAKE_TURNS: "2", PI_FAKE_THINK: "8000" }, async ({ cwd, nudges, env }) => {
    await runPiRpcTurn({ cwd, prompt: "задача", sandbox: null, settleGraceMs: 200, env });
    assert.equal(nudges().length, 0);
  });
});

test("короткое размышление кругом не считается, сколько бы ходов ни было", async () => {
  await withRun({ PI_FAKE_TURNS: "10", PI_FAKE_THINK: "300" }, async ({ cwd, nudges, env }) => {
    await runPiRpcTurn({ cwd, prompt: "задача", sandbox: null, settleGraceMs: 200, env });
    assert.equal(nudges().length, 0);
  });
});

test("вмешательств не больше отведённого числа за прогон", async () => {
  // Иначе подсказка превращается в разговор и сама съедает прогон.
  await withRun({ PI_FAKE_TURNS: "30", PI_FAKE_THINK: "8000", PI_FAKE_KEEP_LOOPING: "1" }, async ({ cwd, nudges, env }) => {
    const result = await runPiRpcTurn({ cwd, prompt: "задача", sandbox: null, settleGraceMs: 200, env });
    assert.ok(nudges().length <= MAX_LOOP_NUDGES, `ждали ≤${MAX_LOOP_NUDGES}, получили ${nudges().length}`);
    assert.equal(result.loopNudges, nudges().length);
  });
});

test("off-switch выключает вмешательство", async () => {
  await withRun({ PI_FAKE_TURNS: "10", PI_FAKE_THINK: "8000", PI_LOOP_NUDGE: "0" }, async ({ cwd, nudges, env }) => {
    const result = await runPiRpcTurn({ cwd, prompt: "задача", sandbox: null, settleGraceMs: 200, env });
    assert.equal(nudges().length, 0);
    assert.equal(result.loopNudges, 0);
  });
});

test("вмешательство доезжает до работающего агента, а не отбивается", async () => {
  // Голый prompt в занятого агента pi отвергает — «Agent is already processing.
  // Specify streamingBehavior» — и вмешательство не случается вовсе. Дефект был
  // невидим: команда уходила в stdin, счётчик её засчитывал, а до модели она не
  // доезжала.
  await withRun({ PI_FAKE_TURNS: "5", PI_FAKE_THINK: "8000" }, async ({ cwd, nudges, env }) => {
    const result = await runPiRpcTurn({ cwd, prompt: "задача", sandbox: null, settleGraceMs: 200, env });
    assert.equal(nudges().length, 1);
    assert.equal(nudges()[0].streamingBehavior, "steer", "занятому агенту сообщение ставится в очередь хода");
    assert.deepEqual(
      result.errors.filter((line) => line.includes("rejected")),
      [],
      "pi ничего не отверг"
    );
    assert.equal(result.loopNudges, 1);
  });
});

test("на обрыв, признанный кругом, уходит вмешательство ВМЕСТО продолжения", async () => {
  // «Продолжи ровно с места обрыва» и «не продолжай, прими решение» в одном
  // ходе противоречат друг другу: на живом прогоне модель ответила на это
  // словами «сообщения сбивают с толку» и осталась в круге.
  await withRun(
    {
      PI_FAKE_TURNS: "1",
      PI_FAKE_THINK: "8000",
      PI_FAKE_TRUNCATE: "1",
      PI_FAKE_KEEP_LOOPING: "1",
      PI_TRUNCATION_RETRIES: "6"
    },
    async ({ cwd, nudges, continuations, turns, env }) => {
      const result = await runPiRpcTurn({ cwd, prompt: "задача", sandbox: null, settleGraceMs: 200, env });
      assert.ok(nudges().length >= 1, "круг из обрывов замечен");
      assert.equal(nudges()[0].streamingBehavior, undefined, "осевшему агенту сообщение уходит обычным промптом");
      assert.deepEqual(
        result.errors.filter((line) => line.includes("rejected")),
        [],
        "pi ничего не отверг"
      );
      // Ровно одно сообщение на обрыв, и ни одного лишнего: сумма продолжений и
      // вмешательств не превышает числа оборванных ходов. Строгого равенства
      // здесь нет — на последнем обрыве лимит продолжений уже исчерпан, и
      // прогон честно заканчивается обрезанным, ничего не отправляя.
      assert.ok(
        continuations().length + nudges().length <= turns().length,
        `продолжений ${continuations().length} + вмешательств ${nudges().length} против ходов ${turns().length}`
      );
      assert.equal(result.loopNudges, nudges().length);
    }
  );
});

test("отказ на вмешательство не обрывает прогон и не подменяет отказ продолжения", async () => {
  // Отказать pi может и по своей причине (расширение, компакция). Обработчик
  // отказа сверяет id: без сверки отбитый нудж возвращал бы детектор завершения
  // вместо продолжения — и прогон закрывался бы, пока продолжение ещё в полёте.
  await withRun(
    { PI_FAKE_TURNS: "5", PI_FAKE_THINK: "8000", PI_FAKE_REJECT_NUDGE: "1" },
    async ({ cwd, nudges, env }) => {
      const result = await runPiRpcTurn({ cwd, prompt: "задача", sandbox: null, settleGraceMs: 200, env });
      assert.equal(nudges().length, 1, "вмешательство отправлено");
      assert.ok(
        result.errors.some((line) => line.includes("rejected")),
        "отказ виден в ошибках прогона, а не проглочен"
      );
      // Прогон доходит до конца сам: агент оседает, ничего не ждёт впустую.
      assert.ok(!result.errors.some((line) => line.includes("never picked up")), result.errors.join(" | "));
    }
  );
});
