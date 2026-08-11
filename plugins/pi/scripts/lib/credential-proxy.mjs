import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import path from "node:path";
import { URL } from "node:url";

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
export function resolveProviderEndpoint(homeDir, provider) {
  if (!provider) {
    return null;
  }
  try {
    const file = path.join(homeDir, ".pi", "agent", "models.json");
    const entry = JSON.parse(fs.readFileSync(file, "utf8"))?.providers?.[provider];
    return entry?.baseUrl ? { baseUrl: String(entry.baseUrl), api: String(entry.api ?? "") } : null;
  } catch {
    return null;
  }
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
  const endpoint = resolveProviderEndpoint(homeDir, provider);
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

    const target = new URL(`${upstream.pathname.replace(/\/$/, "")}${request.url}`, upstream);
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
