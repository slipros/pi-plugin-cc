/**
 * Git smart-HTTP proxy for one run.
 *
 * The container never holds a forge credential. It is handed a run token and a
 * loopback URL; the real token is attached here, on the host, and dies with the
 * process. That is the whole point: an agent with bash inside the sandbox can
 * read every file and every variable it is given, so the only credential that
 * can be called safe there is one that is worthless outside this run.
 *
 * The second thing the proxy buys is a write boundary that does not depend on
 * how narrow a token a forge lets you mint. Only the two fetch routes of the
 * smart-HTTP protocol are forwarded; `git-receive-pack` is refused before the
 * credential is attached, so push fails identically on a corporate GitLab that
 * only issues full-access tokens and on a self-hosted Forgejo that does not.
 */

import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import { PROXY_BIND_ADDRESS } from "./proxy-bind.mjs";

/**
 * Idle timeout, not a total one: a clone of a large repository legitimately
 * streams for minutes, and killing it by elapsed time would fail the honest
 * case while a stalled upstream is caught either way.
 */
const UPSTREAM_IDLE_TIMEOUT_MS = 300_000;

/** How long a token-producing command may take before the host is dropped. */
const SECRET_COMMAND_TIMEOUT_MS = 15_000;

const UPLOAD_PACK = "git-upload-pack";
const RECEIVE_PACK = "git-receive-pack";

/** Redirect hops the proxy will follow before giving up on a request. */
const MAX_UPSTREAM_HOPS = 3;

/**
 * Headers that belong to the hop, not the message, plus the ones this proxy
 * owns. `authorization` especially: whatever the container sent authenticated
 * it to the proxy and must never reach the forge.
 */
const STRIPPED_REQUEST_HEADERS = [
  "host",
  "authorization",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cookie"
];

/**
 * Response headers this proxy owns.
 *
 * The first three would teach the container about the host's session. The rest
 * describe *this* hop and must not be copied from the upstream one: leaving
 * `transfer-encoding: chunked` in place while node applies its own framing
 * chunk-encodes the body twice, and git meets the result as
 * "fatal: expected flush after ref listing" — a fetch that fails only for
 * repositories whose advertisement the forge happens to stream.
 */
const STRIPPED_RESPONSE_HEADERS = [
  "set-cookie",
  "www-authenticate",
  "authorization",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "trailer",
  "upgrade"
];

/**
 * Read one host's real credential.
 *
 * Three shapes because the answer to "where does a secret live" is a local
 * decision: a literal for a scratch setup, an environment variable for CI, a
 * command for a secret manager. The value is held in this process only.
 */
