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

test("--cwd resolves against the caller and rejects what is not a directory", async () => {
  const { resolveRunRoot } = await import("../plugins/pi/scripts/lib/workspace.mjs");
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runroot-"));
  fs.mkdirSync(path.join(base, "target"));
  fs.writeFileSync(path.join(base, "a-file"), "");

  assert.equal(resolveRunRoot("target", { cwd: base }), fs.realpathSync(path.join(base, "target")));
  assert.equal(resolveRunRoot(null, { cwd: base }), resolveRunRoot(undefined, { cwd: base }));
  assert.throws(() => resolveRunRoot("nope", { cwd: base }), /no such directory/);
  assert.throws(() => resolveRunRoot("a-file", { cwd: base }), /not a directory/);

  fs.rmSync(base, { recursive: true, force: true });
});

test("commit identity is read from the directory, so gitdir rules apply", async () => {
  const { resolveCommitIdentity } = await import("../plugins/pi/scripts/lib/git.mjs");
  const { execFileSync } = await import("node:child_process");
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-identity-"));
  const inner = path.join(root, "client-work");
  fs.mkdirSync(inner);

  // A config that switches identity below one subdirectory — the mechanism a
  // developer uses to keep work and personal commits apart.
  const includeFile = path.join(root, "client.gitconfig");
  fs.writeFileSync(includeFile, "[user]\n\tname = Client Name\n\temail = dev@client.example\n");
  const gitConfig = path.join(root, "home.gitconfig");
  fs.writeFileSync(
    gitConfig,
    `[user]\n\tname = Personal\n\temail = me@example.dev\n[includeIf "gitdir:${inner}/"]\n\tpath = ${includeFile}\n`
  );

  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_SYSTEM: "/dev/null", HOME: root };
  execFileSync("git", ["init", "-q", path.join(root, "repo")], { env });
  execFileSync("git", ["init", "-q", path.join(inner, "repo")], { env });

  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  try {
    assert.deepEqual(resolveCommitIdentity(path.join(root, "repo")), {
      name: "Personal",
      email: "me@example.dev"
    });
    assert.deepEqual(
      resolveCommitIdentity(path.join(inner, "repo")),
      { name: "Client Name", email: "dev@client.example" },
      "the narrower gitdir rule wins, which is the whole point"
    );
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
