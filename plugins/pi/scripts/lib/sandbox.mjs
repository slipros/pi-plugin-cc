import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { concatAdditive } from "./config.mjs";
import { activeGitProxy, gitProxyConfig } from "./git-proxy.mjs";
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
  // True of every sandboxed run, not of any one toolchain, so it belongs here
  // rather than repeated in each profile: the container has no business phoning
  // home for updates or telemetry, and its only outbound need is the model.
  // Skipping those checks also takes them off the startup path of every run.
  env: ["PI_OFFLINE=1", "PI_SKIP_VERSION_CHECK=1", "PI_TELEMETRY=0"],
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

/**
 * The configured slot limit, or NaN when there is none.
 *
 * `maxConcurrent: 0` used to read as "unlimited" through `?? 0`, which is the
 * opposite of what it says. Absent means unlimited; zero is refused loudly,
 * because a profile that allows no containers can only be a mistake.
 */
function slotLimitOf(sandbox) {
  const configured = sandbox?.maxConcurrent;
  if (configured == null) {
    return Number.NaN;
  }
  const limit = Number(configured);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(
      `maxConcurrent must be a positive number of containers, got ${JSON.stringify(configured)}. ` +
        "Remove it to run without a limit."
    );
  }
  return limit;
}

/** File-name-safe key identifying one slot scope (a pool or a profile). */
function slotScopeKey(label, value) {
  // The dot separates the scope from the pid, so it must not survive inside the
  // scope itself: a pool named `a.b` otherwise matched every file of pool `a`.
  return `${label}-${value}`.replace(/[^a-zA-Z0-9_-]+/g, "-");
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

/**
 * A stable, filesystem-safe key for one workspace.
 *
 * The basename is there so a human going through volumes or session buckets can
 * tell them apart; the digest is what actually keeps two checkouts of the same
 * name separate. Only ever used inside the container or as a volume suffix.
 */
export function workspaceKey(cwd) {
  const absolute = path.resolve(String(cwd ?? "."));
  const digest = createHash("sha256").update(absolute).digest("hex").slice(0, 12);
  const name = path.basename(absolute).replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^[.-]+/, "").slice(0, 24);
  return name ? `${name}-${digest}` : digest;
}

/**
 * Where this run keeps pi's sessions inside the container.
 *
 * pi buckets sessions by the working directory, but every run sees the same
 * `/workspace` — so one bucket held the transcripts of every repository the
 * plugin had ever touched, and `--session last` could resume a session from a
 * different project. Naming the directory per workspace restores the split pi
 * intended; the directory stays inside the agent volume, so resuming a session
 * within one repository keeps working.
 */
export function sessionDirFor(cwd) {
  return `${AGENT_DIR}/sessions/${workspaceKey(cwd)}`;
}

/**
 * Where the workspace lands inside the container.
 *
 * Mounting it flat at the workdir root renames the directory, and a build
 * recipe that derives anything from the directory name stops being true: the
 * common one is a Makefile computing the service name from `$(notdir
 * $(CURDIR))`, which then builds a target that exists nowhere. The failure is
 * quiet in the worst way — the agent reaches for an equivalent command, reports
 * the gate as green, and the gate never ran. Keeping the repository's own
 * directory name makes host recipes hold inside the sandbox unchanged.
 */
export function containerWorkdir(cwd) {
  const name = path.basename(path.resolve(cwd));
  return name && name !== path.sep ? `${WORKDIR}/${name}` : WORKDIR;
}

/**
 * Whether this run must not share writable state with runs in other workspaces.
 *
 * Set for workspaces the user has not vouched for: their code runs with write
 * access to whatever the profile mounts, and a named volume outlives the
 * container. A poisoned module or build object dropped into a shared cache is
 * picked up by the next run — in a different repository.
 */
function isolatesState(sandbox) {
  return sandbox?.isolateCaches === true;
}

