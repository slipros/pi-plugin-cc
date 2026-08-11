import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { concatAdditive } from "./config.mjs";
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

const DISABLED = new Set(["none", "off", "false", "no"]);

/** A credential slice older than this belonged to a run that never cleaned up. */
const ABANDONED_SLICE_MS = 3_600_000;

/** How long a slot reservation is trusted before it is treated as abandoned. */
const RESERVATION_WINDOW_MS = 30_000;

/** File-name-safe key identifying one slot scope (a pool or a profile). */
function slotScopeKey(label, value) {
  return `${label}-${value}`.replace(/[^a-zA-Z0-9_.-]+/g, "-");
}

/**
 * Names that read as "some kind of sandbox" but used to disable it.
 *
 * `--sandbox host` meant "no container", while the obvious reading is host
 * networking — the flag whose entire job is isolation would then do the exact
 * opposite of what it was asked, silently. Refusing is the only safe answer.
 */
const AMBIGUOUS = new Map([
  ["host", 'Use `--sandbox none` to run without a container, or `{"network": "host"}` in the profile for host networking.']
]);

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
export function normalizeSandbox(value, profiles = {}, seen = new Set()) {
  if (value == null || value === false || value === "") {
    return { mode: "none" };
  }
  if (value === true) {
    return { ...SANDBOX_DEFAULTS };
  }
  if (typeof value === "string") {
    const name = value.trim();
    const mode = name.toLowerCase();
    if (AMBIGUOUS.has(mode)) {
      throw new Error(`Ambiguous sandbox "${name}". ${AMBIGUOUS.get(mode)}`);
    }
    if (DISABLED.has(mode)) {
      return { mode: "none" };
    }
    if (mode === "docker") {
      return { ...SANDBOX_DEFAULTS };
    }
    if (profiles?.[name]) {
      if (seen.has(name)) {
        throw new Error(`Sandbox profile "${name}" extends itself: ${[...seen, name].join(" → ")}.`);
      }
      // The name is kept so containers and concurrency limits can be told apart
      // per profile; normalizing to a plain object would otherwise lose it.
      return { ...normalizeSandbox(profiles[name], profiles, new Set([...seen, name])), profileName: name };
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
  // The base is resolved through the same function, so a profile may itself
  // start from another one — `go-mem` is `go` plus the memory CLI.
  let base = SANDBOX_DEFAULTS;
  if (value.profile) {
    if (!profiles?.[value.profile]) {
      throw unknownProfile(value.profile, profiles);
    }
    base = normalizeSandbox(String(value.profile), profiles, seen);
  }
  const profileName = value.profileName ?? base.profileName ?? (value.profile ? String(value.profile) : null);

  const merged = { ...base, ...value, mode: "docker", profileName };
  delete merged.profile;
  // Equipment adds to the profile instead of replacing it, exactly as config
  // layers do: `{"profile": "go", "env": ["PI_HOOKS=…"]}` means "the go
  // toolchain plus this variable", not "the go toolchain minus its PATH".
  for (const key of ["env", "mounts", "args", "extensions", "skills"]) {
    merged[key] = concatAdditive(key, asList(base[key]), asList(value[key]));
  }
  return merged;
}

export function isSandboxed(sandbox) {
  return Boolean(sandbox) && sandbox.mode && sandbox.mode !== "none";
}

/**
 * `host:container[:options]`, the docker `-v` syntax. The host side may be a
 * path or a named volume; the container side has to be an absolute path, and
 * getting that wrong is worth a clear message here rather than a docker error
 * after the job record already exists.
 */
export function parseMount(value) {
  const text = String(value ?? "").trim();
  const [source, target, ...options] = text.split(":");
  if (!source || !target) {
    throw new Error(`Invalid mount "${text}". Use host:container[:ro], e.g. ~/data:/data:ro.`);
  }
  if (!target.startsWith("/")) {
    throw new Error(`Invalid mount "${text}": "${target}" has to be an absolute path inside the container.`);
  }
  return { source, target, options };
}

/**
 * Add mounts to a sandbox on top of whatever its profile already carries.
 *
 * A later mount on the same container path replaces the inherited one, so a
 * run can redirect a profile's directory as well as add to it.
 */
export function attachMounts(sandbox, extra = []) {
  const mounts = asList(extra);
  if (!mounts.length) {
    return sandbox;
  }
  const merged = new Map();
  for (const mount of [...(sandbox.mounts ?? []), ...mounts]) {
    merged.set(parseMount(mount).target, mount);
  }
  return { ...sandbox, mounts: [...merged.values()] };
}

/**
 * Container name: the profile it runs, then the job id (already docker-safe).
 *
 * `docker ps` is where you look when something is stuck, and the profile is the
 * part that says what is inside — a name of only job ids answers "which run"
 * but never "which toolchain".
 */
export function containerNameForJob(jobId, profileName = null) {
  const safe = (value, fallback) =>
    String(value ?? fallback).replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^[^a-zA-Z0-9]+/, "");
  const prefix = profileName ? `pi-${safe(profileName, "profile")}` : "pi-plugin";
  return `${prefix}-${safe(jobId, "job")}`.slice(0, 60);
}

/** `~/go/bin:/gobin:ro` — only the host side of a mount can be a home path. */
function expandHome(value, homeDir) {
  return String(value).replace(/^~(?=\/|$)/, homeDir);
}

/**
 * Docker reads a relative host path as a named volume, so `./shared:/shared`
 * would silently create an empty volume instead of mounting the directory.
 * Resolve those against the workspace; leave named volumes alone.
 */
function resolveMountSource(mount, homeDir, cwd) {
  const separator = String(mount).indexOf(":");
  const source = expandHome(String(mount).slice(0, separator), homeDir);
  const rest = String(mount).slice(separator);
  const relative = source.startsWith("./") || source.startsWith("../") || source === "." || source === "..";
  return `${relative ? path.resolve(cwd, source) : source}${rest}`;
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
  if (sandbox.profileName) {
    args.push("--label", `${LABEL}-profile=${sandbox.profileName}`);
  }
  if (sandbox.concurrencyGroup) {
    args.push("--label", `${LABEL}-pool=${sandbox.concurrencyGroup}`);
  }

  if (containerName) {
    args.push("--name", containerName);
  }
  if (sandbox.network) {
    args.push("--network", String(sandbox.network));
  }

  // Resource ceilings, all optional: unset means docker imposes none, which is
  // how every run behaved before these existed. Worth setting when runs go
  // parallel — a language server indexing a large repository holds hundreds of
  // megabytes, and several containers at once add up on the host.
  for (const [key, flag] of [["memory", "--memory"], ["cpus", "--cpus"], ["pidsLimit", "--pids-limit"]]) {
    if (sandbox[key] != null && sandbox[key] !== false) {
      args.push(flag, String(sandbox[key]));
    }
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
  if (agent.isolated) {
    // Nested mounts: docker applies the longer target path after the volume, so
    // these land inside the otherwise container-local agent directory.
    //
    // models.json defines custom providers (a local gateway, ollama, llama.cpp).
    // Without it the sandbox can reach fewer models than the host, and a preset
    // naming one fails with "Unknown provider". It holds no credentials —
    // those are in auth.json, which only comes along when `auth` is on.
    const hostAgentDir = path.join(homeDir, ".pi", "agent");
    const models = path.join(hostAgentDir, "models.json");
    if (fs.existsSync(models)) {
      args.push("-v", `${models}:${AGENT_DIR}/models.json:ro`);
    }
    if (sandbox.auth) {
      const credentials = resolveCredentialsMount(hostAgentDir, sandbox.provider ?? null);
      if (credentials) {
        args.push("-v", `${credentials}:${AGENT_DIR}/auth.json:ro`);
      }
    }
  }

  for (const mount of sandbox.mounts ?? []) {
    args.push("-v", resolveMountSource(mount, homeDir, cwd));
  }
  args.push(...(sandbox.args ?? []));

  args.push(sandbox.image || DEFAULT_SANDBOX_IMAGE);
  args.push(...piArgs);
  return args;
}

/**
 * The auth.json a sandboxed run gets: only the provider it will talk to.
 *
 * The host file holds credentials for every provider, and an agent with bash
 * and network access inside the container can read all of them — the sandbox
 * protects the host from the agent, not the credentials. Handing over one entry
 * makes a compromised run cost one key instead of the whole set.
 *
 * Falls back to the whole file when the provider is unknown, which cannot
 * happen for a preset that names its model, and is better than a run failing to
 * authenticate at all.
 */
function resolveCredentialsMount(hostAgentDir, provider) {
  const source = path.join(hostAgentDir, "auth.json");
  if (!fs.existsSync(source)) {
    return null;
  }
  if (!provider) {
    return source;
  }
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(source, "utf8"))?.[provider];
  } catch {
    return source;
  }
  if (!entry) {
    return source;
  }
  try {
    const dir = path.join(os.tmpdir(), "pi-companion", "auth");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const slice = path.join(dir, `${provider.replace(/[^a-zA-Z0-9_.-]+/g, "-")}.${process.pid}.json`);
    fs.writeFileSync(slice, JSON.stringify({ [provider]: entry }), { encoding: "utf8", mode: 0o600 });
    return slice;
  } catch {
    return source;
  }
}