function resolveSecret(spec, hostKey) {
  if (spec.token) {
    return String(spec.token);
  }
  if (spec.tokenEnv) {
    const value = process.env[spec.tokenEnv];
    return value ? String(value) : null;
  }
  if (spec.tokenCommand) {
    // stderr is dropped rather than reported: a failing secret manager tends to
    // echo back what it was asked for, and that is the one string that must not
    // reach a warning, a journal or a transcript.
    const output = execFileSync("/bin/sh", ["-c", String(spec.tokenCommand)], {
      encoding: "utf8",
      timeout: SECRET_COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return normalizeSecret(output);
  }
  throw new Error(`gitProxy host "${hostKey}" has no token, tokenEnv or tokenCommand.`);
}

/**
 * The token out of whatever shape a secret manager printed.
 *
 * Most of them export rather than echo: `phase secrets export KEY --format kv`
 * answers `KEY=value`, dotenv quotes it. Unwrapping here keeps the config a
 * plain command instead of a pipeline of `cut` and `tr` that nobody can read.
 * The prefix is only stripped when it is shaped like a variable name, so a token
 * that itself contains `=` (base64 padding, `glpat-…=`) is left alone.
 */
function normalizeSecret(output) {
  let value = String(output ?? "").trim();
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(value);
  if (assignment) {
    value = assignment[2].trim();
  }
  const quoted = /^(["'])(.*)\1$/s.exec(value);
  if (quoted) {
    value = quoted[2];
  }
  return value || null;
}

/** `Authorization` value for the forge, from whichever scheme the host uses. */
function upstreamAuthorization(spec, secret) {
  if (String(spec.scheme ?? "basic").toLowerCase() === "bearer") {
    return `Bearer ${secret}`;
  }
  // GitLab accepts any username beside a token; Forgejo wants the account name.
  // Defaulting to `oauth2` matches GitLab's documented form and is harmless
  // where the username is ignored.
  const user = String(spec.user ?? "oauth2");
  return `Basic ${Buffer.from(`${user}:${secret}`, "utf8").toString("base64")}`;
}

/** Constant-time compare so the run token cannot be guessed byte by byte. */
function sameToken(offered, expected) {
  const a = Buffer.from(String(offered ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The run token out of `Basic user:token` or `Bearer token`. */
function offeredToken(header) {
  const value = String(header ?? "");
  const basic = /^Basic\s+(.+)$/i.exec(value);
  if (basic) {
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator === -1 ? decoded : decoded.slice(separator + 1);
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(value);
  return bearer ? bearer[1] : null;
}

/**
 * Which forge a request is for and what it wants to do there.
 *
 * The first path segment names the host, and it is matched against the
 * configured table rather than parsed as a destination — a proxy that takes its
 * upstream from the request is an open relay handing out a real credential.
 */
function resolveRoute(rawUrl, method, hosts) {
  let parsed;
  try {
    parsed = new URL(rawUrl, "http://proxy.invalid");
  } catch {
    return { error: "Invalid request path." };
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    return { error: "Path must start with a configured forge host." };
  }
  // `..` never survives to the upstream URL: repository paths do not contain it
  // and it is the classic way out of a prefix.
  if (segments.some((segment) => segment === "..")) {
    return { error: "Invalid request path." };
  }
  const hostKey = decodeURIComponent(segments[0]);
  const host = hosts.get(hostKey);
  if (!host) {
    return { error: `Host "${hostKey}" is not configured for this run.` };
  }

  const repoPath = `/${segments.slice(1).join("/")}`;
  const service = parsed.searchParams.get("service");
  const isRefsAdvertisement = method === "GET" && repoPath.endsWith("/info/refs");
  const isUploadPack = method === "POST" && repoPath.endsWith(`/${UPLOAD_PACK}`);
  const isReceivePack =
    (method === "POST" && repoPath.endsWith(`/${RECEIVE_PACK}`)) ||
    (isRefsAdvertisement && service === RECEIVE_PACK);

  if (isReceivePack && !host.allowPush) {
    return { blocked: "Push is disabled for this sandbox: the git proxy forwards fetch only." };
  }
  if (isRefsAdvertisement) {
    if (service !== UPLOAD_PACK && service !== RECEIVE_PACK) {
      // Dumb-HTTP walks the object store one file at a time and never announces
      // a service. Refusing it keeps the surface to the two routes reviewed
      // here rather than to arbitrary paths under the repository.
      return { blocked: "Only smart-HTTP git is proxied; dumb-HTTP fetch is refused." };
    }
  } else if (!isUploadPack && !(isReceivePack && host.allowPush)) {
    return { blocked: `Refused: only ${UPLOAD_PACK} is proxied.` };
  }

  const target = new URL(host.upstream);
  target.pathname = `${target.pathname.replace(/\/$/, "")}${repoPath}`;
  target.search = parsed.search;
  return { host, target, repoPath, search: parsed.search, write: isReceivePack };
}

/**
 * The route a redirect points at, or null when it leaves the configured forges.
 *
 * The location is resolved against the request it answers, mapped back onto this
 * proxy's own path shape, and run through the same gate as any other request —
 * so a redirect can no more reach `git-receive-pack`, or a forge nobody
 * configured, than a direct call could.
 */
function redirectRoute(location, current, hosts) {
  if (!location) {
    return null;
  }
  let target;
  try {
    target = new URL(location, current.target);
  } catch {
    return null;
  }
  const host = [...hosts.values()].find((entry) => new URL(entry.upstream).host === target.host);
  if (!host) {
    return null;
  }
  const prefix = new URL(host.upstream).pathname.replace(/\/$/, "");
  const repoPath = target.pathname.startsWith(prefix) ? target.pathname.slice(prefix.length) : target.pathname;
  const route = resolveRoute(`/${encodeURIComponent(host.key)}${repoPath}${target.search}`, "GET", hosts);
  return route.error || route.blocked ? null : route;
}

/**
 * Repository prefix of a smart-HTTP path: everything before the endpoint.
 *
 * Both endpoints of the protocol hang off the same prefix, which is what makes
 * one recorded rewrite enough for the whole exchange.
 */
function repoPrefixOf(repoPath) {
  for (const suffix of ["/info/refs", `/${UPLOAD_PACK}`, `/${RECEIVE_PACK}`]) {
    if (repoPath.endsWith(suffix)) {
      return repoPath.slice(0, -suffix.length);
    }
  }
  return null;
}

/** Record that a forge canonicalised one repository path into another. */
function rememberCanonical(from, to, canonical) {
  const before = repoPrefixOf(from.repoPath);
  const after = repoPrefixOf(to.repoPath);
  if (before && after && before !== after) {
    canonical.set(`${from.host.key}${before}`, after);
  }
}

/** Apply a rewrite the forge already asked for on an earlier request. */
function canonicalize(route, method, hosts, canonical) {
  if (route.error || route.blocked || !route.repoPath) {
    return route;
  }
  const prefix = repoPrefixOf(route.repoPath);
  const replacement = prefix ? canonical.get(`${route.host.key}${prefix}`) : null;
  if (!replacement) {
    return route;
  }
  const rewritten = resolveRoute(
    `/${encodeURIComponent(route.host.key)}${route.repoPath.replace(prefix, replacement)}${route.search ?? ""}`,
    method,
    hosts
  );
  return rewritten.error || rewritten.blocked ? route : rewritten;
}

function plainText(response, status, message) {
  if (!response.headersSent) {
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  }
  response.end(`${message}\n`);
}

/**
 * Which forges this run may fetch from.
 *
 * The table lives in the user config, and a profile narrows it: `false` for a
 * run that has no business on the network, a list for one that should reach a
 * single forge. Declaring a host is already a decision, so the default is every
 * host declared — the boundary the proxy exists to draw is fetch-versus-push,
 * not which of one's own forges is visible.
 */
export function resolveGitProxyHosts(config, sandbox) {
  const table = config?.gitProxy ?? {};
  const selection = sandbox?.gitProxy;
  if (selection === false || !Object.keys(table).length) {
    return null;
  }
  if (Array.isArray(selection)) {
    const chosen = {};
    for (const name of selection) {
      if (table[name]) {
        chosen[name] = table[name];
      }
    }
    return Object.keys(chosen).length ? chosen : null;
  }
  return table;
}

/** A descriptor that is a started proxy, not a profile's request for one. */
export function activeGitProxy(sandbox) {
  return sandbox?.gitProxy?.token ? sandbox.gitProxy : null;
}

/**
 * Bring up the git proxy for a run that was given forges to reach.
 *
 * Lives here rather than beside either engine because there are two of them —
 * json and rpc — and a boundary that exists in one but not the other is worse
 * than no boundary at all: the run that skips it looks identical from outside.
 *
 * Never fatal: a proxy that cannot start means a run without git networking,
 * which is how every sandboxed run behaved before this existed.
 */
export async function openGitProxy(sandbox, onProgress) {
  // `gitProxyHosts` is only ever set for a sandboxed run, so its presence is the
  // check — importing `isSandboxed` from sandbox.mjs would close an import loop,
  // since that module needs the config writer below.
  if (!sandbox?.gitProxyHosts) {
    return null;
  }
  try {
    const proxy = await startGitProxy({
      hosts: sandbox.gitProxyHosts,
      onWarning: (message) => onProgress?.({ phase: "working", message })
    });
    if (proxy) {
      onProgress?.({
        phase: "starting",
        message: `Git stays on the host: fetch from ${proxy.hosts.map((entry) => entry.host).join(", ")} goes through a run-scoped proxy, push is refused.`
      });
    } else {
      // Silence here would look like a working setup until the agent's first
      // fetch fails against a rewrite pointing at a proxy that is not listening.
      onProgress?.({ phase: "starting", message: "Git proxy has no usable host; the run gets no git networking." });
    }
    return proxy;
  } catch (error) {
    onProgress?.({
      phase: "starting",
      message: `Git proxy could not start (${error instanceof Error ? error.message : String(error)}); the run gets no git networking.`
    });
    return null;
  }
}

/** The sandbox descriptor a started proxy produces, or one with no stale request. */
export function withGitProxy(sandbox, proxy) {
  if (proxy) {
    return { ...sandbox, gitProxy: { url: proxy.url, token: proxy.token, hosts: proxy.hosts } };
  }
  // A profile's request for a proxy is not a proxy: left in place it would reach
  // the sandbox descriptor as if one were running.
  return sandbox?.gitProxy ? { ...sandbox, gitProxy: null } : sandbox;
}

/**
 * Start the git proxy for one run.
 *
 * @returns {Promise<{ url: string, token: string, hosts: string[], stats: () => object, close: () => Promise<void> } | null>}
 *   null when no host could be prepared, so the caller can run without git
 *   networking rather than not run at all.
 */
export async function startGitProxy({ hosts: hostSpecs = {}, onWarning = null } = {}) {
  const hosts = new Map();
  for (const [hostKey, rawSpec] of Object.entries(hostSpecs ?? {})) {
    const spec = rawSpec === true ? {} : rawSpec;
    if (!spec || typeof spec !== "object" || spec.enabled === false) {
      continue;
    }
    let secret = null;
    try {
      secret = resolveSecret(spec, hostKey);
    } catch (error) {
      onWarning?.(`Git proxy: ${hostKey} unavailable (${error instanceof Error ? error.message : String(error)}).`);
      continue;
    }
    if (!secret) {
      onWarning?.(`Git proxy: ${hostKey} unavailable (its token resolved empty).`);
      continue;
    }
    hosts.set(hostKey, {
      key: hostKey,
      upstream: String(spec.upstream ?? `https://${hostKey}`),
      authorization: upstreamAuthorization(spec, secret),
      // Opt-in per host, so a forge the agent may push to is a visible decision
      // in the config rather than the default everything inherits.
      allowPush: spec.allowPush === true,
      // Only for rewriting remotes: a forge on a non-default ssh port produces
      // URLs that no rewrite of the plain form will match.
      sshPorts: Array.isArray(spec.sshPorts) ? spec.sshPorts.map((port) => String(port)) : []
    });
  }
  if (!hosts.size) {
    return null;
  }

  const token = `pi-git-${crypto.randomBytes(24).toString("hex")}`;
  /**
   * Repository paths the forge redirected to their canonical form.
   *
   * Smart-HTTP is two requests, and git derives the second from the URL it was
   * given, not from where the first one landed: GitLab answers `…/repo/info/refs`
   * with a 301 to `…/repo.git/…`, then meets the POST at the un-canonical path
   * with a 422. Following the redirect inside the proxy fixes the first request
   * and breaks the second unless the rewrite is remembered for the rest of the
   * run — which is all this map is.
   */
  const canonical = new Map();
  // `challenged` counts the 401 git always earns on its first request, so it is
  // kept apart from `rejected`: mixing them would make normal traffic look like
  // something was trying tokens.
  const counters = { requests: 0, blocked: 0, challenged: 0, rejected: 0, upstream_errors: 0 };

  const server = http.createServer((request, response) => {
    const offered = offeredToken(request.headers.authorization);
    if (offered == null) {
      // git sends credentials only after being asked. Without this challenge
      // the first request would fail as unauthorized and the run would look
      // like a broken token instead of a working proxy.
      counters.challenged += 1;
      response.writeHead(401, {
        "www-authenticate": 'Basic realm="pi git proxy"',
        "content-type": "text/plain; charset=utf-8"
      });
      response.end("Run token required.\n");
      request.resume();
      return;
    }
    if (!sameToken(offered, token)) {
      counters.rejected += 1;
      plainText(response, 403, "Invalid run token.");
      request.resume();
      return;
    }

    const route = canonicalize(resolveRoute(request.url, request.method, hosts), request.method, hosts, canonical);
    if (route.error || route.blocked) {
      counters.blocked += 1;
      plainText(response, route.error ? 400 : 403, route.error ?? route.blocked);
      request.resume();
      return;
    }

    counters.requests += 1;

    // One attempt against one upstream. Wrapped in a function because a GET may
    // have to be repeated against the location a redirect names, and the retry
    // has to reuse everything below — headers, timeouts, error handling.
    const forward = (current, hops) => {
      const headers = { ...request.headers };
      for (const header of STRIPPED_REQUEST_HEADERS) {
        delete headers[header];
      }
      headers.authorization = current.host.authorization;

      const transport = current.target.protocol === "http:" ? http : https;
      const proxied = transport.request(
        current.target,
        { method: request.method, headers, timeout: UPSTREAM_IDLE_TIMEOUT_MS },
        (upstreamResponse) => {
          const status = upstreamResponse.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            // Followed here rather than handed to the client. GitLab answers the
            // `.git`-less URL that `go` probes with a 301 to the canonical one,
            // and a client following it re-authenticates against what it sees as
            // a new location: git then meets a challenge mid-negotiation and the
            // fetch dies as "expected flush after ref listing". A hop taken here
            // is invisible to git, and the gate runs again on the new path — a
            // redirect cannot reach a forge, or a route, that was refused.
            const next =
              request.method === "GET" && hops < MAX_UPSTREAM_HOPS
                ? redirectRoute(upstreamResponse.headers.location, current, hosts)
                : null;
            upstreamResponse.resume();
            if (!next) {
              counters.upstream_errors += 1;
              plainText(response, 502, "Upstream redirected outside the configured forges.");
              return;
            }
            rememberCanonical(current, next, canonical);
            forward(next, hops + 1);
            return;
          }
          const outgoing = { ...upstreamResponse.headers };
          for (const header of STRIPPED_RESPONSE_HEADERS) {
            delete outgoing[header];
          }
          response.writeHead(status, outgoing);
          // Streamed, never buffered: a fetch response is a packfile, and holding
          // one whole would put the repository in the host process's memory.
          upstreamResponse.pipe(response);
          upstreamResponse.on("error", () => {
            counters.upstream_errors += 1;
            response.destroy();
          });
        }
      );

      proxied.on("timeout", () => {
        counters.upstream_errors += 1;
        proxied.destroy(new Error("upstream timed out"));
      });
      proxied.on("error", (error) => {
        counters.upstream_errors += 1;
        onWarning?.(`Git proxy could not reach ${current.host.key}: ${error.message}`);
        plainText(response, 502, `Proxy could not reach ${current.host.key}: ${error.message}`);
      });
      request.on("error", () => proxied.destroy());
      // Only the first attempt still has a body to send; a redirect is followed
      // with a GET whose body was already consumed.
      if (hops === 0) {
        request.pipe(proxied);
      } else {
        proxied.end();
      }
    };

    forward(route, 0);

  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, PROXY_BIND_ADDRESS, resolve);
    // A listening socket keeps the event loop alive, and an early throw between
    // start and close would leave the run token answering forever.
    server.unref();
  });

  const { port } = server.address();
  return {
    url: `http://host.docker.internal:${port}`,
    token,
    hosts: [...hosts.values()].map((host) => ({ host: host.key, sshPorts: host.sshPorts })),
    stats() {
      return { ...counters };
    },
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        // A fetch still streaming holds its socket; a run that is over does not
        // wait for it.
        server.closeAllConnections?.();
      });
    }
  };
}

/**
 * The gitconfig the container gets: every form a remote can be written in,
 * rewritten onto this run's proxy.
 *
 * All three `insteadOf` forms are needed because the same forge is reached by
 * ssh in a cloned remote, by https in a `go.mod` dependency, and by scp-style
 * shorthand in a hand-written remote. A rewrite that misses one leaves the
 * container trying a protocol the image does not even have.
 */
export function gitProxyConfig(proxy) {
  const base = String(proxy.url).replace(/\/$/, "");
  const authority = base.replace(/^https?:\/\//, "");
  const lines = [
    // The token is handed over by a helper rather than written into the remote
    // URL. In the URL it would be echoed by `git remote -v`, by every clone line
    // and by most of git's error messages — straight into the run transcript,
    // which is archived. Here it lives in one root-readable file the agent could
    // read but has no reason to print.
    `[credential "${base}"]`,
    `\tusername = git`,
    `\thelper = "!f() { test \\"$1\\" = get && echo password=${proxy.token}; }; f"`,
    ""
  ];
  for (const { host, sshPorts = [] } of proxy.hosts) {
    const through = `${base}/${host}/`;
    lines.push(
      `[url "${through}"]`,
      `\tinsteadOf = https://${host}/`,
      `\tinsteadOf = http://${host}/`,
      `\tinsteadOf = git@${host}:`,
      `\tinsteadOf = ssh://git@${host}/`,
      ...sshPorts.map((port) => `\tinsteadOf = ssh://git@${host}:${port}/`)
    );
  }
  return `${lines.join("\n")}\n`;
}
