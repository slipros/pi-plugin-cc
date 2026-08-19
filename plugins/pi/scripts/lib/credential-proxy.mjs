import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL, URL } from "node:url";

import { runCommand } from "./process.mjs";
import { PROXY_BIND_ADDRESS } from "./proxy-bind.mjs";
import { createStreamMeter } from "./sse-meter.mjs";
import { createRequestRecorder } from "./telemetry.mjs";

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

function parseInteger(value) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) ? number : null;
}

/** `Retry-After` is either a delay in seconds or an HTTP date. */
function parseRetryAfter(value) {
  if (value == null) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.round(seconds * 1000);
  }
  const when = Date.parse(String(value));
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

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
async function describeBuiltInProvider(provider) {
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

/**
 * Put back the prompt cache key that masking took away.
 *
 * pi decides whether to send `prompt_cache_key` by looking at the model's base
 * URL (`openai-completions.js`: `model.baseUrl.includes("api.openai.com")`).
 * Behind the mask that URL is the proxy, so the check fails and prompt caching
 * silently stops for anyone actually on OpenAI — a real cost increase caused by
 * hiding the endpoint. The key only has to be stable within a run for the
 * provider to reuse its prefix, and the run token is exactly that.
 *
 * Added only where the field is known to be understood: an unexpected parameter
 * is an error at some gateways, and this is not the place to find that out.
 */
function restorePromptCacheKey(payload, upstream, token) {
  if (!upstream.host.includes("api.openai.com") || payload.prompt_cache_key) {
    return;
  }
  payload.prompt_cache_key = `pi-run-${crypto.createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
}

/**
 * Compare the offered token without leaking its length or prefix through timing.
 *
 * The listener is reachable by any container on the host, so the token is the
 * whole boundary; a `!==` returns as soon as bytes differ, which is a signal an
 * attacker can measure. Hashing first keeps the comparison over equal lengths.
 */
function sameToken(offered, expected) {
  const left = crypto.createHash("sha256").update(String(offered)).digest();
  const right = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(left, right);
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
/**
 * Which field this provider takes the output ceiling in.
 *
 * pi infers it from the provider name and base URL, and the mask replaces both:
 * behind it every provider looks like stock OpenAI and is sent
 * `max_completion_tokens`. An OpenAI-compatible endpoint that only knows
 * `max_tokens` then has no ceiling at all — it ignores the field it does not
 * recognise rather than refusing it. Measured on one such provider: a request
 * capped at 64 tokens came back with 15518, while the same cap in `max_tokens`
 * stopped at exactly 64. With no ceiling a model that slips into repeating
 * itself runs to the endpoint's own maximum, which cost one epic 46% of its
 * output tokens across nineteen responses.
 *
 * Only endpoints MEASURED to need the older field are named — the list is not a
 * guess about what OpenAI-compatible servers generally accept. Wrong in the
 * other direction it breaks providers that reject the field they do not use,
 * and a provider nobody has tested keeps pi's own inference.
 */
const LEGACY_MAX_TOKENS_HOSTS = ["ollama.com"];

async function detectMaxTokensField(provider, endpoint) {
  let host = "";
  try {
    host = new URL(endpoint.baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const name = String(provider ?? "").toLowerCase();
  if (LEGACY_MAX_TOKENS_HOSTS.some((known) => host === known || host.endsWith(`.${known}`)) || name.includes("ollama")) {
    return "max_tokens";
  }
  return null;
}

async function maskedProviderEntry(homeDir, provider, realModel, endpoint) {
  const real = await findModelDefinition(homeDir, provider, realModel);
  // The real provider name and address still resolve here, on the host, so the
  // decision is made before the mask and carried across it. Same shape of bug
  // as the prompt cache key above, and the same fix: what pi infers from the
  // address, the mask has to restore. An explicit `compat` from the user wins —
  // this fills a gap, it does not overrule a stated choice.
  const compat = { ...(real?.compat ?? {}) };
  if (compat.maxTokensField === undefined) {
    const field = await detectMaxTokensField(provider, endpoint);
    if (field) {
      compat.maxTokensField = field;
    }
  }
  return {
    name: MASKED_PROVIDER,
    api: endpoint.api || real?.api || "openai-completions",
    ...(Object.keys(compat).length ? { compat } : {}),
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

/**
 * Deliver the model's declared `samplingParams` to the request pi never puts
 * them in.
 *
 * pi validates the field in models.json and composes it onto the model object,
 * but the agent loop calls the provider with the *agent config* as options, and
 * nothing copies `model.samplingParams` there. The provider adapter reads
 * `options.samplingParams`, finds nothing, and the request goes out without the
 * ceiling the user declared. `maxTokens` fares no better: the agent config
 * defaults it to 0, the adapter guards on truthiness, and the field is omitted.
 *
 * What that costs is not theoretical. With no `max_tokens` the server applies
 * its own maximum; a model that slips into repeating itself then generates up
 * to that maximum before anything stops it. Measured on one epic's journal:
 * nineteen such responses — under one percent of all requests — burned 46% of
 * all output tokens, minutes of stream each. Worse than the tokens is the
 * shape of the failure: the truncated response ends mid tool call, the agent
 * discards it, and if that was the last turn the text half becomes the final
 * answer. The run then reports success with the work undone.
 *
 * Only missing keys are filled: whatever pi did set is its decision, and a
 * proxy overriding an explicit request parameter would be a much harder failure
 * to explain than the one this fixes.
 */
export function applySamplingParams(payload, samplingParams) {
  if (!payload || typeof payload !== "object" || !samplingParams || typeof samplingParams !== "object") {
    return payload;
  }
  for (const [key, value] of Object.entries(samplingParams)) {
    if (value === undefined || key in payload) {
      continue;
    }
    // The two spellings of one field: an API that wants the newer name rejects
    // the older outright, so declaring `max_tokens` must not smuggle in a
    // duplicate when pi already sent `max_completion_tokens`.
    if (key === "max_tokens" && "max_completion_tokens" in payload) {
      continue;
    }
    if (key === "max_completion_tokens" && "max_tokens" in payload) {
      continue;
    }
    payload[key] = value;
  }
  return payload;
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
export async function startCredentialProxy({
  homeDir,
  provider,
  model = null,
  authEntry,
  onWarning = null,
  // Telemetry is written per run, so the proxy has to know which run it serves.
  // Without an id nothing is recorded rather than orphaned rows accumulating.
  jobId = null
} = {}) {
  const endpoint = await resolveProviderEndpoint(homeDir, provider);
  const credential = credentialOf(authEntry);
  if (!endpoint || !credential) {
    return null;
  }

  const recorder = createRequestRecorder(jobId);
  const token = `pi-run-${crypto.randomBytes(24).toString("hex")}`;
  // The container is told it is talking to a generic endpoint. Which model
  // actually answers is decided here, so an agent cannot quietly move itself to
  // a bigger one — the bill for that arrives on the host, not in the sandbox.
  const realModel = modelIdFor(provider, model);
  // `samplingParams` of the model as the user declared them. pi accepts the
  // field in models.json and drops it on the agent loop — see
  // `applySamplingParams` for what that costs.
  const samplingParams = (await findModelDefinition(homeDir, provider, realModel))?.samplingParams ?? null;
  const upstream = new URL(endpoint.baseUrl);
  const transport = upstream.protocol === "http:" ? http : https;

  const server = http.createServer((request, response) => {
    // The token is the only thing standing between this listener and any other
    // container on the host, so it is checked before anything else happens.
    const offered = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!sameToken(offered, token)) {
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

    const forward = (body, streaming = false) => {
      if (body != null) {
        headers["content-length"] = Buffer.byteLength(body);
      }
      // One measured exchange. Nothing here holds content: the meter counts SSE
      // frames and drops them, and only the envelope reaches the journal.
      const measured = recorder
        ? {
            started_at: new Date().toISOString(),
            provider,
            model: realModel,
            api: endpoint.api ?? null,
            path: target.pathname ?? null,
            stream: streaming,
            request_bytes: body != null ? Buffer.byteLength(body) : null
          }
        : null;
      const startedAt = Date.now();
      let meter = null;
      let nonStreamBody = "";

      const finish = (extra = {}) => {
        if (!measured || measured.done) {
          return;
        }
        measured.done = true;
        recorder.record({
          ...measured,
          total_ms: Date.now() - startedAt,
          ...(meter ? meter.summary() : {}),
          ...extra
        });
      };

      const proxied = transport.request(
        target,
        { method: request.method, headers, timeout: UPSTREAM_TIMEOUT_MS },
        (upstreamResponse) => {
          const status = upstreamResponse.statusCode ?? 502;
          if (measured) {
            measured.status = status;
            measured.ttfb_ms = Date.now() - startedAt;
            // A whitelist, never the headers themselves: `authorization` here is
            // the provider's real key. These three say how close the run is to a
            // rate limit before the first 429 arrives.
            measured.retry_after_ms = parseRetryAfter(upstreamResponse.headers["retry-after"]);
            measured.rl_remaining = parseInteger(
              upstreamResponse.headers["x-ratelimit-remaining-requests"] ??
                upstreamResponse.headers["x-ratelimit-remaining"] ??
                upstreamResponse.headers["anthropic-ratelimit-requests-remaining"]
            );
            meter = createStreamMeter();
          }
          response.writeHead(status, upstreamResponse.headers);
          // Piped rather than buffered: token streams arrive as they are
          // produced, and buffering would turn a live transcript into one late
          // blob. Only the request is ever held whole, and only to rename a
          // model — responses stay a stream.
          upstreamResponse.on("data", (chunk) => {
            meter?.push(chunk);
            // A non-streaming answer carries its usage in one JSON body, so a
            // bounded head of it is kept — long enough to reach `usage`, short
            // enough not to be a copy of the answer.
            if (measured && !measured.stream && nonStreamBody.length < 64 * 1024) {
              nonStreamBody += chunk.toString("utf8");
            }
          });
          upstreamResponse.pipe(response);
          upstreamResponse.on("end", () => {
            if (measured && !measured.stream) {
              meter?.finishNonStream(nonStreamBody);
            }
            finish();
          });
          // pipe() detaches on a source error without closing the destination,
          // so a provider that drops mid-stream left the agent waiting for a
          // response that would never end — until the run's own timeout, half
          // an hour later. Ending the socket makes it a read error it can retry.
          upstreamResponse.on("error", () => {
            finish({ error_kind: "truncated" });
            response.destroy();
          });
          upstreamResponse.on("aborted", () => {
            finish({ error_kind: "aborted" });
            response.destroy();
          });
        }
      );

      proxied.on("timeout", () => {
        finish({ status: 0, error_kind: "timeout" });
        proxied.destroy(new Error("upstream timed out"));
      });
      proxied.on("error", (error) => {
        onWarning?.(`Model request failed: ${error.message}`);
        // Status 0, not 502: the provider never answered, and folding a
        // transport failure into its error rate would be a lie about it.
        finish({ status: 0, error_kind: "transport" });
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
          restorePromptCacheKey(payload, upstream, token);
          applySamplingParams(payload, samplingParams);
          // `stream` is read from the payload and nothing else is: without it
          // `ttfb_ms` cannot be read at all, since for a non-streaming request
          // it equals the whole generation.
          forward(Buffer.from(JSON.stringify(payload), "utf8"), payload.stream === true);
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
    // Not loopback, however much it should be: `host-gateway` does not reach it
    // there, and a run whose model endpoint is unreachable fails outright. The
    // run token is what makes the listener safe — see `proxy-bind.mjs`.
    server.listen(0, PROXY_BIND_ADDRESS, resolve);
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
    /** Roll-up for the job row; zeroes when nothing was recorded. */
    stats() {
      return recorder?.stats() ?? null;
    },
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        // Streaming responses hold sockets open; a run that is over does not
        // wait for them.
        server.closeAllConnections?.();
      });
      // Flushed after the sockets are gone, so requests that finished during
      // shutdown are in the batch.
      recorder?.close();
    }
  };
}
