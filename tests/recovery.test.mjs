import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Восстановление после обрыва целиком, а не по частям.
 *
 * Чистые хелперы (`recoveryDecision`, `mergeRecoveredRun`) проверяются в
 * pi.test.mjs, и они же — простая половина: обрыв ломается в проводке. Здесь
 * вместо pi запускается скрипт-двойник, который отвечает заданной
 * последовательностью событий и записывает всё, что ему передали, — так видно
 * то, ради чего фича заведена: что второй запуск действительно случился, попал
 * в ТУ ЖЕ сессию и получил промпт продолжения.
 *
 * Двойник один на файл и переключается переменными окружения: путь к бинарю
 * `pi.mjs` читает один раз при импорте, поэтому подменять его между тестами
 * нечем — а вот окружение каждого прогона своё.
 */

const FAKE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-recovery-"));
const FAKE_BINARY = path.join(FAKE_ROOT, "fake-pi.mjs");

fs.writeFileSync(
  FAKE_BINARY,
  `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const log = process.env.PI_FAKE_LOG;
const truncations = Number(process.env.PI_FAKE_TRUNCATIONS ?? 1);
const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const note = (entry) => fs.appendFileSync(log, JSON.stringify(entry) + "\\n");

const answer = (nth, prefix) => {
  const cutOff = nth < truncations;
  say({ type: "turn_start" });
  say({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: cutOff ? "length" : "stop",
      usage: { input: 10, output: cutOff ? 500 : 20 },
      content: [{ type: "text", text: cutOff ? prefix + " " + nth : "конец" }]
    }
  });
};

if (process.argv.includes("rpc")) {
  let prompts = 0;
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const command = JSON.parse(line);
    note(command);
    if (command.type === "get_state") {
      say({ type: "response", command: "get_state", success: true, data: { sessionId: "sess-rpc" } });
      return;
    }
    if (command.type !== "prompt") {
      return;
    }
    prompts += 1;
    const isRecovery = prompts > 1;
    if (isRecovery && process.env.PI_FAKE_RECOVERY === "refuse") {
      say({ type: "response", command: "prompt", success: false, error: "busy" });
      return;
    }
    if (isRecovery && process.env.PI_FAKE_RECOVERY === "silent") {
      return;
    }
    say({ type: "response", command: "prompt", success: true });
    answer(prompts, "обрыв");
    say({ type: "agent_settled" });
  });
} else {
  const nth = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).length + 1 : 1;
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    prompt += chunk;
  });
  process.stdin.on("end", () => {
    note({ nth, args: process.argv.slice(2), prompt });
    say({ type: "session", id: "sess-7" });
    answer(nth, "половина");
    process.exit(0);
  });
}
`,
  { encoding: "utf8", mode: 0o755 }
);

process.env.PI_PLUGIN_BINARY = FAKE_BINARY;

const { CONTINUATION_PROMPT, runPiTurn } = await import("../plugins/pi/scripts/lib/pi.mjs");
const { runPiRpcTurn } = await import("../plugins/pi/scripts/lib/rpc.mjs");

test.after(() => {
  fs.rmSync(FAKE_ROOT, { recursive: true, force: true });
});

/** Свой журнал вызовов на каждый прогон: двойник дописывает в него, тест читает. */
function withRun(env, run) {
  const dir = fs.mkdtempSync(path.join(FAKE_ROOT, "run-"));
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(log, "", "utf8");
  const calls = () =>
    fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return run({ cwd: dir, calls, env: { ...process.env, PI_FAKE_LOG: log, ...env } });
}

test("json-движок: обрыв продолжается в той же сессии, а прогон остаётся одним", async () => {
  await withRun({ PI_FAKE_TRUNCATIONS: "2" }, async ({ cwd, calls, env }) => {
    const result = await runPiTurn({ cwd, prompt: "исходная задача", sandbox: null, env });

    const passes = calls();
    assert.equal(passes.length, 2, "обрыв на последнем ответе продолжается вторым проходом");
    assert.equal(passes[0].prompt, "исходная задача");
    assert.ok(!passes[0].args.includes("--session"), "первый проход начинает сессию");
    assert.deepEqual(
      passes[1].args.slice(passes[1].args.indexOf("--session")),
      ["--session", "sess-7"],
      "продолжение идёт в ту же сессию, а не начинает новую"
    );
    assert.equal(passes[1].prompt, CONTINUATION_PROMPT);

    assert.match(result.text, /половина 1/, "написанное до обрыва не выбрасывается");
    assert.match(result.text, /конец/, "и продолжение тоже в ответе");
    assert.deepEqual(result.usage, { input: 20, output: 520 }, "счётчики — за оба прохода");
    assert.equal(result.turns, 2);
    assert.equal(result.recoveredTruncations, 1);
    assert.equal(result.stopReason, "stop", "итог прогона — причина последнего ответа");
  });
});

test("json-движок: PI_TRUNCATION_RETRIES=0 выключает продолжение", async () => {
  await withRun({ PI_FAKE_TRUNCATIONS: "5", PI_TRUNCATION_RETRIES: "0" }, async ({ cwd, calls, env }) => {
    const result = await runPiTurn({ cwd, prompt: "исходная задача", sandbox: null, env });

    assert.equal(calls().length, 1, "ни одной попытки продолжения");
    assert.equal(result.stopReason, "length", "прогон честно возвращается обрезанным");
    assert.equal(result.recoveredTruncations, undefined);
  });
});

