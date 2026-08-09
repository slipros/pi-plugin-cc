import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { binaryAvailable, runCommand } from "./process.mjs";

/**
 * Sandboxing for pi runs.
 *
 * pi has no sandbox of its own: built-in tools, `!` commands and extensions all
 * run with the permissions of the pi process. The isolation therefore has to
 * come from outside, and the simplest boundary is to run the whole process in a
 * container — the "Plain Docker" pattern from pi's own containerization docs.
 *
 * The container gets exactly two things from the host: the workspace, bind
 * mounted at /workspace, and provider credentials. Everything else (settings,
 * sessions, installed pi packages) lives in a named volume, so a sandboxed run
 * cannot read or rewrite the host agent directory.
 */

export const DEFAULT_SANDBOX_IMAGE = "pi-plugin-sandbox:latest";
export const DEFAULT_SANDBOX_VOLUME = "pi-plugin-agent";

/** Paths inside the container. */
const WORKDIR = "/workspace";
const AGENT_DIR = "/pi-agent";
const CONTAINER_HOME = "/home/pi";
const LABEL = "pi-plugin-cc";

const SANDBOX_DEFAULTS = {
  mode: "docker",
  image: DEFAULT_SANDBOX_IMAGE,
  network: "bridge",
  // Where the container's ~/.pi/agent comes from: "volume" (isolated),
  // "host" (shares host settings, sessions and credentials) or a path.
  agentDir: "volume",
  volume: DEFAULT_SANDBOX_VOLUME,
  // Bind mount the host auth.json read-only so the agent can reach providers
  // without the rest of the host agent directory coming along.
  auth: true,
  user: "current",
  env: [],
  mounts: [],
  args: [],
  // Tooling the agent only gets inside this sandbox: extensions and skills
  // whose paths exist in the container, not on the host.
  extensions: [],
  skills: []
};

const DISABLED = new Set(["none", "off", "false", "no", "host"]);

