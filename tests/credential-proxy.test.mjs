import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { credentialOf, resolveProviderEndpoint, startCredentialProxy } from "../plugins/pi/scripts/lib/credential-proxy.mjs";

/** A stand-in model host that reports what it was sent. */
async function startUpstream() {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8")
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A home directory whose models.json points at the fake upstream. */
function fakeHome(port, { baseUrl = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-proxy-home-"));
  const agent = path.join(home, ".pi", "agent");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(
    path.join(agent, "models.json"),
    JSON.stringify({
      providers: {
        "test-provider": { baseUrl: baseUrl ?? `http://127.0.0.1:${port}/v1`, api: "openai-completions" }
      }
    })
  );
  return home;
}

test("the container's token is exchanged for the real credential on the host", async () => {
  const upstream = await startUpstream();
  const home = fakeHome(upstream.port);

  const proxy = await startCredentialProxy({
    homeDir: home,
    provider: "test-provider",
    authEntry: { type: "api", key: "REAL-SECRET-KEY" }
  });
  assert.ok(proxy, "a provider with a known base URL can be proxied");

  try {
    // The container only ever knows the run token.
    const local = proxy.url.replace("host.docker.internal", "127.0.0.1");
    const response = await fetch(`${local}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] })
    });
    assert.equal(response.status, 200);

    const [call] = upstream.seen;
    assert.equal(call.authorization, "Bearer REAL-SECRET-KEY", "the real key is attached on the host");
    assert.equal(call.url, "/v1/chat/completions", "the provider's own path prefix is preserved");
    assert.match(call.body, /"model":"m"/, "the request body passes through untouched");
    assert.notEqual(proxy.token, "REAL-SECRET-KEY");
  } finally {
    await proxy.close();
    await upstream.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a wrong or missing token never reaches the provider", async () => {
  const upstream = await startUpstream();
  const home = fakeHome(upstream.port);
  const proxy = await startCredentialProxy({
    homeDir: home,
    provider: "test-provider",
    authEntry: { key: "REAL-SECRET-KEY" }
  });

  try {
    const local = proxy.url.replace("host.docker.internal", "127.0.0.1");
    for (const headers of [{}, { authorization: "Bearer guessed" }]) {
      const response = await fetch(`${local}/chat/completions`, { method: "POST", headers, body: "{}" });
      assert.equal(response.status, 401);
    }
    assert.deepEqual(upstream.seen, [], "nothing was forwarded");
  } finally {
    await proxy.close();
    await upstream.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the proxy stops answering once the run is over", async () => {
  const upstream = await startUpstream();
  const home = fakeHome(upstream.port);
  const proxy = await startCredentialProxy({ homeDir: home, provider: "test-provider", authEntry: { key: "k" } });
  const local = proxy.url.replace("host.docker.internal", "127.0.0.1");
  await proxy.close();

  // A token that leaked out of a finished run is worth nothing: there is no
  // longer anything listening for it.
  await assert.rejects(() => fetch(`${local}/chat/completions`, { method: "POST", body: "{}" }));
  await upstream.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("providers without a known endpoint are not proxied, and OAuth records are understood", async () => {
  const upstream = await startUpstream();
  const home = fakeHome(upstream.port);

  // Not in models.json: the caller falls back instead of getting a broken proxy.
  assert.equal(resolveProviderEndpoint(home, "unknown-provider"), null);
  assert.equal(await startCredentialProxy({ homeDir: home, provider: "unknown-provider", authEntry: { key: "k" } }), null);

  // An entry with no usable credential is not proxyable either.
  assert.equal(await startCredentialProxy({ homeDir: home, provider: "test-provider", authEntry: {} }), null);

  assert.equal(credentialOf({ type: "api", key: "k" }), "k");
  assert.equal(credentialOf({ type: "oauth", access: "a", refresh: "r" }), "a", "OAuth sends its access token");
  assert.equal(credentialOf(null), null);

  await upstream.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("the request path cannot move the destination, so the key cannot be exfiltrated", async () => {
  // The upstream here is the attacker's server: if the proxy can be talked into
  // sending the real key anywhere, this is where it lands.
  const attacker = await startUpstream();
  // A base URL with no path is the dangerous shape — `//host/x` then resolves as
  // a protocol-relative URL and replaces the origin outright.
  const home = fakeHome(attacker.port, { baseUrl: "http://127.0.0.1:1/" });
  const proxy = await startCredentialProxy({
    homeDir: home,
    provider: "test-provider",
    authEntry: { type: "api_key", key: "REAL-SECRET-KEY" }
  });
  const local = proxy.url.replace("host.docker.internal", "127.0.0.1");

  try {
    for (const attempt of [
      `//127.0.0.1:${attacker.port}/steal`,
      `/\\/127.0.0.1:${attacker.port}/steal`,
      `https://127.0.0.1:${attacker.port}/steal`
    ]) {
      const response = await fetch(`${local}${attempt}`, {
        method: "POST",
        headers: { authorization: `Bearer ${proxy.token}` },
        body: "{}"
      }).catch((error) => ({ status: `refused: ${error.message.slice(0, 20)}` }));
      assert.notEqual(response.status, 200, `${attempt} must not succeed`);
    }
    assert.deepEqual(attacker.seen, [], "the credential never reached another host");
  } finally {
    await proxy.close();
    await attacker.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