test("json-движок: попытки кончаются, а не идут бесконечно", async () => {
  // Двойник обрывается всегда — как застрявшая в повторе модель.
  await withRun({ PI_FAKE_TRUNCATIONS: "99", PI_TRUNCATION_RETRIES: "2" }, async ({ cwd, calls, env }) => {
    const result = await runPiTurn({ cwd, prompt: "исходная задача", sandbox: null, env });

    assert.equal(calls().length, 3, "исходный проход и ровно две попытки");
    assert.equal(result.stopReason, "length");
    assert.equal(result.recoveredTruncations, 2);
  });
});

test("rpc-движок: обрыв продолжается промптом в живой канал той же сессии", async () => {
  await withRun({ PI_FAKE_TRUNCATIONS: "2" }, async ({ cwd, calls, env }) => {
    const result = await runPiRpcTurn({ cwd, prompt: "исходная задача", sandbox: null, settleGraceMs: 200, env });

    const prompts = calls().filter((command) => command.type === "prompt");
    assert.equal(prompts.length, 2, "продолжение отправлено");
    assert.equal(prompts[1].message, CONTINUATION_PROMPT);
    assert.equal(prompts[1].id, "recover-1", "нумерация восстановлений видна в журнале команд");
    assert.equal(result.recoveredTruncations, 1, "прогон сообщает, сколько раз себя вытаскивал");
    assert.equal(result.stopReason, "stop");
    assert.equal(result.exitStatus, 0);
    // Движок по умолчанию — этот, и половина, написанная до обрыва, теряться
    // здесь не должна тем более: прогон отдаёт как ответ последнее сообщение,
    // а последним оказывается продолжение.
    assert.match(result.text, /обрыв 1/, "написанное до обрыва осталось в ответе");
    assert.match(result.text, /конец/, "и продолжение тоже");
    assert.match(result.text, /продолжение после обрыва/, "шов помечен, потому что он в середине фразы");
  });
});

test("rpc-движок: исчерпанные попытки отдают всё написанное, а не последний огрызок", async () => {
  await withRun({ PI_FAKE_TRUNCATIONS: "99", PI_TRUNCATION_RETRIES: "2" }, async ({ cwd, calls, env }) => {
    const result = await runPiRpcTurn({ cwd, prompt: "исходная задача", sandbox: null, settleGraceMs: 200, env });

    assert.equal(calls().filter((command) => command.type === "prompt").length, 3, "исходный и две попытки");
    assert.equal(result.recoveredTruncations, 2);
    assert.equal(result.stopReason, "length", "прогон так и остался обрезанным");
    for (const piece of ["обрыв 1", "обрыв 2", "обрыв 3"]) {
      assert.match(result.text, new RegExp(piece), `кусок «${piece}» на месте`);
    }
  });
});

test("rpc-движок: отклонённое продолжение завершает прогон, а не подвешивает его", async () => {
  await withRun({ PI_FAKE_TRUNCATIONS: "9", PI_FAKE_RECOVERY: "refuse" }, async ({ cwd, calls, env }) => {
    const startedAt = Date.now();
    const result = await runPiRpcTurn({
      cwd,
      prompt: "исходная задача",
      sandbox: null,
      settleGraceMs: 200,
      // Таймауты большие: если бы отказ не возвращал детектор завершения,
      // прогон стоял бы до одного из них.
      timeoutMs: 60_000,
      recoveryAckMs: 30_000,
      env
    });

    assert.ok(Date.now() - startedAt < 20_000, "прогон закончился сам, без hard-таймаута");
    assert.equal(calls().filter((command) => command.type === "prompt").length, 2);
    assert.ok(
      result.errors.some((message) => /rejected "prompt"/.test(message)),
      "отказ pi виден в отчёте"
    );
    assert.equal(result.stopReason, "length", "прогон остаётся обрезанным — это и есть правда о нём");
  });
});

test("rpc-движок: продолжение, которое никто не подхватил, не держит прогон до таймаута", async () => {
  // Двойник принимает продолжение и молчит: ни хода, ни отказа. Раньше это
  // выключало детектор завершения навсегда, и прогон стоял до hard-таймаута —
  // три часа на боевых пресетах.
  await withRun({ PI_FAKE_TRUNCATIONS: "9", PI_FAKE_RECOVERY: "silent" }, async ({ cwd, env }) => {
    const startedAt = Date.now();
    const result = await runPiRpcTurn({
      cwd,
      prompt: "исходная задача",
      sandbox: null,
      settleGraceMs: 200,
      timeoutMs: 60_000,
      recoveryAckMs: 500,
      env
    });

    assert.ok(Date.now() - startedAt < 20_000, "прогон закрылся по ack-таймауту продолжения");
    assert.ok(
      result.errors.some((message) => /never picked up the continuation/.test(message)),
      "и говорит, почему закончил"
    );
    assert.equal(result.timedOut, false, "это не hard-таймаут прогона");
  });
});
