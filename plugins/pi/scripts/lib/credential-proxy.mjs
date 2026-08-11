import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL, URL } from "node:url";

import { runCommand } from "./process.mjs";

/**
 * Keeps provider credentials on the host while a sandboxed run talks to models.
 *
 * The sandbox protects the host from the agent; it does nothing to protect the
 * credentials from it. An agent with bash and a network can read whatever
 * auth.json it was given and send it anywhere. So the container is given a
 * token that is worthless outside this run: a random string, valid only for
 * this process, accepted only by a listener bound to the loopback interface.
 * The real key is attached here, on the host, on the way out.
 *
 * One proxy per run, living inside the process that runs pi: it starts before
 * the container and dies with it, so a leaked token expires on its own with
 * nothing to revoke.
 *
 * Only providers whose base URL is known can be proxied — the ones described in
 * the user's models.json. For anything else the caller falls back to handing
 * over the credential itself, which is why this returns null rather than
 * throwing.
 */

/** Requests hang here rather than at the model: generous, but not unbounded. */
const UPSTREAM_TIMEOUT_MS = 600_000;

/**
 * Read the provider table the host uses.
 *
 * @returns {{ baseUrl: string, api: string } | null}
 */
export async function resolveProviderEndpoint(homeDir, provider) {
  if (!provider) {
    return null;
  }
  try {
    const file = path.join(homeDir, ".pi", "agent", "models.json");
    const entry = JSON.parse(fs.readFileSync(file, "utf8"))?.providers?.[provider];
    if (entry?.baseUrl) {
      return { baseUrl: String(entry.baseUrl), api: String(entry.api ?? ""), source: "models.json" };
    }
  } catch {
    // No user table, or an unreadable one: the built-in catalogue may still know.
  }
  return builtInEndpoint(provider);
}

/**
 * Base URL of a provider pi ships with.
 *
 * pi reaches openrouter with no local configuration at all, which means it
 * carries these addresses itself: they live in a generated catalogue beside the
 * CLI, as `MODELS[provider][model].baseUrl`. Reading it is what lets the proxy
 * cover built-in providers instead of only the ones a user described by hand.
 *
 * Located from the `pi` binary rather than a fixed path, since installs differ
 * per machine and version manager. Any failure returns null, which puts the
 * caller back on mounting a single credential rather than breaking the run.
 */
async function builtInEndpoint(provider) {
  const catalogue = await loadBuiltInCatalogue();
  const models = catalogue?.[provider];
  if (!models) {
    return null;
  }
  // One provider can list several base URLs (a versioned path beside a bare
  // one); the shortest is the prefix the others extend.
  const urls = [...new Set(Object.values(models).map((model) => model?.baseUrl).filter(Boolean))].sort(
    (left, right) => String(left).length - String(right).length
  );
  const api = Object.values(models).find((model) => model?.api)?.api ?? "";
  return urls.length ? { baseUrl: String(urls[0]), api: String(api), source: "pi catalogue" } : null;
}

/**
 * The provider table entry a container needs for this provider.
 *
 * A provider pi ships with is not in the user's models.json at all, so pointing
 * it at the proxy means describing it there: name, api and its models, with the
 * base URL replaced. Returns null for providers the user already describes —
 * their own entry is used and only its base URL changes.
 */
export async function describeBuiltInProvider(provider) {
  const catalogue = await loadBuiltInCatalogue();
  const models = catalogue?.[provider];
  if (!models) {
    return null;
  }
  return {
    name: provider,
    api: Object.values(models).find((model) => model?.api)?.api ?? "openai-completions",
    models: Object.values(models).map((model) => ({
      id: model.id,
      reasoning: Boolean(model.reasoning),
      contextWindow: model.contextWindow ?? model.context ?? undefined,
      maxTokens: model.maxTokens ?? undefined,
      input: model.input ?? undefined,
      cost: model.cost ?? undefined
    }))
  };
}

let cataloguePromise;

function loadBuiltInCatalogue() {
  cataloguePromise ??= (async () => {
    try {
      const binary = runCommand("which", ["pi"]).stdout.trim().split("\n")[0];
      if (!binary) {
        return null;
      }
      let dir = path.dirname(fs.realpathSync(binary));
      for (let depth = 0; depth < 6 && dir !== path.dirname(dir); depth += 1) {
        const candidate = path.join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", "models.generated.js");
        if (fs.existsSync(candidate)) {
          const module = await import(pathToFileURL(candidate).href);
          return module?.MODELS ?? null;
        }
        dir = path.dirname(dir);
      }
      return null;
    } catch {
      return null;
    }
  })();
  return cataloguePromise;
}

