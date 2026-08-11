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

test("a gitconfig identity outranks the preset one, and flags outrank both", async () => {
  const { buildRunSettings } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { execFileSync } = await import("node:child_process");
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-identity-order-"));
  const repo = path.join(root, "repo");
  const gitConfig = path.join(root, "home.gitconfig");
  fs.writeFileSync(gitConfig, "[user]\n\tname = Personal\n\temail = me@example.dev\n");

  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_SYSTEM: "/dev/null", HOME: root };
  execFileSync("git", ["init", "-q", repo], { env });

  // A preset that names an agent identity — the fallback for trees where git
  // has no answer, not an override of the one the user configured.
  const config = { presets: { agent: { git: { name: "pi agent", email: "pi@example.dev" } } } };
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  try {
    assert.deepEqual(
      buildRunSettings({ command: "delegate", flags: { preset: "agent" }, workspaceRoot: repo, runRoot: repo, config }).git,
      { name: "Personal", email: "me@example.dev" },
      "the configured identity wins over the preset"
    );
    assert.deepEqual(
      buildRunSettings({
        command: "delegate",
        flags: { preset: "agent", "git-name": "Flag Name", "git-email": "flag@example.dev" },
        workspaceRoot: repo,
        runRoot: repo,
        config
      }).git,
      { name: "Flag Name", email: "flag@example.dev" },
      "an explicit flag is still the last word"
    );
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a worktree run mounts the repository it points at, an ordinary repo mounts nothing", async () => {
  const { resolveWorktreeMount } = await import("../plugins/pi/scripts/lib/git.mjs");
  const { execFileSync } = await import("node:child_process");
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-"));
  const main = path.join(root, "main");
  const tree = path.join(root, "tree");
  const run = (args, cwd) =>
    execFileSync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });

  try {
    run(["init", "-q", main], root);
    run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "init"], main);
    run(["worktree", "add", "-q", tree, "-b", "side"], main);

    // The worktree's .git is a file naming this path; the container has to see
    // it at exactly that path for git to resolve anything at all.
    const mounts = resolveWorktreeMount(tree);
    const gitDir = path.join(main, ".git");
    assert.equal(mounts[0], `${gitDir}:${gitDir}`, "the shared repository is writable");
    // hooks and config execute on the host, so the container only reads them.
    assert.ok(mounts.includes(`${path.join(gitDir, "hooks")}:${path.join(gitDir, "hooks")}:ro`));
    assert.ok(mounts.includes(`${path.join(gitDir, "config")}:${path.join(gitDir, "config")}:ro`));
    assert.equal(resolveWorktreeMount(main), null, "an ordinary repository carries its own .git");
    assert.equal(resolveWorktreeMount(root), null, "a plain directory is not a repository");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the event reader decodes only what was appended, and never half a line", async () => {
  const { createEventReader } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-events-")), "run.events.jsonl");
  const event = (index) => `${JSON.stringify({ type: "turn_start", index })}\n`;

  fs.writeFileSync(file, event(1) + event(2));
  const reader = createEventReader(file);

  const first = reader.read(0);
  assert.deepEqual(first.events.map((entry) => entry.index), [1, 2]);
  assert.equal(first.nextLine, 2);

  // Nothing new: no events, cursor unchanged.
  assert.deepEqual(reader.read(first.nextLine).events, []);

  // A write caught mid-line must not yield a broken event.
  fs.appendFileSync(file, '{"type":"turn_start","index":3}');
  assert.deepEqual(reader.read(2).events, [], "a line without its newline is held back");

  fs.appendFileSync(file, "\n" + event(4));
  const rest = reader.read(2);
  assert.deepEqual(rest.events.map((entry) => entry.index), [3, 4]);
  assert.equal(rest.nextLine, 4);

  // A shorter file means a different run: the reader starts over instead of
  // decoding from a meaningless offset.
  fs.writeFileSync(file, event(9));
  const restarted = reader.read(0);
  assert.deepEqual(restarted.events.map((entry) => entry.index), [9]);
  assert.equal(restarted.nextLine, 1);

  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
