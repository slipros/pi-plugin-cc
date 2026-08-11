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

/** Ceiling on a buffered request body; prompts are large, but not this large. */
const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

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

/** Thinking levels pi accepts as a `model:level` suffix. */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * The model id a provider expects, taken from what the caller asked for.
 *
 * Only the provider prefix comes off, and only the first one: model ids at
 * openrouter, huggingface and the gateways contain slashes of their own
 * (`openrouter/deepseek/deepseek-v4-flash-0731` names the model
 * `deepseek/deepseek-v4-flash-0731`), so cutting at the last slash produced an
 * id no provider has ever heard of. A trailing thinking level is pi's own
 * syntax and travels as a flag, not as part of the name.
 */
export function modelIdFor(provider, model) {
  if (!model) {
    return null;
  }
  let id = String(model);
  const prefix = provider ? `${provider}/` : null;
  if (prefix && id.startsWith(prefix)) {
    id = id.slice(prefix.length);
  }
  const suffix = id.match(/:([a-z]+)$/i);
  if (suffix && THINKING_LEVELS.has(suffix[1].toLowerCase())) {
    id = id.slice(0, -suffix[0].length);
  }
  return id;
}

/** Name the container sees instead of the provider's own. */
export const MASKED_PROVIDER = "sandbox";
/** Name the container sees instead of the model's own. */
export const MASKED_MODEL = "agent-model";

/**
 * The provider table entry handed to the container.
 *
 * Everything that changes behaviour is preserved from the real provider; only
 * the identifying parts are replaced. The agent therefore cannot tell which
 * model answers it, and — more usefully — cannot ask for a different one: the
 * name it sends is overwritten on the way out.
 */
async function maskedProviderEntry(homeDir, provider, realModel, endpoint) {
  const real = await findModelDefinition(homeDir, provider, realModel);
  return {
    name: MASKED_PROVIDER,
    api: endpoint.api || real?.api || "openai-completions",
    ...(real?.compat ? { compat: real.compat } : {}),
    models: [
      {
        id: MASKED_MODEL,
        reasoning: real?.reasoning ?? true,
        // Context limits drive compaction: a wrong number makes pi trim too
        // early or overflow the real window.
        contextWindow: real?.contextWindow ?? real?.context ?? undefined,
        maxTokens: real?.maxTokens ?? real?.maxOutput ?? undefined,
        input: real?.input ?? undefined,
        cost: real?.cost ?? undefined
      }
    ]
  };
}

/** The real model's definition, from the user's table or pi's catalogue. */
async function findModelDefinition(homeDir, provider, model) {
  if (!model) {
    return null;
  }
  try {
    const file = path.join(homeDir, ".pi", "agent", "models.json");
    const entry = JSON.parse(fs.readFileSync(file, "utf8"))?.providers?.[provider];
    const found = entry?.models?.find((candidate) => candidate?.id === model);
    if (found) {
      return { ...found, api: entry.api, compat: entry.compat };
    }
  } catch {
    // Fall through to the built-in catalogue.
  }
  const catalogue = await loadBuiltInCatalogue();
  return catalogue?.[provider]?.[model] ?? null;
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
export async function startCredentialProxy({ homeDir, provider, model = null, authEntry, onWarning = null } = {}) {
  const endpoint = await resolveProviderEndpoint(homeDir, provider);
  const credential = credentialOf(authEntry);
  if (!endpoint || !credential) {
    return null;
  }

  const token = `pi-run-${crypto.randomBytes(24).toString("hex")}`;
  // The container is told it is talking to a generic endpoint. Which model
  // actually answers is decided here, so an agent cannot quietly move itself to
  // a bigger one — the bill for that arrives on the host, not in the sandbox.
  const realModel = modelIdFor(provider, model);
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
    // transfer-encoding especially: leaving it while adding content-length
    // makes the framing ambiguous, and a correct server answers 400 rather
    // than guess which one to believe.
    for (const header of ["host", "connection", "content-length", "transfer-encoding", "keep-alive", "te", "trailer", "upgrade", "proxy-authorization"]) {
      delete headers[header];
    }
    headers.authorization = `Bearer ${credential}`;

    const forward = (body) => {
      if (body != null) {
        headers["content-length"] = Buffer.byteLength(body);
      }
      const proxied = transport.request(
        target,
        { method: request.method, headers, timeout: UPSTREAM_TIMEOUT_MS },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          // Piped rather than buffered: token streams arrive as they are
          // produced, and buffering would turn a live transcript into one late
          // blob. Only the request is ever held whole, and only to rename a
          // model — responses stay a stream.
          upstreamResponse.pipe(response);
          // pipe() detaches on a source error without closing the destination,
          // so a provider that drops mid-stream left the agent waiting for a
          // response that would never end — until the run's own timeout, half
          // an hour later. Ending the socket makes it a read error it can retry.
          upstreamResponse.on("error", () => response.destroy());
          upstreamResponse.on("aborted", () => response.destroy());
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

      if (body == null) {
        request.pipe(proxied);
      } else {
        proxied.end(body);
      }
    };

    if (!realModel) {
      forward(null);
      return;
    }

    // The model name lives in the request body, so the body has to be read
    // before it can be corrected. Anything that is not the JSON we expect is
    // passed through untouched rather than rejected: the proxy is not the place
    // to decide what a provider accepts.
    const chunks = [];
    let size = 0;
    let refused = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      // The body is held whole only to rename a model. Without a ceiling the
      // agent — which legitimately holds the token — could exhaust the host
      // process with one large POST.
      if (size > MAX_REQUEST_BODY_BYTES && !refused) {
        refused = true;
        response.writeHead(413, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Request body too large for the proxy." } }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", () => response.destroy());
    request.on("end", () => {
      if (refused) {
        return;
      }
      const raw = Buffer.concat(chunks);
      try {
        const payload = JSON.parse(raw.toString("utf8"));
        if (payload && typeof payload === "object" && "model" in payload) {
          payload.model = realModel;
          forward(Buffer.from(JSON.stringify(payload), "utf8"));
          return;
        }
      } catch {
        // Not JSON, or not shaped as expected.
      }
      forward(raw);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback only: the container reaches it through the host gateway, and
    // nothing outside this machine can.
    server.listen(0, "127.0.0.1", resolve);
    // A listening socket keeps the event loop alive: an early throw between
    // starting the proxy and closing it left the CLI hanging forever, with the
    // run token still answering on loopback.
    server.unref();
  });

  const { port } = server.address();
  return {
    url: `http://host.docker.internal:${port}`,
    token,
    // What the container is told about its endpoint: a generic provider with a
    // single model. `api`, `compat` and the limits are copied from the real
    // entry — those decide how pi talks (whether thinking is sent, when it
    // compacts), and lying about them would change behaviour, not just names.
    providerEntry: await maskedProviderEntry(homeDir, provider, realModel, endpoint),
    realModel,
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