function asList(value) {
  if (value == null) {
    return [];
  }
  return (Array.isArray(value) ? value : String(value).split(","))
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

function unknownProfile(name, profiles) {
  const available = Object.keys(profiles ?? {});
  return new Error(
    available.length
      ? `Unknown sandbox "${name}". Use docker, none, or a sandbox profile: ${available.join(", ")}.`
      : `Unknown sandbox "${name}". Use docker or none, or define "${name}" under "sandboxProfiles" in the config.`
  );
}

/**
 * Turn a config value or `--sandbox` flag into a normalized descriptor.
 *
 * Accepts `"docker"`, `"none"`, `true`/`false`, the name of a profile from
 * `sandboxProfiles`, and a full object — so a preset can name the toolchain its
 * agent needs (`"sandbox": "go"`) while a flag still flips the mode for one run.
 *
 * @returns {{mode: "none"} | object}
 */
export function normalizeSandbox(value, profiles = {}) {
  if (value == null || value === false || value === "") {
    return { mode: "none" };
  }
  if (value === true) {
    return { ...SANDBOX_DEFAULTS };
  }
  if (typeof value === "string") {
    const name = value.trim();
    const mode = name.toLowerCase();
    if (DISABLED.has(mode)) {
      return { mode: "none" };
    }
    if (mode === "docker") {
      return { ...SANDBOX_DEFAULTS };
    }
    if (profiles?.[name]) {
      return normalizeSandbox({ ...profiles[name], profile: undefined }, profiles);
    }
    throw unknownProfile(name, profiles);
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid sandbox setting: ${JSON.stringify(value)}.`);
  }

  const mode = String(value.mode ?? "docker").trim().toLowerCase();
  if (DISABLED.has(mode)) {
    return { mode: "none" };
  }
  if (mode !== "docker") {
    throw new Error(`Unknown sandbox mode "${value.mode}". Supported modes: docker, none.`);
  }

  // A profile is the base; the object's own fields override it field by field.
  let base = SANDBOX_DEFAULTS;
  if (value.profile) {
    const profile = profiles?.[value.profile];
    if (!profile) {
      throw unknownProfile(value.profile, profiles);
    }
    base = { ...SANDBOX_DEFAULTS, ...profile };
  }

  const merged = { ...base, ...value, mode: "docker" };
  delete merged.profile;
  return {
    ...merged,
    env: asList(merged.env),
    mounts: asList(merged.mounts),
    args: asList(merged.args),
    extensions: asList(merged.extensions),
    skills: asList(merged.skills)
  };
}

export function isSandboxed(sandbox) {
  return Boolean(sandbox) && sandbox.mode && sandbox.mode !== "none";
}

/** Container names are derived from the job id, which is already docker-safe. */
export function containerNameForJob(jobId) {
  const slug = String(jobId ?? "job").replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^[^a-zA-Z0-9]+/, "");
  return `pi-plugin-${slug}`.slice(0, 60);
}

/** `~/go/bin:/gobin:ro` — only the host side of a mount can be a home path. */
function expandHome(value, homeDir) {
  return String(value).replace(/^~(?=\/|$)/, homeDir);
}

function resolveAgentMount(sandbox, homeDir) {
  if (sandbox.agentDir === "volume") {
    return { source: sandbox.volume || DEFAULT_SANDBOX_VOLUME, isolated: true };
  }
  if (sandbox.agentDir === "host") {
    return { source: path.join(homeDir, ".pi", "agent"), isolated: false };
  }
  return { source: path.resolve(expandHome(sandbox.agentDir, homeDir)), isolated: false };
}

/**
 * Build the argv for `docker run` that launches pi with the given pi arguments.
 * Pure, so the mapping is testable without a daemon.
 */
export function buildDockerRunArgs({
  sandbox,
  piArgs = [],
  cwd,
  containerName = null,
  identity = currentIdentity(),
  homeDir = os.homedir(),
  env = process.env
} = {}) {
  // --init reaps whatever the agent spawns; -i without -t keeps stdin a pipe,
  // which is what the JSONL control channel needs.
  const args = ["run", "--rm", "-i", "--init", "--label", `${LABEL}=1`];

  if (containerName) {
    args.push("--name", containerName);
  }
  if (sandbox.network) {
    args.push("--network", String(sandbox.network));
  }

  // Files the agent writes land on the host through the bind mount, so it has
  // to run as the calling user or the workspace fills up with root-owned files.
  if (sandbox.user && sandbox.user !== "root") {
    const user = sandbox.user === "current" ? identityString(identity) : String(sandbox.user);
    if (user) {
      args.push("--user", user);
    }
  }

  args.push("-e", `HOME=${CONTAINER_HOME}`);
  args.push("-e", `PI_CODING_AGENT_DIR=${AGENT_DIR}`);
  for (const entry of sandbox.env ?? []) {
    // `NAME` forwards the host value, `NAME=value` sets one for the container.
    if (entry.includes("=") || env[entry] != null) {
      args.push("-e", entry);
    }
  }

  args.push("-v", `${cwd}:${WORKDIR}`, "-w", WORKDIR);

  const agent = resolveAgentMount(sandbox, homeDir);
  args.push("-v", `${agent.source}:${AGENT_DIR}`);
  if (agent.isolated && sandbox.auth) {
    // Nested mount: docker applies the longer target path after the volume, so
    // the credentials file lands inside the otherwise container-local dir.
    const authFile = path.join(homeDir, ".pi", "agent", "auth.json");
    if (fs.existsSync(authFile)) {
      args.push("-v", `${authFile}:${AGENT_DIR}/auth.json:ro`);
    }
  }

  for (const mount of sandbox.mounts ?? []) {
    args.push("-v", expandHome(mount, homeDir));
  }
  args.push(...(sandbox.args ?? []));

  args.push(sandbox.image || DEFAULT_SANDBOX_IMAGE);
  args.push(...piArgs);
  return args;
}

export function currentIdentity() {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return null;
  }
  return { uid: process.getuid(), gid: process.getgid() };
}

function identityString(identity) {
  return identity ? `${identity.uid}:${identity.gid}` : null;
}

/**
 * Resolve what to actually spawn: pi itself, or docker wrapping pi.
 *
 * @returns {{command: string, args: string[], containerName: string|null}}
 */
export function resolveLaunch({ sandbox, binary, piArgs, cwd, jobId = null, env = process.env } = {}) {
  if (!isSandboxed(sandbox)) {
    return { command: binary, args: piArgs, containerName: null };
  }
  const containerName = jobId ? containerNameForJob(jobId) : null;
  return {
    command: "docker",
    args: buildDockerRunArgs({ sandbox, piArgs, cwd, containerName, env }),
    containerName
  };
}

function firstLine(text) {
  return String(text ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

/**
 * Check that the sandbox can actually start before a job is created — a
 * missing daemon or image is a setup problem, not a failed run.
 */
export function sandboxPreflight(sandbox) {
  if (!isSandboxed(sandbox)) {
    return { ok: true, errors: [], warnings: [] };
  }

  const errors = [];
  const warnings = [];

  if (!binaryAvailable("docker")) {
    errors.push("`docker` was not found on PATH. Install Docker, or run without `--sandbox`.");
    return { ok: false, errors, warnings };
  }

  const info = runCommand("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (info.status !== 0) {
    errors.push(
      `The Docker daemon is not reachable: ${firstLine(info.stderr) || firstLine(info.stdout) || "unknown error"}`
    );
    return { ok: false, errors, warnings };
  }

  const image = runCommand("docker", ["image", "inspect", sandbox.image, "--format", "{{.Id}}"]);
  if (image.status !== 0) {
    errors.push(
      `Sandbox image \`${sandbox.image}\` is missing. Build it with \`pi-companion.mjs sandbox build\`.`
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Warn about settings that mean something different inside the container than
 * they do on the host.
 */
export function sandboxRunWarnings(sandbox, { workspaceRoot, extensions = [], skills = [] } = {}) {
  if (!isSandboxed(sandbox)) {
    return [];
  }

  const warnings = [];
  if (String(sandbox.network) === "none") {
    warnings.push("Sandbox network is `none`; pi cannot reach a model provider and the run will fail.");
  }
  if (sandbox.agentDir === "host") {
    warnings.push("Sandbox mounts the host `~/.pi/agent`, so container code can read host sessions and credentials.");
  }

  // Paths the container does have: the workspace, the agent dir, and whatever
  // the profile mounts explicitly (the target is the middle field of -v).
  const containerPaths = [WORKDIR, AGENT_DIR, ...(sandbox.mounts ?? []).map((mount) => mount.split(":")[1]).filter(Boolean)];

  const root = path.resolve(workspaceRoot ?? ".");
  for (const [label, entries] of [["extension", extensions], ["skill", skills]]) {
    for (const entry of entries) {
      const value = String(entry ?? "");
      if (!/^[~./]|^[A-Za-z]:[\\/]/.test(value)) {
        continue; // npm: / git: sources are resolved inside the container.
      }
      if (containerPaths.some((target) => value === target || value.startsWith(`${target}/`))) {
        continue; // Already a path inside the container.
      }
      const resolved = path.resolve(root, value.replace(/^~(?=\/|$)/, os.homedir()));
      if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
        warnings.push(
          `The ${label} \`${value}\` is a host path outside the workspace; it does not exist inside the sandbox.`
        );
      }
    }
  }

  return warnings;
}

/** Killing the `docker run` client leaves the container up; this stops it. */
export function removeSandboxContainer(containerName) {
  if (!containerName) {
    return false;
  }
  return runCommand("docker", ["rm", "-f", containerName]).status === 0;
}

export function listSandboxContainers() {
  const result = runCommand("docker", [
    "ps",
    "-a",
    "--filter",
    `label=${LABEL}=1`,
    "--format",
    "{{.Names}}\t{{.Status}}\t{{.Image}}"
  ]);
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, status, image] = line.split("\t");
      return { name, status, image };
    });
}