/**
 * Remove the credential slices this process created.
 *
 * They live under the same short-lived state tree as everything else, so a
 * missed cleanup is bounded — but a file holding a provider key should not
 * outlive the run that needed it.
 */
export function cleanupCredentialSlices() {
  const dir = path.join(os.tmpdir(), "pi-companion", "auth");
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    const file = path.join(dir, entry);
    // Ours goes immediately; anything left by a process that died before it
    // could clean up goes once it is old enough to be nobody's.
    if (entry.includes(`.${process.pid}.`)) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Already gone.
      }
      continue;
    }
    try {
      if (now - fs.statSync(file).mtimeMs > ABANDONED_SLICE_MS) {
        fs.unlinkSync(file);
      }
    } catch {
      // Someone else swept it first.
    }
  }
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
  const containerName = jobId ? containerNameForJob(jobId, sandbox?.profileName ?? null) : null;
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

  // Paths the container does have: the workspace, the agent dir, the system
  // directories the image itself provides (a globally installed extension lives
  // in /usr/local/lib/node_modules), and whatever the profile mounts explicitly
  // (the target is the middle field of -v).
  const containerPaths = [
    WORKDIR,
    AGENT_DIR,
    CONTAINER_HOME,
    "/usr",
    "/opt",
    ...(sandbox.mounts ?? []).map((mount) => mount.split(":")[1]).filter(Boolean)
  ];

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

