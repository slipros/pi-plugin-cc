import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * R5 целиком, а не по частям: безOtel проверяется в otel-export.test.mjs, но
 * там не видно, ГДЕ движки применяют её к спавну. Здесь вместо pi запускается
 * двойник, который логирует полученный PI_OTEL_ENABLE, — по одному прогону на
 * каждый из двух спавнов (lib/pi.mjs и lib/rpc.mjs).
 */

const FAKE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-otel-child-"));
const FAKE_BINARY = path.join(FAKE_ROOT, "fake-pi.mjs");

fs.writeFileSync(
  FAKE_BINARY,
  `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const log = process.env.PI_FAKE_LOG;
const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const note = () => fs.appendFileSync(log, JSON.stringify({ PI_OTEL_ENABLE: process.env.PI_OTEL_ENABLE }) + "\\n");

const answer = () => {
  say({ type: "turn_start" });
  say({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      usage: { input: 1, output: 1 },
      content: [{ type: "text", text: "конец" }]
    }
  });
  say({ type: "agent_settled" });
};

if (process.argv.includes("rpc")) {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const command = JSON.parse(line);
    if (command.type === "get_state") {
      say({ type: "response", command: "get_state", success: true, data: { sessionId: "sess-otel" } });
      return;
    }
    if (command.type !== "prompt") return;
    note();
    say({ type: "response", command: "prompt", success: true });
    answer();
  });
} else {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", () => {});
  process.stdin.on("end", () => {
    note();
    say({ type: "session", id: "sess-otel" });
    answer();
    process.exit(0);
  });
}
`,
  { encoding: "utf8", mode: 0o755 }
);

process.env.PI_PLUGIN_BINARY = FAKE_BINARY;

const { runPiTurn } = await import("../plugins/pi/scripts/lib/pi.mjs");
const { runPiRpcTurn } = await import("../plugins/pi/scripts/lib/rpc.mjs");

test.after(() => {
  fs.rmSync(FAKE_ROOT, { recursive: true, force: true });
});

/** Прогон через заданный движок; возвращает то, что двойник увидел в своём env. */
async function spawnChildEnv(run) {
  const dir = fs.mkdtempSync(path.join(FAKE_ROOT, "run-"));
  const log = path.join(dir, "child-env.jsonl");
  fs.writeFileSync(log, "", "utf8");
  await run({
    cwd: dir,
    env: { ...process.env, PI_FAKE_LOG: log, PI_OTEL_ENABLE: "1" }
  });
  const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length >= 1, true, "двойник не запустился");
  return JSON.parse(lines[0]).PI_OTEL_ENABLE;
}

test("R5: json-движок глушит PI_OTEL_ENABLE у дочернего pi", async () => {
  const seen = await spawnChildEnv(({ cwd, env }) =>
    runPiTurn({ cwd, prompt: "задача", sandbox: null, env })
  );
  assert.equal(seen, "0", "унаследованная единица доходит до ребёнка как ноль");
});

test("R5: rpc-движок глушит PI_OTEL_ENABLE у дочернего pi", async () => {
  const seen = await spawnChildEnv(({ cwd, env }) =>
    runPiRpcTurn({ cwd, prompt: "задача", sandbox: null, env, settleGraceMs: 200 })
  );
  assert.equal(seen, "0", "унаследованная единица доходит до ребёнка как ноль");
});