/**
 * Everything `sandbox status` needs: whether docker is usable, whether the
 * image exists and which sandbox containers are still around.
 */
export function sandboxStatus(sandbox = null) {
  const image = sandbox?.image ?? DEFAULT_SANDBOX_IMAGE;
  const report = {
    image,
    dockerfile: sandboxDockerfile(),
    dockerAvailable: binaryAvailable("docker"),
    daemon: null,
    daemonError: null,
    imagePresent: false,
    imageCreated: null,
    containers: []
  };

  if (!report.dockerAvailable) {
    return report;
  }

  const info = runCommand("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (info.status !== 0) {
    report.daemonError = firstLine(info.stderr) || firstLine(info.stdout) || "unknown error";
    return report;
  }
  report.daemon = info.stdout.trim();

  const inspect = runCommand("docker", ["image", "inspect", image, "--format", "{{.Created}}"]);
  report.imagePresent = inspect.status === 0;
  report.imageCreated = report.imagePresent ? inspect.stdout.trim() : null;
  report.containers = listSandboxContainers();
  return report;
}

export function sandboxDockerfile() {
  return path.resolve(fileURLToPath(new URL("../../sandbox/Dockerfile", import.meta.url)));
}

/**
 * Build the sandbox image. Output is streamed straight through so the caller
 * sees docker's own progress instead of a silent wait.
 */
export function buildSandboxImage({ image = DEFAULT_SANDBOX_IMAGE, piVersion = null, noCache = false } = {}) {
  const dockerfile = sandboxDockerfile();
  const args = ["build", "-t", image, "-f", dockerfile];
  if (piVersion) {
    args.push("--build-arg", `PI_VERSION=${piVersion}`);
  }
  if (noCache) {
    args.push("--no-cache");
  }
  args.push(path.dirname(dockerfile));

  const result = spawnSync("docker", args, { stdio: "inherit" });
  return { status: result.status ?? 1, command: `docker ${args.join(" ")}` };
}

/** Description of the sandbox for reports and job records. */
export function describeSandbox(sandbox) {
  if (!isSandboxed(sandbox)) {
    return null;
  }
  const parts = [`docker \`${sandbox.image}\``];
  parts.push(sandbox.agentDir === "volume" ? `agent dir: volume \`${sandbox.volume}\`` : `agent dir: ${sandbox.agentDir}`);
  parts.push(`network: ${sandbox.network}`);
  return parts.join(", ");
}