/**
 * How many containers a slot label currently has running.
 *
 * Counted from docker rather than from the job journal: a job record can outlive
 * its container (and the other way round during startup), and the thing being
 * rationed is the container.
 */
export function countRunningForLabel(label, value) {
  if (!value) {
    return 0;
  }
  const result = runCommand("docker", [
    "ps",
    "--filter",
    `label=${LABEL}-${label}=${value}`,
    "--format",
    "{{.Names}}"
  ]);
  if (result.status !== 0) {
    return 0;
  }
  return String(result.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean).length;
}

/**
 * Which slots this sandbox draws from, and how many are taken right now.
 *
 * Returns null when nothing is capped, so callers can skip the docker call and
 * the reporting entirely.
 */
/** Where slot reservations live: one file per run whose container docker cannot see yet. */
function reservationDir() {
  return path.join(os.tmpdir(), "pi-companion", "slots");
}

/**
 * Count reservations still inside their window.
 *
 * `docker ps` only shows a container about a second after the run starts, so
 * two runs checking in that gap both see a free slot and both start. A
 * reservation covers exactly that gap; expired files are deleted rather than
 * trusted, so a process that died between claiming and starting cannot hold a
 * slot forever.
 */
function countReservations(scopeKey, { now = Date.now(), windowMs = RESERVATION_WINDOW_MS } = {}) {
  let live = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(reservationDir());
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${scopeKey}.`)) {
      continue;
    }
    const file = path.join(reservationDir(), entry);
    try {
      if (now - fs.statSync(file).mtimeMs > windowMs) {
        fs.unlinkSync(file);
        continue;
      }
      live += 1;
    } catch {
      // Removed by whoever owned it; not our slot to count.
    }
  }
  return live;
}

/** Claim a slot for the moment between "docker ps says free" and the container existing. */
function reserveSlot(scopeKey) {
  const file = path.join(reservationDir(), `${scopeKey}.${process.pid}.${Date.now()}`);
  try {
    fs.mkdirSync(reservationDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, String(process.pid), "utf8");
    return () => {
      try {
        fs.unlinkSync(file);
      } catch {
        // Already expired and swept.
      }
    };
  } catch {
    return () => {};
  }
}

export function describeSlotUsage(sandbox) {
  const limit = Number(sandbox?.maxConcurrent ?? 0);
  const group = sandbox?.concurrencyGroup ?? null;
  const value = group ?? sandbox?.profileName ?? null;
  if (!isSandboxed(sandbox) || !value || !Number.isFinite(limit) || limit <= 0) {
    return null;
  }
  const scopeKey = slotScopeKey(group ? "pool" : "profile", value);
  return {
    used: countRunningForLabel(group ? "pool" : "profile", value) + countReservations(scopeKey),
    limit,
    scope: group ? `pool \`${group}\`` : `profile \`${sandbox.profileName}\``
  };
}

