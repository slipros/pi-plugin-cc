import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDockerRunArgs,
  containerNameForJob,
  describeSandbox,
  isSandboxed,
  normalizeSandbox,
  resolveLaunch,
  sandboxRunWarnings,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_SANDBOX_VOLUME
} from "../plugins/pi/scripts/lib/sandbox.mjs";

const IDENTITY = { uid: 1000, gid: 1000 };

/** Read the value that follows a flag, e.g. --network. */
function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

function mounts(args) {
  return args.filter((arg, index) => args[index - 1] === "-v");
}

test("no sandbox setting means no sandbox", () => {
  for (const value of [null, undefined, false, "", "none", "off", "host"]) {
    assert.equal(normalizeSandbox(value).mode, "none", `for ${JSON.stringify(value)}`);
    assert.equal(isSandboxed(normalizeSandbox(value)), false);
  }
});

test('"docker" expands to the full default profile', () => {
  const sandbox = normalizeSandbox("docker");
  assert.equal(sandbox.mode, "docker");
  assert.equal(sandbox.image, DEFAULT_SANDBOX_IMAGE);
  assert.equal(sandbox.volume, DEFAULT_SANDBOX_VOLUME);
  assert.equal(sandbox.agentDir, "volume");
  assert.equal(sandbox.network, "bridge");
});

test("an object overrides only the fields it names", () => {
  const sandbox = normalizeSandbox({ image: "custom:1", network: "none", env: "A, B" });
  assert.equal(sandbox.mode, "docker");
  assert.equal(sandbox.image, "custom:1");
  assert.equal(sandbox.network, "none");
  assert.deepEqual(sandbox.env, ["A", "B"]);
  assert.equal(sandbox.agentDir, "volume");
});

test("an object can switch the sandbox off", () => {
  assert.equal(normalizeSandbox({ mode: "none", image: "custom:1" }).mode, "none");
});

test("an unknown mode is rejected instead of silently ignored", () => {
  // A bare name is read as a sandbox profile, so the error points at the config.
  assert.throws(() => normalizeSandbox("gondolin"), /Unknown sandbox "gondolin"/);
  assert.throws(() => normalizeSandbox({ mode: "podman" }), /Unknown sandbox mode/);
});

test("docker run mounts the workspace and keeps the agent dir container-local", () => {
  const args = buildDockerRunArgs({
    sandbox: normalizeSandbox("docker"),
    piArgs: ["--mode", "rpc"],
    cwd: "/home/me/project",
    containerName: "pi-plugin-job",
    identity: IDENTITY,
    homeDir: "/nonexistent-home",
    env: {}
  });

  assert.deepEqual(args.slice(0, 4), ["run", "--rm", "-i", "--init"]);
  assert.equal(valueAfter(args, "--name"), "pi-plugin-job");
  assert.equal(valueAfter(args, "--user"), "1000:1000");
  assert.equal(valueAfter(args, "-w"), "/workspace");
  assert.ok(mounts(args).includes("/home/me/project:/workspace"));
  assert.ok(mounts(args).includes(`${DEFAULT_SANDBOX_VOLUME}:/pi-agent`));
  assert.ok(args.includes("HOME=/home/pi"));
  assert.ok(args.includes("PI_CODING_AGENT_DIR=/pi-agent"));

  // The image comes last, right before the arguments handed to pi.
  assert.deepEqual(args.slice(-3), [DEFAULT_SANDBOX_IMAGE, "--mode", "rpc"]);
});

test("agentDir host shares the host agent directory instead of a volume", () => {
  const args = buildDockerRunArgs({
    sandbox: normalizeSandbox({ agentDir: "host" }),
    cwd: "/work",
    identity: IDENTITY,
    homeDir: "/home/me",
    env: {}
  });
  assert.ok(mounts(args).includes("/home/me/.pi/agent:/pi-agent"));
  assert.ok(!mounts(args).some((mount) => mount.startsWith(`${DEFAULT_SANDBOX_VOLUME}:`)));
});