/**
 * Replace a shared writable cache with one that dies with the container.
 *
 * Only named volumes qualify: a bind mount is the user pointing at a host
 * directory on purpose, and a read-only mount cannot carry anything into the
 * next run. Docker reads `-v /path` with no source as "give this container its
 * own anonymous volume here", and `--rm` removes it afterwards — so the module
 * and build caches stay warm for the length of the run and vanish with it.
 *
 * @returns {string|null} the replacement `-v` value, or null to mount as written
 */
function anonymousVolumeFor(mount, homeDir) {
  const { source, target, options } = parseMount(mount);
  const expanded = expandHome(source, homeDir);
  const isPath = expanded.startsWith("/") || expanded.startsWith("./") || expanded.startsWith("../") || expanded === "." || expanded === "..";
  if (isPath || options.includes("ro")) {
    return null;
  }
  return target;
}

function resolveAgentMount(sandbox, homeDir, cwd) {
  if (sandbox.agentDir === "volume") {
    const volume = sandbox.volume || DEFAULT_SANDBOX_VOLUME;
    // Small enough to keep per workspace (sessions, the model store, LSP state),
    // and keeping it means an untrusted repository can still resume its own
    // sessions — it just cannot leave anything behind for anyone else's run.
    return { source: isolatesState(sandbox) ? `${volume}-${workspaceKey(cwd)}` : volume, isolated: true };
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
  const gitProxy = activeGitProxy(sandbox);
  if (sandbox.credentialProxy || gitProxy) {
    // Both proxies listen on the host's loopback; this is the name that reaches
    // it from inside on Linux, where it is not resolvable by default.
    args.push("--add-host", "host.docker.internal:host-gateway");
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
  // Set before the profile's own env so a profile that names the variable — or
  // a `--session-dir` in its args — still wins; this is the default, not a law.
  args.push("-e", `PI_CODING_AGENT_SESSION_DIR=${sessionDirFor(cwd)}`);
  for (const entry of sandbox.env ?? []) {
    // `NAME` forwards the host value, `NAME=value` sets one for the container.
    if (entry.includes("=") || env[entry] != null) {
      args.push("-e", entry);
    }
  }

  const workdir = containerWorkdir(cwd);
  args.push("-v", `${cwd}:${workdir}`, "-w", workdir);

  const agent = resolveAgentMount(sandbox, homeDir, cwd);
  args.push("-v", `${agent.source}:${AGENT_DIR}`);
  if (sandbox.credentialProxy) {
    // pi is started with the masked provider, so the files describing it have to
    // be there whatever the agent directory is. Tied to `isolated` before, a
    // profile with `agentDir: host` started every run with "Unknown provider".
    const credentials = writeProxyCredentials(sandbox);
    const models = writeProxyModels(hostAgentDirOf(homeDir), sandbox);
    if (credentials) {
      args.push("-v", `${credentials}:${AGENT_DIR}/auth.json:ro`);
    }
    if (models) {
      args.push("-v", `${models}:${AGENT_DIR}/models.json:ro`);
    }
  }
  if (agent.isolated) {
    // pi resolves `fd` and `rg` from its own tools directory before PATH, and
    // that directory is in a volume every run shares. Left writable, one run can
    // replace the binary and the next run executes it — over whatever repository
    // that run happens to touch. An empty read-only mount here makes the lookup
    // fall through to the copies baked into the image.
    args.push("-v", `${ensureEmptyDir(path.join(os.tmpdir(), "pi-companion", "no-tools"))}:${AGENT_DIR}/bin:ro`);
  }
  if (agent.isolated) {
    // Nested mounts: docker applies the longer target path after the volume, so
    // these land inside the otherwise container-local agent directory.
    //
    // models.json defines custom providers (a local gateway, ollama, llama.cpp).
    // Without it the sandbox can reach fewer models than the host, and a preset
    // naming one fails with "Unknown provider". It holds no credentials —
    // those are in auth.json, which only comes along when `auth` is on.
    const hostAgentDir = path.join(homeDir, ".pi", "agent");
    // With a proxy in front, the container's provider table points at it rather
    // than at the model host: the run reaches models exactly as before, it just
    // never learns the address or the key of the real endpoint.
    const models = sandbox.credentialProxy ? null : path.join(hostAgentDir, "models.json");
    if (models && fs.existsSync(models)) {
      args.push("-v", `${models}:${AGENT_DIR}/models.json:ro`);
    }
    if (sandbox.auth && !sandbox.credentialProxy) {
      const credentials = resolveCredentialsMount(hostAgentDir, sandbox.provider ?? null);
      if (credentials) {
        args.push("-v", `${credentials}:${AGENT_DIR}/auth.json:ro`);
      }
    }
  }

  const gitconfigTarget = `${CONTAINER_HOME}/.gitconfig`;
  if (gitProxy) {
    args.push("-v", `${writeRunGitconfig(gitProxy)}:${gitconfigTarget}:ro`);
  }

  for (const mount of sandbox.mounts ?? []) {
    // The host's own gitconfig rewrites forge URLs onto ssh, which the image
    // has no client for; with a proxy running, its rewrites are exactly the
    // ones that must not win. Docker would refuse the duplicate target anyway,
    // so a profile that still mounts it is dropped rather than failing the run.
    const parsed = parseMount(mount);
    if (gitProxy && parsed.target === gitconfigTarget) {
      continue;
    }
    // `:isolate` on a single mount, against `isolateCaches` on the whole run:
    // some state cannot be shared at all, and saying so per mount is what keeps
    // the rest of the caches warm. The case that forced it: a docker daemon
    // inside the sandbox holds an exclusive lock on its image store, so two
    // runs sharing one named volume corrupt it — which capped the parallel
    // fleet at one. With a store per run they coexist, and the module and build
    // caches stay shared. Refused rather than ignored where it cannot work: a
    // silently shared store is the corruption this option exists to prevent.
    if (parsed.options.includes("isolate")) {
      const perRun = anonymousVolumeFor(mount, homeDir);
      if (!perRun) {
        throw new Error(
          `Mount "${mount}": ":isolate" needs a writable named volume. A host path is the caller pointing somewhere on purpose, and a read-only mount carries nothing between runs.`
        );
      }
      args.push("-v", perRun);
      continue;
    }
    if (isolatesState(sandbox)) {
      const anonymous = anonymousVolumeFor(mount, homeDir);
      if (anonymous) {
        args.push("-v", anonymous);
        continue;
      }
    }
    args.push("-v", resolveMountSource(mount, homeDir, cwd));
  }
  const profileArgs = (sandbox.args ?? []).map((arg) => resolveSandboxFileRefs(String(arg), cwd));
  assertProfileArgsShape(profileArgs);
  args.push(...profileArgs);

  args.push(sandbox.image || DEFAULT_SANDBOX_IMAGE);
  args.push(...piArgs);
  return args;
}

/**
 * Refuse a profile `args` list that has lost the flag in front of a value.
 *
 * Everything up to the image is flags and their values; the image is the first
 * bare word docker meets. A value left without its flag therefore takes the
 * image's place, and docker answers `invalid reference format` — naming neither
 * the argument nor the run. The failure even looks like it belongs to the
 * workspace, since the working directory decides which mounts are added around
 * it, so it appears to come and go with the directory name.
 *
 * The shape is checked instead of the cause, because the causes differ: a
 * repeated docker flag that merging deduplicated away, a hand-edited config, a
 * value pasted without its flag.
 */
function assertProfileArgsShape(args) {
  for (const [index, value] of args.entries()) {
    if (value.startsWith("-")) {
      continue;
    }
    const previous = index > 0 ? args[index - 1] : null;
    // `--flag value` is the only shape a bare word may appear in; `--flag=value`
    // already carries its own, so a word after it belongs to nothing.
    if (previous?.startsWith("-") && !previous.includes("=")) {
      continue;
    }
    throw new Error(
      `Sandbox profile argument "${value}" has no flag in front of it. Docker reads the first bare word as ` +
        "the image name and fails with `invalid reference format`. Check the profile's `args`: a repeated " +
        "docker flag, or a value pasted without its flag."
    );
  }
}

/**
 * Expand `@sandbox/<file>` inside a raw docker argument to an absolute path.
 *
 * A profile that needs to point docker at a file it ships — a seccomp profile,
 * an apparmor one — would otherwise carry that file's absolute path in the
 * config, which breaks the moment the config moves to another machine or user.
 * `@sandbox/x.json` is resolved along the same search path Dockerfiles use, so a
 * project copy shadows the plugin's and a home copy survives updates.
 */
function resolveSandboxFileRefs(arg, cwd) {
  return arg.replace(/@sandbox\/([\w.\-/]+)/g, (whole, name) => {
    for (const dir of dockerfileSearchPath(cwd)) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    // Left as written when nothing matches: docker will fail with the literal,
    // which is a clearer error than a silently half-substituted path.
    return whole;
  });
}

/** Where the host keeps pi's own agent directory. */
function hostAgentDirOf(homeDir) {
  return path.join(homeDir, ".pi", "agent");
}

/** An empty directory that exists, for mounting over something that must not be written. */
function ensureEmptyDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  return dir;
}

/** Per-run configuration handed to the container, kept out of the host's own. */
function runConfigDir() {
  return path.join(os.tmpdir(), "pi-companion", "auth");
}

function writeRunConfig(name, contents) {
  return writeRunFile(`${name}.${process.pid}.json`, JSON.stringify(contents));
}

/** Same directory and same permissions, for the files that are not JSON. */
function writeRunFile(name, contents) {
  const dir = runConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents, { encoding: "utf8", mode: 0o600 });
  return file;
}