/**
 * Block until the profile has a free slot, when it caps concurrency.
 *
 * The cap exists because a provider may allow only so many sessions at once:
 * without it the extra runs do not queue, they fail on the provider's side
 * halfway through. Waiting is therefore the correct behaviour, not an error —
 * the run is late rather than lost. `timeoutMs` bounds the wait so a stuck
 * container cannot hold a queue forever.
 *
 * @returns {Promise<{waitedMs: number, slots: number|null}>}
 */
export async function awaitSandboxSlot(sandbox, { timeoutMs = 900_000, onProgress = null, pollMs = 2000 } = {}) {
  const limit = Number(sandbox?.maxConcurrent ?? 0);
  // Slots belong to a pool when the profile names one, and to the profile
  // otherwise. A pool is what a shared provider needs: several profiles hitting
  // the same account have to draw from one allowance, while a profile counting
  // only itself would let them exceed it together.
  const scope = sandbox?.concurrencyGroup
    ? { label: "pool", value: String(sandbox.concurrencyGroup), what: `pool "${sandbox.concurrencyGroup}"` }
    : { label: "profile", value: sandbox?.profileName ?? null, what: `profile "${sandbox?.profileName}"` };

  if (!isSandboxed(sandbox) || !scope.value || !Number.isFinite(limit) || limit <= 0) {
    return { waitedMs: 0, slots: null, release: () => {} };
  }

  const startedAt = Date.now();
  const scopeKey = slotScopeKey(scope.label, scope.value);
  let announced = false;
  for (;;) {
    const running = countRunningForLabel(scope.label, scope.value) + countReservations(scopeKey);
    if (running < limit) {
      // Claimed before returning, so the next run counts this one even though
      // its container does not exist yet.
      return { waitedMs: Date.now() - startedAt, slots: limit - running, release: reserveSlot(scopeKey) };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Sandbox ${scope.what} allows ${limit} container(s) at once and all of them are busy ` +
          `after ${Math.round(timeoutMs / 1000)}s. Wait for a run to finish, or raise the limit.`
      );
    }
    if (!announced) {
      announced = true;
      onProgress?.({
        phase: "starting",
        message: `Waiting for a free slot: ${scope.what} is at its limit of ${limit}.`
      });
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
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
export function sandboxStatus(sandbox = null, { images = [], workspaceRoot = null } = {}) {
  const image = sandbox?.image ?? DEFAULT_SANDBOX_IMAGE;
  const report = {
    image,
    dockerfile: safeDockerfile("base", workspaceRoot),
    images: images.map((entry) => ({
      ...entry,
      dockerfilePath: safeDockerfile(entry.dockerfile, workspaceRoot),
      present: runCommand("docker", ["image", "inspect", entry.image, "--format", "{{.Created}}"]).status === 0
    })),
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

/**
 * Directories searched for a named Dockerfile, most specific first — the same
 * layering as stored prompts.
 *
 * The one shipped with the plugin is a fallback, not the source of truth: the
 * plugin is updated from git, so an image edited in place there would be lost
 * on the next pull. A file with the same name under `~/.claude/pi/sandbox/`
 * shadows it and survives updates; a project can pin its own.
 */
/** Status must survive a profile naming a Dockerfile that does not exist yet. */
function safeDockerfile(name, workspaceRoot) {
  try {
    return sandboxDockerfile(name, { workspaceRoot });
  } catch {
    return null;
  }
}

export function dockerfileSearchPath(workspaceRoot = null) {
  return [
    workspaceRoot ? path.join(workspaceRoot, ".claude", "pi", "sandbox") : null,
    path.join(os.homedir(), ".claude", "pi", "sandbox"),
    path.resolve(fileURLToPath(new URL("../../sandbox", import.meta.url)))
  ].filter(Boolean);
}

/**
 * Resolve which Dockerfile builds an image.
 *
 * `name` is either a bare name looked up along the search path (`base` →
 * `base.Dockerfile`, falling back to plain `Dockerfile` for the plugin's own)
 * or an explicit path, which is taken as given.
 */
export function sandboxDockerfile(name = "base", { workspaceRoot = null } = {}) {
  const value = String(name ?? "base").trim() || "base";

  if (/^[~./]|^[A-Za-z]:[\\/]/.test(value)) {
    const resolved = path.resolve(expandHome(value, os.homedir()));
    if (!fs.existsSync(resolved)) {
      throw new Error(`Dockerfile not found: ${resolved}`);
    }
    return resolved;
  }

  const candidates = [];
  for (const dir of dockerfileSearchPath(workspaceRoot)) {
    candidates.push(path.join(dir, `${value}.Dockerfile`), path.join(dir, value));
    if (value === "base") {
      candidates.push(path.join(dir, "Dockerfile"));
    }
  }
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!found) {
    throw new Error(
      `No Dockerfile named "${value}". Looked for ${value}.Dockerfile in: ${dockerfileSearchPath(workspaceRoot).join(", ")}.`
    );
  }
  return found;
}

/**
 * Every image the config knows about: the base one plus whatever profiles name.
 * A profile that names an `image` but no `dockerfile` is built from the base.
 */
export function listSandboxImages(config = {}) {
  // Keyed by image tag, because that is what a build produces: profiles sharing
  // a tag share one build, and an explicit `dockerfile` among them wins.
  const images = new Map([
    [DEFAULT_SANDBOX_IMAGE, { name: "base", image: DEFAULT_SANDBOX_IMAGE, dockerfile: "base", profiles: [] }]
  ]);

  for (const [name, profile] of Object.entries(config.sandboxProfiles ?? {})) {
    const image = profile?.image ?? DEFAULT_SANDBOX_IMAGE;
    const existing = images.get(image);
    if (existing) {
      existing.profiles.push(name);
      if (profile?.dockerfile) {
        existing.dockerfile = profile.dockerfile;
      }
      continue;
    }
    images.set(image, { name, image, dockerfile: profile?.dockerfile ?? name, profiles: [name] });
  }
  return [...images.values()];
}

/**
 * Build the sandbox image. Output is streamed straight through so the caller
 * sees docker's own progress instead of a silent wait.
 */
export function buildSandboxImage({
  image = DEFAULT_SANDBOX_IMAGE,
  dockerfile: dockerfileName = "base",
  workspaceRoot = null,
  piVersion = null,
  noCache = false
} = {}) {
  const dockerfile = sandboxDockerfile(dockerfileName, { workspaceRoot });
  const args = ["build", "-t", image, "-f", dockerfile];
  if (piVersion) {
    args.push("--build-arg", `PI_VERSION=${piVersion}`);
  }
  if (noCache) {
    args.push("--no-cache");
  }
  args.push(path.dirname(dockerfile));

  const result = spawnSync("docker", args, { stdio: "inherit" });
  return { status: result.status ?? 1, dockerfile, command: `docker ${args.join(" ")}` };
}

/** Description of the sandbox for reports and job records. */
export function describeSandbox(sandbox) {
  if (!isSandboxed(sandbox)) {
    return null;
  }
  const parts = [`docker \`${sandbox.image}\``];
  parts.push(sandbox.agentDir === "volume" ? `agent dir: volume \`${sandbox.volume}\`` : `agent dir: ${sandbox.agentDir}`);
  parts.push(`network: ${sandbox.network}`);
  const limits = [
    sandbox.memory != null ? `memory ${sandbox.memory}` : null,
    sandbox.cpus != null ? `cpus ${sandbox.cpus}` : null,
    sandbox.pidsLimit != null ? `pids ${sandbox.pidsLimit}` : null
  ].filter(Boolean);
  if (limits.length) {
    parts.push(`limits: ${limits.join(" · ")}`);
  }
  return parts.join(", ");
}
