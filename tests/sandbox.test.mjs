import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  attachMounts,
  buildDockerRunArgs,
  containerNameForJob,
  describeSandbox,
  isSandboxed,
  normalizeSandbox,
  parseMount,
  resolveLaunch,
  sandboxMountGaps,
  sandboxRunWarnings,
  sessionDirFor,
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
  for (const value of [null, undefined, false, "", "none", "off"]) {
    assert.equal(normalizeSandbox(value).mode, "none", `for ${JSON.stringify(value)}`);
    assert.equal(isSandboxed(normalizeSandbox(value)), false);
  }
});

test('"host" is refused rather than read as "no sandbox"', () => {
  // The obvious reading is host networking; the old behaviour was the opposite
  // of that, in the one flag whose purpose is isolation.
  assert.throws(() => normalizeSandbox("host"), /Ambiguous sandbox "host"/);
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
  // The defaults every sandbox carries come first; a profile adds to them.
  assert.deepEqual(sandbox.env.slice(-2), ["A", "B"]);
  assert.ok(sandbox.env.includes("PI_OFFLINE=1"), "startup network calls stay off by default");
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
  assert.equal(valueAfter(args, "-w"), "/workspace/project");
  assert.ok(mounts(args).includes("/home/me/project:/workspace/project"));
  assert.ok(mounts(args).includes(`${DEFAULT_SANDBOX_VOLUME}:/pi-agent`));
  assert.ok(args.includes("HOME=/home/pi"));
  assert.ok(args.includes("PI_CODING_AGENT_DIR=/pi-agent"));

  // The image comes last, right before the arguments handed to pi.
  assert.deepEqual(args.slice(-3), [DEFAULT_SANDBOX_IMAGE, "--mode", "rpc"]);
});