/**
 * Build the upstream URL for one request, or null if it does not belong here.
 *
 * The path is parsed against a throwaway origin and only its pathname and query
 * are copied onto a clone of the upstream, so nothing in the request can move
 * the destination: host, port and protocol come from the provider table and
 * from nowhere else. `//elsewhere/v1` would otherwise resolve as a
 * protocol-relative URL and turn this into an open relay handing out the real
 * key — for any provider whose base URL carries no path. The final comparison
 * is belt and braces: anything that still differs is refused rather than sent
 * with the credential attached.
 */
function resolveTarget(upstream, requestUrl) {
  const raw = String(requestUrl ?? "");
  if (!raw.startsWith("/") || raw.startsWith("//")) {
    return null;
  }
  let incoming;
  try {
    incoming = new URL(raw, "http://request.invalid");
  } catch {
    return null;
  }
  const prefix = upstream.pathname.replace(/\/$/, "");
  const target = new URL(upstream);
  target.pathname = `${prefix}${incoming.pathname}`;
  target.search = incoming.search;
  target.hash = "";
  if (target.host !== upstream.host || target.protocol !== upstream.protocol) {
    return null;
  }
  return target;
}

/** The credential a provider entry authenticates with, whatever its shape. */
export function credentialOf(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  // API keys and OAuth records live side by side in auth.json; the difference
  // matters to whoever refreshes them, not to the header we send.
  return entry.key ?? entry.access ?? null;
}

/**
 * Start a proxy for one run.
 *
 * @returns {Promise<{ url: string, token: string, close: () => Promise<void> } | null>}
 *   null when the provider cannot be proxied and the caller should fall back.
 */
export async function startCredentialProxy({ homeDir, provider, authEntry, onWarning = null } = {}) {
  const endpoint = await resolveProviderEndpoint(homeDir, provider);
  const credential = credentialOf(authEntry);
  if (!endpoint || !credential) {
    return null;
  }

  const token = `pi-run-${crypto.randomBytes(24).toString("hex")}`;
  const upstream = new URL(endpoint.baseUrl);
  const transport = upstream.protocol === "http:" ? http : https;

  const server = http.createServer((request, response) => {
    // The token is the only thing standing between this listener and any other
    // container on the host, so it is checked before anything else happens.
    const offered = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (offered !== token) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid run token." } }));
      request.resume();
      return;
    }

    const target = resolveTarget(upstream, request.url);
    if (!target) {
      // The path decided the destination host: `//elsewhere/v1` resolves as a
      // protocol-relative URL, and for a provider whose base URL carries no
      // path that turned this into an open relay handing out the real key.
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid request path." } }));
      request.resume();
      return;
    }
    const headers = { ...request.headers };
    // Host must match the upstream, and hop-by-hop headers are ours to set.
    delete headers.host;
    delete headers.connection;
    delete headers["content-length"];
    headers.authorization = `Bearer ${credential}`;

    const proxied = transport.request(
      target,
      { method: request.method, headers, timeout: UPSTREAM_TIMEOUT_MS },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        // Piped rather than buffered: token streams arrive as they are produced,
        // and buffering would turn a live transcript into one late blob.
        upstreamResponse.pipe(response);
      }
    );

    proxied.on("timeout", () => proxied.destroy(new Error("upstream timed out")));
    proxied.on("error", (error) => {
      onWarning?.(`Model request failed: ${error.message}`);
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: { message: `Proxy could not reach ${upstream.host}: ${error.message}` } }));
    });

    request.pipe(proxied);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback only: the container reaches it through the host gateway, and
    // nothing outside this machine can.
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address();
  return {
    url: `http://host.docker.internal:${port}`,
    token,
    // Present only for providers the user does not describe: the container's
    // table has to gain an entry for them, not just a different address.
    providerEntry: endpoint.source === "models.json" ? null : await describeBuiltInProvider(provider),
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        // Streaming responses hold sockets open; a run that is over does not
        // wait for them.
        server.closeAllConnections?.();
      });
    }
  };
}
