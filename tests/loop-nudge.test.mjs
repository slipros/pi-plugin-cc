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
const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const note = (entry) => fs.appendFileSync(log, JSON.stringify(entry) + "\\n");

let prompts = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  note(command);
  if (command.type === "get_state") {
    say({ type: "response", command: "get_state", success: true, data: { sessionId: "sess-nudge" } });
    return;
  }
  if (command.type !== "prompt") return;
  prompts += 1;
  say({ type: "response", command: "prompt", success: true });
  // Агент, послушавший вмешательство, перестаёт крутиться — если тест не просит
  // обратного (PI_FAKE_KEEP_LOOPING=1 нужен для проверки лимита).
  if (prompts > 1 && process.env.PI_FAKE_KEEP_LOOPING !== "1") {
    say({ type: "turn_start" });
    say({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 20 }, content: [{ type: "text", text: "решение принято" }] } });
    say({ type: "agent_settled" });
    return;
  }
  for (let i = 0; i < turns; i += 1) {
    const content = [{ type: "thinking", thinking: "думаю ".repeat(Math.ceil(bloatChars / 6)) }];
    if (withText) content.push({ type: "text", text: "и вот что решил " + i });
    say({ type: "turn_start" });
    say({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 20 }, content } });
  }
  say({ type: "agent_settled" });
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
  const nudges = () =>
    fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((command) => command.type === "prompt" && command.message === LOOP_NUDGE_PROMPT);
  return run({ cwd: dir, nudges, env: { ...process.env, PI_FAKE_LOG: log, ...env } });
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