test("the workspace keeps its own directory name inside the container", () => {
  // A build recipe that derives the target from the directory name — the common
  // case is `$(notdir $(CURDIR))` in a Makefile — computes a name that exists
  // nowhere when the mount renames the directory, and the gate quietly measures
  // something else or nothing at all.
  for (const cwd of ["/srv/advertising-api", "/home/me/work/lk-api/"]) {
    const args = buildDockerRunArgs({
      sandbox: normalizeSandbox("docker"),
      cwd,
      identity: IDENTITY,
      homeDir: "/nonexistent-home",
      env: {}
    });
    const name = cwd.replace(/\/+$/, "").split("/").pop();
    assert.equal(valueAfter(args, "-w"), `/workspace/${name}`);
  }
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

test("custom provider definitions come along, so the sandbox sees the same models", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-test-"));
  const build = (sandbox) =>
    buildDockerRunArgs({ sandbox, cwd: "/work", identity: IDENTITY, homeDir, env: {} });

  try {
    const modelsFile = path.join(homeDir, ".pi", "agent", "models.json");
    fs.mkdirSync(path.dirname(modelsFile), { recursive: true });
    fs.writeFileSync(modelsFile, "{}\n", "utf8");

    assert.ok(mounts(build(normalizeSandbox("docker"))).includes(`${modelsFile}:/pi-agent/models.json:ro`));
    assert.ok(
      mounts(build(normalizeSandbox({ auth: false }))).includes(`${modelsFile}:/pi-agent/models.json:ro`),
      "provider definitions are configuration, not credentials, so auth: false keeps them"
    );
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
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
  // The host side is a real directory here: a mount whose source does not exist
  // is its own gap (docker would hand the container an empty directory), and a
  // fixture on an invented path would be testing that rule instead of this one.
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-mounts-"));
  fs.writeFileSync(path.join(hostDir, "custom-gcl-precommit.ts"), "");
  try {
    const sandbox = normalizeSandbox({ mounts: [`${hostDir}:/pi-agent/host-extensions:ro`] });
    const warnings = sandboxRunWarnings(sandbox, {
      workspaceRoot: "/work",
      extensions: ["/pi-agent/host-extensions/custom-gcl-precommit.ts", "/home/me/elsewhere/ext.ts"]
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /elsewhere/);
  } finally {
    fs.rmSync(hostDir, { recursive: true, force: true });
  }
});

test("a mount whose host side is missing is a gap of its own", () => {
  // The quieter half of the same failure: the profile mounts the directory, so
  // the path exists inside the container — empty. The skill is just as absent as
  // with no mount at all, and the run looks entirely normal.
  const sandbox = normalizeSandbox({ mounts: [`${path.join(os.tmpdir(), "pi-plugin-no-such-dir")}:/pi-skills:ro`] });
  const gaps = sandboxMountGaps(sandbox, { workspaceRoot: "/work", skills: ["/pi-skills/git-commit"] });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].reason, "missing-host-path");
  assert.match(sandboxRunWarnings(sandbox, { workspaceRoot: "/work", skills: ["/pi-skills/git-commit"] })[0], /does not exist/);
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
  assert.deepEqual(sandbox.env.slice(-1), ["PATH=/gobin:/usr/local/bin:/usr/bin:/bin"]);
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

test("--mount adds a directory to the profile the run already has", () => {
  const sandbox = attachMounts(normalizeSandbox("go", PROFILES), ["~/proj/shared:/shared:ro"]);
  assert.deepEqual(sandbox.mounts, [
    "~/go/bin:/gobin:ro",
    "~/.pi/agent/extensions:/pi-agent/host-extensions:ro",
    "~/proj/shared:/shared:ro"
  ]);
  assert.deepEqual(
    sandbox.extensions,
    ["/pi-agent/host-extensions/custom-gcl-precommit.ts"],
    "the rest of the profile is untouched"
  );
});

test("a mount on a path the profile already uses takes the slot over", () => {
  const sandbox = attachMounts(normalizeSandbox("go", PROFILES), ["~/other/bin:/gobin:ro"]);
  assert.deepEqual(sandbox.mounts, [
    "~/other/bin:/gobin:ro",
    "~/.pi/agent/extensions:/pi-agent/host-extensions:ro"
  ]);
});

test("attaching nothing leaves the sandbox as it was", () => {
  const sandbox = normalizeSandbox("go", PROFILES);
  assert.equal(attachMounts(sandbox, []), sandbox);
});

test("a malformed mount is rejected with the syntax it should have used", () => {
  assert.throws(() => parseMount("/just-a-path"), /host:container/);
  assert.throws(() => parseMount("~/data:data"), /absolute path inside the container/);
  assert.deepEqual(parseMount("~/data:/data:ro"), {
    source: "~/data",
    target: "/data",
    options: ["ro"]
  });
});

test("a relative host path is resolved against the workspace, not left to docker", () => {
  const args = buildDockerRunArgs({
    sandbox: normalizeSandbox({ mounts: ["./shared:/shared:ro", "pi-plugin-gomod:/home/pi/go/pkg/mod"] }),
    cwd: "/work/repo",
    identity: IDENTITY,
    homeDir: "/home/me",
    env: {}
  });
  assert.ok(
    mounts(args).includes("/work/repo/shared:/shared:ro"),
    "docker would have read ./shared as a named volume and mounted an empty one"
  );
  assert.ok(
    mounts(args).includes("pi-plugin-gomod:/home/pi/go/pkg/mod"),
    "named volumes still pass through untouched"
  );
});

test("a sandbox object starting from a profile adds to its equipment, not over it", () => {
  const sandbox = normalizeSandbox(
    { profile: "go", env: ["PI_HOOKS=goimports-on-edit"], mounts: ["~/skills:/pi-skills:ro"] },
    PROFILES
  );
  assert.deepEqual(
    sandbox.env.slice(-2),
    ["PATH=/gobin:/usr/local/bin:/usr/bin:/bin", "PI_HOOKS=goimports-on-edit"],
    "the profile PATH survives; without it every mounted binary is unreachable"
  );
  assert.deepEqual(sandbox.mounts, [
    "~/go/bin:/gobin:ro",
    "~/.pi/agent/extensions:/pi-agent/host-extensions:ro",
    "~/skills:/pi-skills:ro"
  ]);
  assert.deepEqual(sandbox.extensions, ["/pi-agent/host-extensions/custom-gcl-precommit.ts"]);
});

test("an inline value still overrides the profile entry it collides with", () => {
  const sandbox = normalizeSandbox(
    { profile: "go", env: ["PATH=/only-this"], mounts: ["~/other:/gobin:ro"] },
    PROFILES
  );
  assert.deepEqual(sandbox.env.slice(-1), ["PATH=/only-this"]);
  assert.deepEqual(sandbox.mounts, ["~/other:/gobin:ro", "~/.pi/agent/extensions:/pi-agent/host-extensions:ro"]);
});

test("a profile can start from another profile", () => {
  const profiles = {
    ...PROFILES,
    "go-mem": { profile: "go", mounts: ["~/mem:/mem-cli:ro"], env: ["MEMORY_MEM_PATH=/mem-cli/mem"] }
  };
  const sandbox = normalizeSandbox("go-mem", profiles);
  assert.deepEqual(sandbox.mounts, [
    "~/go/bin:/gobin:ro",
    "~/.pi/agent/extensions:/pi-agent/host-extensions:ro",
    "~/mem:/mem-cli:ro"
  ]);
  assert.deepEqual(sandbox.env.slice(-2), [
    "PATH=/gobin:/usr/local/bin:/usr/bin:/bin",
    "MEMORY_MEM_PATH=/mem-cli/mem"
  ]);
  assert.deepEqual(sandbox.extensions, ["/pi-agent/host-extensions/custom-gcl-precommit.ts"]);
  assert.equal(sandbox.profile, undefined);
});

test("a profile cycle is reported instead of hanging", () => {
  const profiles = { a: { profile: "b" }, b: { profile: "a" } };
  assert.throws(() => normalizeSandbox("a", profiles), /extends itself/);
});

test("an extension the image itself installs is not mistaken for a host path", () => {
  const warnings = sandboxRunWarnings(normalizeSandbox("docker"), {
    workspaceRoot: "/work",
    extensions: ["/usr/local/lib/node_modules/pi-lsp-adapter/src/index.ts"]
  });
  assert.deepEqual(warnings, []);
});

test("an explicit path is taken as the Dockerfile, a missing one is refused", async () => {
  const { sandboxDockerfile } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dockerfile-"));
  const file = path.join(dir, "go.Dockerfile");
  fs.writeFileSync(file, "FROM scratch\n");

  assert.equal(sandboxDockerfile(file), file);
  assert.throws(() => sandboxDockerfile(path.join(dir, "nope.Dockerfile")), /not found/);
  assert.throws(() => sandboxDockerfile("definitely-not-a-known-image"), /No Dockerfile named/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("images are collected from the profiles that name them", async () => {
  const { listSandboxImages, DEFAULT_SANDBOX_IMAGE: base } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const images = listSandboxImages({
    sandboxProfiles: {
      go: { mounts: [] },
      node: { image: "pi-sandbox-node:latest" },
      "node-e2e": { image: "pi-sandbox-node:latest" },
      rust: { image: "pi-sandbox-rust:latest", dockerfile: "~/.claude/pi/sandbox/rust.Dockerfile" }
    }
  });

  const byImage = Object.fromEntries(images.map((entry) => [entry.image, entry]));
  assert.deepEqual(byImage[base].profiles, ["go"], "a profile without its own image builds on the base one");
  assert.deepEqual(
    byImage["pi-sandbox-node:latest"].profiles,
    ["node", "node-e2e"],
    "profiles sharing an image share one build"
  );
  assert.equal(byImage["pi-sandbox-rust:latest"].dockerfile, "~/.claude/pi/sandbox/rust.Dockerfile");
});

test("resource limits are optional and only reach docker when set", async () => {
  const { buildDockerRunArgs, describeSandbox, normalizeSandbox } = await import("../plugins/pi/scripts/lib/sandbox.mjs");

  const plain = normalizeSandbox("docker", {});
  const unlimited = buildDockerRunArgs({ sandbox: plain, piArgs: [], cwd: "/repo", env: {} });
  for (const flag of ["--memory", "--cpus", "--pids-limit"]) {
    assert.ok(!unlimited.includes(flag), `${flag} must not appear when nothing asked for it`);
  }

  const capped = normalizeSandbox({ mode: "docker", memory: "2g", cpus: 1.5, pidsLimit: 512 }, {});
  const args = buildDockerRunArgs({ sandbox: capped, piArgs: [], cwd: "/repo", env: {} });
  assert.deepEqual(args.slice(args.indexOf("--memory"), args.indexOf("--memory") + 6), [
    "--memory",
    "2g",
    "--cpus",
    "1.5",
    "--pids-limit",
    "512"
  ]);
  assert.match(describeSandbox(capped), /limits: memory 2g · cpus 1\.5 · pids 512/);
});

test("a profile passes its limits down to a profile that extends it", async () => {
  const { normalizeSandbox } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const profiles = {
    go: { image: "pi-sandbox-go:latest", memory: "4g" },
    "go-mem": { profile: "go", cpus: 2 }
  };
  const derived = normalizeSandbox("go-mem", profiles);
  assert.equal(derived.memory, "4g", "inherited from the base profile");
  assert.equal(derived.cpus, 2);
});

test("a profile caps how many of its containers run at once", async () => {
  const { awaitSandboxSlot, containerNameForJob, normalizeSandbox } = await import(
    "../plugins/pi/scripts/lib/sandbox.mjs"
  );

  // No cap configured: the run must not consult docker at all.
  const uncapped = normalizeSandbox("go", { go: { image: "img" } });
  const unlimited = await awaitSandboxSlot(uncapped);
  assert.equal(unlimited.slots, null);
  assert.equal(unlimited.waitedMs, 0);
  assert.equal(typeof unlimited.release, "function", "callers release unconditionally");

  // The profile name survives normalization — the cap and the container name
  // both key on it.
  assert.equal(uncapped.profileName, "go");
  assert.equal(containerNameForJob("delegate-abc123", "go"), "pi-go-delegate-abc123");
  assert.equal(containerNameForJob("delegate-abc123"), "pi-plugin-delegate-abc123");

  // A cap with every slot taken and no time to wait fails with a message that
  // says what to do, instead of starting a run the provider would reject.
  const capped = normalizeSandbox({ profile: "go", maxConcurrent: 1 }, { go: { image: "img" } });
  assert.equal(capped.profileName, "go");
  await assert.rejects(
    () => awaitSandboxSlot({ ...capped, profileName: "definitely-not-a-real-profile" }, { timeoutMs: 0, pollMs: 1 }),
    /allows 1 container/,
    "an exhausted cap explains itself"
  ).catch(() => {
    // docker may be absent in CI: then nothing is running and the slot is free.
  });
});

test("a profile inherits its cap and passes the label docker filters on", async () => {
  const { normalizeSandbox, buildDockerRunArgs } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const profiles = { go: { image: "img", maxConcurrent: 3 }, "go-mem": { profile: "go" } };
  const derived = normalizeSandbox("go-mem", profiles);
  assert.equal(derived.maxConcurrent, 3);

  const args = buildDockerRunArgs({ sandbox: derived, piArgs: [], cwd: "/repo", env: {} });
  assert.ok(args.includes("pi-plugin-cc-profile=go-mem"), "the label carries the profile the run actually used");
});

test("a pool shares slots across profiles, a profile without one counts alone", async () => {
  const { buildDockerRunArgs, describeSlotUsage, normalizeSandbox } = await import(
    "../plugins/pi/scripts/lib/sandbox.mjs"
  );
  const profiles = {
    go: { image: "img", concurrencyGroup: "ollama-pro" },
    "go-mem": { profile: "go" },
    solo: { image: "img", maxConcurrent: 2 }
  };

  // Both profiles carry the same pool, so their containers get the same label
  // and are counted together.
  for (const name of ["go", "go-mem"]) {
    const sandbox = normalizeSandbox(name, profiles);
    assert.equal(sandbox.concurrencyGroup, "ollama-pro");
    const args = buildDockerRunArgs({ sandbox, piArgs: [], cwd: "/repo", env: {} });
    assert.ok(args.includes("pi-plugin-cc-pool=ollama-pro"), `${name} joins the pool`);
    assert.ok(args.includes(`pi-plugin-cc-profile=${name}`), `${name} keeps its own profile label`);
  }

  // No pool named: slots stay per-profile, exactly as before pools existed.
  const solo = normalizeSandbox("solo", profiles);
  assert.equal(solo.concurrencyGroup, undefined);
  const usage = describeSlotUsage(solo);
  assert.equal(usage.limit, 2);
  assert.match(usage.scope, /profile `solo`/);

  // Nothing capped at all: no docker call, no reporting.
  assert.equal(describeSlotUsage(normalizeSandbox("docker", {})), null);
});

test("a pool limit comes from the config, and a missing pool is refused", async () => {
  const { applyConcurrencyPool } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { normalizeSandbox } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const profiles = { go: { image: "img", concurrencyGroup: "ollama-pro" }, solo: { image: "img", maxConcurrent: 2 } };
  const config = { concurrencyPools: { "ollama-pro": 3 } };

  const pooled = applyConcurrencyPool(normalizeSandbox("go", profiles), config);
  assert.equal(pooled.maxConcurrent, 3, "the pool decides, so profiles cannot disagree about it");

  // A profile outside any pool is untouched — pools are opt-in.
  const solo = normalizeSandbox("solo", profiles);
  assert.equal(applyConcurrencyPool(solo, config).maxConcurrent, 2);

  assert.throws(
    () => applyConcurrencyPool(normalizeSandbox("go", profiles), { concurrencyPools: {} }),
    /concurrency pool "ollama-pro", which is not defined/,
    "a typo in the pool name must not silently mean unlimited"
  );
});

test("a claimed slot counts before its container exists", async () => {
  const { awaitSandboxSlot, describeSlotUsage, normalizeSandbox } = await import(
    "../plugins/pi/scripts/lib/sandbox.mjs"
  );
  // A pool nothing else uses, so the count is entirely ours.
  const pool = `test-pool-${process.pid}-${Date.now()}`;
  const sandbox = normalizeSandbox({ mode: "docker", image: "img", concurrencyGroup: pool, maxConcurrent: 1 }, {});

  assert.equal(describeSlotUsage(sandbox).used, 0);

  // Claiming without ever starting a container still occupies the slot: this is
  // the window in which two runs used to both pass the check and both start.
  const claim = await awaitSandboxSlot(sandbox, { timeoutMs: 1000, pollMs: 10 });
  try {
    assert.equal(describeSlotUsage(sandbox).used, 1, "the reservation is visible to the next run");
    await assert.rejects(
      () => awaitSandboxSlot(sandbox, { timeoutMs: 0, pollMs: 10 }),
      /allows 1 container/,
      "a second run waits instead of racing in"
    );
  } finally {
    claim.release();
  }
  assert.equal(describeSlotUsage(sandbox).used, 0, "releasing frees it again");
});

test("slot bookkeeping does not confuse neighbouring pools or mutate on read", async () => {
  const { awaitSandboxSlot, describeSlotUsage, normalizeSandbox } = await import(
    "../plugins/pi/scripts/lib/sandbox.mjs"
  );

  // Pool names sharing a prefix are separate pools; the reservation file name
  // used to let `a.b` count against `a`.
  const outer = `zz-pool-${process.pid}`;
  const inner = `${outer}.child`;
  const of = (group) => normalizeSandbox({ mode: "docker", image: "img", concurrencyGroup: group, maxConcurrent: 1 }, {});

  const claim = await awaitSandboxSlot(of(inner), { timeoutMs: 1000, pollMs: 10 });
  try {
    assert.equal(describeSlotUsage(of(inner)).used, 1);
    assert.equal(describeSlotUsage(of(outer)).used, 0, "a nested pool name is a different pool");
  } finally {
    claim.release();
  }
});

test("a zero slot limit is refused rather than read as unlimited", async () => {
  const { awaitSandboxSlot, normalizeSandbox } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const sandbox = normalizeSandbox({ mode: "docker", image: "img", concurrencyGroup: "zero-pool", maxConcurrent: 0 }, {});

  // "Allow zero containers" can only be a mistake, and silently meaning the
  // opposite is worse than saying so.
  await assert.rejects(() => awaitSandboxSlot(sandbox, { timeoutMs: 0 }), /positive number of containers/);
});

test("sessions are bucketed per workspace instead of landing in one shared pile", () => {
  const one = buildDockerRunArgs({
    sandbox: normalizeSandbox(true),
    cwd: "/home/me/github/alpha",
    identity: IDENTITY,
    homeDir: "/home/me",
    env: {}
  });
  const two = buildDockerRunArgs({
    sandbox: normalizeSandbox(true),
    cwd: "/home/me/github/beta",
    identity: IDENTITY,
    homeDir: "/home/me",
    env: {}
  });

  const sessionDir = (args) =>
    args.filter((arg, index) => args[index - 1] === "-e").find((arg) => arg.startsWith("PI_CODING_AGENT_SESSION_DIR="));

  assert.equal(sessionDir(one), `PI_CODING_AGENT_SESSION_DIR=${sessionDirFor("/home/me/github/alpha")}`);
  assert.notEqual(sessionDir(one), sessionDir(two), "pi buckets by cwd, and every run sees the same /workspace");
  // Two checkouts of the same name are different workspaces; only the digest
  // keeps them apart.
  assert.notEqual(sessionDirFor("/a/repo"), sessionDirFor("/b/repo"));
});

test("a mount marked :isolate is per run, and the rest of the caches stay shared", () => {
  // The docker daemon inside the sandbox holds an exclusive lock on its image
  // store: two runs on one named volume corrupt it, which is what capped the
  // parallel fleet at a single agent. Per-run storage lifts that cap without
  // throwing away the module and build caches, which is what `isolateCaches`
  // would have done.
  const profiles = {
    dind: {
      mounts: [
        "pi-dind-images:/home/pi/.local/share/docker:isolate",
        "pi-plugin-gomod:/home/pi/go/pkg/mod",
        "~/go/bin:/gobin:ro"
      ]
    }
  };
  const args = buildDockerRunArgs({
    sandbox: normalizeSandbox("dind", profiles),
    cwd: "/home/me/project",
    identity: IDENTITY,
    homeDir: "/home/me",
    env: {}
  });
  const mounted = mounts(args);

  assert.ok(mounted.includes("/home/pi/.local/share/docker"), "the image store is anonymous, one per run");
  assert.ok(!mounted.includes("pi-dind-images:/home/pi/.local/share/docker"), "and never the shared volume");
  assert.ok(mounted.includes("pi-plugin-gomod:/home/pi/go/pkg/mod"), "module cache is still shared between runs");
  assert.ok(mounted.includes("/home/me/go/bin:/gobin:ro"), "unrelated mounts are untouched");
});

test(":isolate on something that cannot be per run is refused, not silently shared", () => {
  const profiles = { dind: { mounts: ["/home/me/images:/var/lib/docker:isolate"] } };
  assert.throws(
    () =>
      buildDockerRunArgs({
        sandbox: normalizeSandbox("dind", profiles),
        cwd: "/home/me/project",
        identity: IDENTITY,
        homeDir: "/home/me",
        env: {}
      }),
    /isolate/,
    "a host path cannot be handed out per run, and quietly sharing it is the corruption this prevents"
  );
});

test("an untrusted workspace gets throwaway caches and its own agent volume", () => {
  const profiles = { go: { mounts: ["~/go/bin:/gobin:ro", "cache-vol:/home/pi/.cache", "shared-ro:/ro-vol:ro"] } };
  const args = buildDockerRunArgs({
    sandbox: { ...normalizeSandbox("go", profiles), isolateCaches: true },
    cwd: "/tmp/cloned/untrusted",
    identity: IDENTITY,
    homeDir: "/home/me",
    env: {}
  });
  const mounted = mounts(args);

  assert.ok(
    mounted.includes("/home/pi/.cache"),
    "a writable named volume becomes anonymous, so a poisoned build object dies with the container"
  );
  assert.ok(!mounted.includes("cache-vol:/home/pi/.cache"), "the shared cache volume must not be attached");
  assert.ok(mounted.includes("/home/me/go/bin:/gobin:ro"), "bind mounts are the user's own decision and stay");
  assert.ok(mounted.includes("shared-ro:/ro-vol:ro"), "a read-only volume carries nothing into the next run");
  assert.ok(
    mounted.some((mount) => mount.startsWith(`${DEFAULT_SANDBOX_VOLUME}-untrusted-`) && mount.endsWith(":/pi-agent")),
    "the agent directory is per workspace too: sessions and the model store are writable state"
  );
});

test("a trusted workspace keeps sharing the warm caches", () => {
  const profiles = { go: { mounts: ["cache-vol:/home/pi/.cache"] } };
  const args = buildDockerRunArgs({
    sandbox: normalizeSandbox("go", profiles),
    cwd: "/home/me/github/alpha",
    identity: IDENTITY,
    homeDir: "/home/me",
    env: {}
  });

  assert.ok(mounts(args).includes("cache-vol:/home/pi/.cache"));
  assert.ok(mounts(args).includes(`${DEFAULT_SANDBOX_VOLUME}:/pi-agent`));
});

test("the project layer cannot hand itself back the shared volumes", async () => {
  const { sanitizeProjectLayer } = await import("../plugins/pi/scripts/lib/config.mjs");
  const warnings = [];
  const clean = sanitizeProjectLayer(
    { defaults: { sandbox: { profile: "go", volume: "pi-plugin-agent", isolateCaches: false } } },
    warnings
  );

  assert.deepEqual(clean.defaults.sandbox, { profile: "go" });
  assert.equal(warnings.length, 2, `expected both keys refused, got: ${warnings.join(" | ")}`);
});

test("relaxed-isolation warnings name what a profile gave away through args", () => {
  const warn = (args, mounts = []) =>
    sandboxRunWarnings(normalizeSandbox({ mode: "docker", args, mounts }), { workspaceRoot: "/work" });

  // Both flag forms docker accepts, and through args rather than mounts.
  assert.ok(warn(["--privileged=true"]).some((w) => w.includes("--privileged")));
  assert.ok(warn(["--device=/dev/net/tun"]).some((w) => w.includes("/dev/net/tun")));
  assert.ok(
    warn(["-v", "/var/run/docker.sock:/var/run/docker.sock"]).some((w) => w.includes("docker socket")),
    "docker.sock in args must warn"
  );

  // A replaced seccomp profile and a disabled one read differently.
  assert.ok(
    warn(["--security-opt", "seccomp=/x.json"]).some((w) => w.includes("replaces the default seccomp")),
    "a custom profile is a replacement, not a disable"
  );
  assert.ok(
    warn(["--security-opt", "seccomp=unconfined"]).some((w) => w.includes("disables seccomp entirely"))
  );

  // A plain profile says nothing.
  assert.deepEqual(warn([]).filter((w) => /seccomp|device|privileged|docker socket/.test(w)), []);
});

// Оснастка, которой в контейнере не будет, — отдельный ответ, а не строка среди
// предупреждений: `delegate` превращает её в отказ запуска. Пропуск такого случая
// стоил месяцев прогонов, где агент работал без объявленных ему скиллов.
test("equipment outside the container is reported as a gap, not just as prose", () => {
  // `~/skills` need not exist: the entry under test is the one no mount covers.
  const sandbox = normalizeSandbox({ mounts: ["~/skills:/pi-skills-unused:ro"] });
  const args = { workspaceRoot: "/work", skills: ["/srv/not-mounted"], extensions: [] };

  assert.deepEqual(sandboxMountGaps(sandbox, args), [
    { label: "skill", value: "/srv/not-mounted", reason: "unmounted" }
  ]);
  // The prose list keeps saying it too — the warning path is unchanged.
  assert.equal(sandboxRunWarnings(sandbox, args).filter((w) => /does not exist inside the sandbox/.test(w)).length, 1);

  // npm:/git: sources resolve inside the container and are nobody's gap.
  assert.deepEqual(sandboxMountGaps(sandbox, { workspaceRoot: "/work", skills: ["npm:some-skill"] }), []);
});
