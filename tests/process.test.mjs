import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { binaryAvailable, runCommand, terminateProcessTree } from "../plugins/pi/scripts/lib/process.mjs";
import { redactArgs } from "../plugins/pi/scripts/lib/pi.mjs";

test("runCommand captures stdout and the exit status", () => {
  const result = runCommand("node", ["-e", "process.stdout.write('hi')"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hi");
});

test("runCommand reports a missing binary instead of throwing", () => {
  const result = runCommand("definitely-not-a-real-binary-xyz", []);
  assert.notEqual(result.status, 0);
  assert.ok(result.error);
});

test("binaryAvailable finds node and rejects nonsense", () => {
  assert.equal(binaryAvailable("node"), true);
  assert.equal(binaryAvailable("definitely-not-a-real-binary-xyz"), false);
});

test("terminateProcessTree kills a detached child and its own children", async () => {
  const child = spawn("node", ["-e", "setTimeout(() => {}, 60000)"], {
    detached: true,
    stdio: "ignore"
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));

  assert.equal(await terminateProcessTree(child.pid, { group: true, graceMs: 2000 }), true);
  await exited;
  assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
});

test("terminateProcessTree is a no-op for a pid that is already gone", async () => {
  assert.equal(await terminateProcessTree(2_147_483_600), false);
  assert.equal(await terminateProcessTree(null), false);
  assert.equal(await terminateProcessTree(-1), false);
});

test("redactArgs hides prompt bodies but keeps the flags visible", () => {
  const args = [
    "--print",
    "--mode",
    "json",
    "--model",
    "opencode-go/glm-5.2",
    "--system-prompt",
    "a".repeat(2500),
    "--append-system-prompt",
    "short"
  ];
  assert.equal(
    redactArgs(args),
    "--print --mode json --model opencode-go/glm-5.2 --system-prompt <2500 chars> --append-system-prompt <5 chars>"
  );
});