test("only environment variables that are actually set are forwarded", () => {
  const args = buildDockerRunArgs({
    sandbox: normalizeSandbox({ env: ["ANTHROPIC_API_KEY", "MISSING_KEY"] }),
    cwd: "/work",
    identity: IDENTITY,
    homeDir: "/nonexistent-home",
    env: { ANTHROPIC_API_KEY: "sk-test" }
  });
  assert.ok(args.includes("ANTHROPIC_API_KEY"));
  assert.ok(!args.includes("MISSING_KEY"));
});

test("extra mounts and raw docker arguments are passed through", () => {
  const args = buildDockerRunArgs({
    sandbox: normalizeSandbox({ mounts: ["/data:/data:ro"], args: ["--memory=2g"] }),
    cwd: "/work",
    identity: IDENTITY,
    homeDir: "/nonexistent-home",
    env: {}
  });
  assert.ok(mounts(args).includes("/data:/data:ro"));
  assert.ok(args.includes("--memory=2g"));
  assert.ok(args.indexOf("--memory=2g") < args.indexOf(DEFAULT_SANDBOX_IMAGE));
});

test("user root drops the --user flag so the container keeps its own uid", () => {
  const args = buildDockerRunArgs({
    sandbox: normalizeSandbox({ user: "root" }),
    cwd: "/work",
    identity: IDENTITY,
    homeDir: "/nonexistent-home",
    env: {}
  });
  assert.equal(valueAfter(args, "--user"), null);
});

test("without a sandbox the launch is plain pi", () => {
  const launch = resolveLaunch({
    sandbox: normalizeSandbox(null),
    binary: "pi",
    piArgs: ["--mode", "rpc"],
    cwd: "/work",
    jobId: "delegate-1"
  });
  assert.deepEqual(launch, { command: "pi", args: ["--mode", "rpc"], containerName: null });
});

test("a sandboxed launch runs docker and names the container after the job", () => {
  const launch = resolveLaunch({
    sandbox: normalizeSandbox("docker"),
    binary: "pi",
    piArgs: ["--mode", "rpc"],
    cwd: "/work",
    jobId: "delegate-abc123",
    env: {}
  });
  assert.equal(launch.command, "docker");
  assert.equal(launch.containerName, "pi-plugin-delegate-abc123");
  assert.ok(launch.args.includes("--mode"));
});

test("container names stay within what docker accepts", () => {
  assert.equal(containerNameForJob("delegate-1a2b3c"), "pi-plugin-delegate-1a2b3c");
  assert.equal(containerNameForJob("weird name/#1"), "pi-plugin-weird-name-1");
  assert.ok(containerNameForJob("x".repeat(200)).length <= 60);
});