/**
 * The container's gitconfig: forge URLs rewritten onto this run's git proxy.
 *
 * Written per run because it carries the run token, and readable only by the
 * caller for the same reason — the file exists on the host, where the token is
 * still worth something until the run ends.
 */
function writeRunGitconfig(gitProxy) {
  // `.${pid}.conf`, not `.${pid}`: the sweep in `cleanupCredentialSlices` matches
  // `.<pid>.`, so a name ending on the pid was invisible to it and a file holding
  // the run token lingered until some later run aged it out.
  return writeRunFile(`gitconfig-run.${process.pid}.conf`, `${gitProxyConfig(gitProxy)}${hostCheckoutSettings()}`);
}

/**
 * Checkout settings carried over from the host's global gitconfig.
 *
 * Only the ones that decide what lands in the working tree: with the host file
 * no longer mounted, an agent on a repository normalized under
 * `autocrlf = input` would otherwise commit line endings the human never sees.
 * Identity is deliberately absent: it arrives as the GIT_AUTHOR and
 * GIT_COMMITTER variables, resolved on the host, where an `includeIf
 * "gitdir:…"` rule still matches a real path — inside the container the
 * repository lives under /workspace and no such rule could ever fire.
 */
function hostCheckoutSettings() {
  const lines = [];
  for (const key of ["core.autocrlf", "core.eol", "core.ignorecase"]) {
    const result = spawnSync("git", ["config", "--global", "--get", key], { encoding: "utf8" });
    const value = result.status === 0 ? result.stdout.trim() : "";
    if (value) {
      lines.push(`\t${key.slice("core.".length)} = ${value}`);
    }
  }
  return lines.length ? `[core]\n${lines.join("\n")}\n` : "";
}