test("host paths that will not exist in the container are flagged", () => {
  const warnings = sandboxRunWarnings(normalizeSandbox("docker"), {
    workspaceRoot: "/work",
    extensions: ["npm:pi-mcp-adapter", "/home/me/.pi/agent/extensions/gondolin", "./tools/local.ts"],
    skills: []
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /gondolin/);
});

test("a sandbox without network is called out, because the model call will fail", () => {
  const warnings = sandboxRunWarnings(normalizeSandbox({ network: "none" }), { workspaceRoot: "/work" });
  assert.ok(warnings.some((warning) => /cannot reach a model provider/.test(warning)));
});

test("sharing the host agent directory is called out as well", () => {
  const warnings = sandboxRunWarnings(normalizeSandbox({ agentDir: "host" }), { workspaceRoot: "/work" });
  assert.ok(warnings.some((warning) => /host sessions and credentials/.test(warning)));
});

test("the sandbox description names the image, agent dir and network", () => {
  assert.equal(describeSandbox(normalizeSandbox(null)), null);
  const description = describeSandbox(normalizeSandbox("docker"));
  assert.match(description, /docker `pi-plugin-sandbox:latest`/);
  assert.match(description, /volume `pi-plugin-agent`/);
  assert.match(description, /network: bridge/);
});

test("the host auth file is mounted read-only, and only when it exists", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-test-"));
  const build = () =>
    buildDockerRunArgs({
      sandbox: normalizeSandbox("docker"),
      cwd: "/work",
      identity: IDENTITY,
      homeDir,
      env: {}
    });

  try {
    const authFile = path.join(homeDir, ".pi", "agent", "auth.json");
    assert.ok(!mounts(build()).some((mount) => mount.includes("auth.json")));

    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, "{}\n", "utf8");
    assert.ok(mounts(build()).includes(`${authFile}:/pi-agent/auth.json:ro`));
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("an env entry with a value is set, not forwarded from the host", () => {
  const args = buildDockerRunArgs({
    sandbox: normalizeSandbox({ env: ["PATH=/gobin:/usr/bin", "HOME_ONLY_ON_HOST"] }),
    cwd: "/work",
    identity: IDENTITY,
    homeDir: "/nonexistent-home",
    env: {}
  });
  assert.ok(args.includes("PATH=/gobin:/usr/bin"));
  assert.ok(!args.includes("HOME_ONLY_ON_HOST"));
});

test("a mount can name the host side with ~", () => {
  const args = buildDockerRunArgs({
    sandbox: normalizeSandbox({ mounts: ["~/go/bin:/gobin:ro"] }),
    cwd: "/work",
    identity: IDENTITY,
    homeDir: "/home/me",
    env: {}
  });
  assert.ok(mounts(args).includes("/home/me/go/bin:/gobin:ro"));
});

test("a path that the profile mounts into the container is not warned about", () => {
  const sandbox = normalizeSandbox({ mounts: ["~/.pi/agent/extensions:/pi-agent/host-extensions:ro"] });
  const warnings = sandboxRunWarnings(sandbox, {
    workspaceRoot: "/work",
    extensions: ["/pi-agent/host-extensions/custom-gcl-precommit.ts", "/home/me/elsewhere/ext.ts"]
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /elsewhere/);
});

const PROFILES = {
  go: {
    mounts: ["~/go/bin:/gobin:ro", "~/.pi/agent/extensions:/pi-agent/host-extensions:ro"],
    env: ["PATH=/gobin:/usr/local/bin:/usr/bin:/bin"],
    extensions: ["/pi-agent/host-extensions/custom-gcl-precommit.ts"]
  }
};

test("a sandbox can be named: the profile carries the toolchain", () => {
  const sandbox = normalizeSandbox("go", PROFILES);
  assert.equal(sandbox.mode, "docker");
  assert.equal(sandbox.image, DEFAULT_SANDBOX_IMAGE, "unnamed fields keep their defaults");
  assert.deepEqual(sandbox.env, ["PATH=/gobin:/usr/local/bin:/usr/bin:/bin"]);
  assert.deepEqual(sandbox.extensions, ["/pi-agent/host-extensions/custom-gcl-precommit.ts"]);
});

test("a preset can start from a profile and override single fields", () => {
  const sandbox = normalizeSandbox({ profile: "go", network: "none" }, PROFILES);
  assert.equal(sandbox.network, "none");
  assert.deepEqual(sandbox.extensions, ["/pi-agent/host-extensions/custom-gcl-precommit.ts"]);
  assert.equal(sandbox.profile, undefined, "the profile reference does not leak into docker args");
});

test("an unknown profile name lists the profiles that do exist", () => {
  assert.throws(() => normalizeSandbox("rust", PROFILES), /sandbox profile: go/);
  assert.throws(() => normalizeSandbox({ profile: "rust" }, PROFILES), /sandbox profile: go/);
});

test("profile tooling reaches docker as mounts and environment, not as pi flags", () => {
  const args = buildDockerRunArgs({
    sandbox: normalizeSandbox("go", PROFILES),
    piArgs: ["--mode", "rpc"],
    cwd: "/work",
    identity: IDENTITY,
    homeDir: "/home/me",
    env: {}
  });
  assert.ok(mounts(args).includes("/home/me/go/bin:/gobin:ro"));
  assert.ok(args.includes("PATH=/gobin:/usr/local/bin:/usr/bin:/bin"));
  assert.ok(!args.includes("/pi-agent/host-extensions/custom-gcl-precommit.ts"));
});