/** auth.json holding the run token instead of the provider's own credential. */
function writeProxyCredentials(sandbox) {
  // Under the masked name, so the container's two files agree with each other
  // and with the arguments pi was started with. The shape is what pi expects
  // for a key-based provider; the value is the run token, which means nothing
  // outside this run's proxy.
  const provider = String(sandbox.credentialProxy.providerEntry?.name ?? sandbox.provider);
  return writeRunConfig("auth-run", {
    [provider]: { type: "api_key", key: sandbox.credentialProxy.token }
  });
}

/**
 * The provider table the container gets: one generic provider, pointed at the
 * run's proxy.
 *
 * The host's own table is not copied in. The container has no use for providers
 * this run will not touch, and their names and endpoints are information the
 * agent has no reason to hold.
 */
function writeProxyModels(hostAgentDir, sandbox) {
  const entry = sandbox.credentialProxy.providerEntry;
  if (!entry) {
    return null;
  }
  return writeRunConfig("models-run", {
    providers: { [entry.name]: { ...entry, baseUrl: sandbox.credentialProxy.url } }
  });
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
/**
 * Isolation a profile gave away through raw docker arguments.
 *
 * `args` is an escape hatch, so the flags that matter most for the boundary
 * arrive as opaque strings — a profile can hand the container the host's docker
 * socket or drop seccomp entirely and nothing would say so. Read here and named
 * in the run header, because the difference between profiles is otherwise
 * invisible at the moment it matters.
 */
function relaxedIsolationWarnings(sandbox) {
  const args = (sandbox.args ?? []).map(String);
  const line = args.join(" ");
  const warnings = [];

  // `--privileged` and `--privileged=true` are the same flag to docker; the bare
  // form is the common one, the `=true` form the one a naive check misses.
  if (args.some((value) => value === "--privileged" || /^--privileged=true$/i.test(value))) {
    warnings.push("Sandbox runs `--privileged`: the container reaches the host's devices, which is not a boundary.");
  }
  if (/seccomp=unconfined/.test(line)) {
    warnings.push("Sandbox disables seccomp entirely; every syscall the kernel has is reachable from the agent.");
  } else if (/--security-opt\s*$|seccomp=/.test(line)) {
    warnings.push("Sandbox replaces the default seccomp profile; it allows syscalls docker would refuse.");
  }
  if (/apparmor=unconfined/.test(line)) {
    warnings.push("Sandbox disables AppArmor confinement.");
  }
  if (/systempaths=unconfined/.test(line)) {
    warnings.push("Sandbox unmasks /proc: /proc/kcore and /proc/sysrq-trigger are reachable from the container.");
  }
  // Both `--device /dev/x` and `--device=/dev/x` are accepted by docker.
  for (const [index, value] of args.entries()) {
    const device = value === "--device" ? args[index + 1] : /^--device=(.+)$/.exec(value)?.[1];
    if (device) {
      warnings.push(`Sandbox passes the host device ${device} into the container.`);
    }
  }
  // The socket can arrive as a mount or, just as easily, through raw `args`;
  // reading only `mounts` was the gap the warning's own docstring described.
  const socketInArgs = args.some((value) => value.includes("docker.sock"));
  const socketInMounts = (sandbox.mounts ?? []).some((mount) => String(mount).includes("docker.sock"));
  if (socketInArgs || socketInMounts) {
    warnings.push("Sandbox exposes the host docker socket: containers it starts run on the host, as root.");
  }
  return warnings;
}

/**
 * Equipment the preset declares that the container will not have.
 *
 * Split out of the warning list because the two answers are used differently: a
 * warning about relaxed isolation is worth printing, while a skill that does not
 * exist inside the sandbox means the agent runs WITHOUT the rules that skill
 * carries — silently, and for as long as nobody re-reads the launch output. It
 * happened for months: every preset named `/pi-skills/git-commit` and friends
 * while the profile mounted a single directory, so the agents ran with none of
 * them. Callers turn this list into a refusal, not a note.
 */
export function sandboxMountGaps(sandbox, { workspaceRoot, extensions = [], skills = [] } = {}) {
  if (!isSandboxed(sandbox)) {
    return [];
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

  // The mount that would carry a container path, if any. Named mounts (docker
  // volumes) have no host side to check — only a path does.
  const coveringMount = (value) =>
    (sandbox.mounts ?? [])
      .map((mount) => {
        const [host, target] = String(mount).split(":");
        return { host, target };
      })
      .filter(({ host, target }) => host && target && /^[~./]/.test(host))
      .find(({ target }) => value === target || value.startsWith(`${target}/`)) ?? null;

  const root = path.resolve(workspaceRoot ?? ".");
  const gaps = [];
  for (const [label, entries] of [["extension", extensions], ["skill", skills]]) {
    for (const entry of entries) {
      const value = String(entry ?? "");
      if (!/^[~./]|^[A-Za-z]:[\\/]/.test(value)) {
        continue; // npm: / git: sources are resolved inside the container.
      }
      if (containerPaths.some((target) => value === target || value.startsWith(`${target}/`))) {
        // Inside the container — but a mount whose HOST side does not exist is
        // docker creating an empty directory, and the equipment is just as
        // absent as with no mount at all. Same failure, quieter cause.
        const mount = coveringMount(value);
        if (mount) {
          const hostPath = path.resolve(root, mount.host.replace(/^~(?=\/|$)/, os.homedir()));
          const suffix = value.slice(mount.target.length);
          if (!fs.existsSync(path.join(hostPath, suffix))) {
            gaps.push({ label, value, reason: "missing-host-path", hostPath: path.join(hostPath, suffix) });
          }
        }
        continue;
      }
      const resolved = path.resolve(root, value.replace(/^~(?=\/|$)/, os.homedir()));
      if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
        gaps.push({ label, value, reason: "unmounted" });
      }
    }
  }
  return gaps;
}

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
  warnings.push(...relaxedIsolationWarnings(sandbox));

  for (const gap of sandboxMountGaps(sandbox, { workspaceRoot, extensions, skills })) {
    warnings.push(
      gap.reason === "missing-host-path"
        ? `The ${gap.label} \`${gap.value}\` is mounted from \`${gap.hostPath}\`, which does not exist — the container would see an empty directory.`
        : `The ${gap.label} \`${gap.value}\` is a host path outside the workspace; it does not exist inside the sandbox.`
    );
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
function countReservations(scopeKey, { now = Date.now(), windowMs = RESERVATION_WINDOW_MS, sweep = true } = {}) {
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
        // Expired: not counted, and swept only when this call is the one
        // claiming a slot. A read that merely reports occupancy has no business
        // deleting another run's files.
        if (sweep) {
          fs.unlinkSync(file);
        }
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
  const limit = slotLimitOf(sandbox);
  const group = sandbox?.concurrencyGroup ?? null;
  const value = group ?? sandbox?.profileName ?? null;
  if (!isSandboxed(sandbox) || !value || !Number.isFinite(limit) || limit <= 0) {
    return null;
  }
  const scopeKey = slotScopeKey(group ? "pool" : "profile", value);
  return {
    used: countRunningForLabel(group ? "pool" : "profile", value) + countReservations(scopeKey, { sweep: false }),
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
  const limit = slotLimitOf(sandbox);
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
  // The runtime user the container runs as is the caller's own uid (see
  // `--user` in buildDockerRunArgs). An image that bakes in files owned by, or a
  // subuid range for, a fixed uid only works when the builder's uid matches. Any
  // image ignoring the arg is unaffected; the dind one uses it so a build on a
  // non-1000 machine still produces a working rootless daemon.
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  if (uid != null) {
    args.push("--build-arg", `RUNTIME_UID=${uid}`);
  }
  if (gid != null) {
    args.push("--build-arg", `RUNTIME_GID=${gid}`);
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
  if (isolatesState(sandbox)) {
    // Worth saying out loud: it explains both the cold build cache and why the
    // run cannot see the sessions of everything else on this machine.
    parts.push("caches: isolated (workspace not trusted)");
  }
  return parts.join(", ");
}
