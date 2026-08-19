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
  assert.equal(await resolveProviderEndpoint(home, "unknown-provider"), null);
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

test("the agent is told a generic model, and cannot choose a different one", async () => {
  const upstream = await startUpstream();
  const home = fakeHome(upstream.port);

  const proxy = await startCredentialProxy({
    homeDir: home,
    provider: "test-provider",
    model: "test-provider/real-model-v2",
    authEntry: { type: "api_key", key: "REAL-SECRET-KEY" }
  });
  const local = proxy.url.replace("host.docker.internal", "127.0.0.1");

  try {
    // What the container is handed: no provider name, no model name, no address.
    assert.equal(proxy.providerEntry.name, "sandbox");
    assert.deepEqual(proxy.providerEntry.models.map((entry) => entry.id), ["agent-model"]);
    assert.equal(proxy.realModel, "real-model-v2");

    // An agent asking for something else — a bigger model on the same account —
    // gets what the host picked: the name is rewritten on the way out.
    await fetch(`${local}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "expensive-model", messages: [{ role: "user", content: "hi" }] })
    });

    const [call] = upstream.seen;
    assert.equal(JSON.parse(call.body).model, "real-model-v2", "the host decides which model answers");
    assert.match(call.body, /"content":"hi"/, "the rest of the request is untouched");
  } finally {
    await proxy.close();
    await upstream.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("behavioural fields survive the mask, since they change how pi talks", async () => {
  const upstream = await startUpstream();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-proxy-home-"));
  const agent = path.join(home, ".pi", "agent");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(
    path.join(agent, "models.json"),
    JSON.stringify({
      providers: {
        "test-provider": {
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          api: "openai-completions",
          compat: { supportsReasoningEffort: false },
          models: [{ id: "real-model-v2", reasoning: true, contextWindow: 123456 }]
        }
      }
    })
  );

  const proxy = await startCredentialProxy({
    homeDir: home,
    provider: "test-provider",
    model: "real-model-v2",
    authEntry: { key: "k" }
  });

  try {
    // Lying about these would not hide anything — it would change behaviour:
    // whether thinking is sent, and when pi decides to compact.
    assert.equal(proxy.providerEntry.api, "openai-completions");
    assert.deepEqual(proxy.providerEntry.compat, { supportsReasoningEffort: false });
    assert.equal(proxy.providerEntry.models[0].contextWindow, 123456);
    assert.equal(proxy.providerEntry.models[0].reasoning, true);
  } finally {
    await proxy.close();
    await upstream.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("only the provider prefix is stripped, so ids containing slashes survive", async () => {
  const { modelIdFor } = await import("../plugins/pi/scripts/lib/credential-proxy.mjs");

  // Model ids at openrouter and the gateways contain slashes of their own;
  // cutting at the last one produced a name no provider knows.
  assert.equal(modelIdFor("openrouter", "openrouter/deepseek/deepseek-v4-flash-0731"), "deepseek/deepseek-v4-flash-0731");
  assert.equal(modelIdFor("openrouter", "openrouter/anthropic/claude-sonnet-4.5"), "anthropic/claude-sonnet-4.5");
  assert.equal(modelIdFor("ollama-pro", "ollama-pro/deepseek-v4-flash:0731"), "deepseek-v4-flash:0731");

  // A thinking level is pi's own syntax and travels as a flag…
  assert.equal(modelIdFor("opencode-go", "opencode-go/glm-5.2:high"), "glm-5.2");
  // …while a colon that is part of the id stays put.
  assert.equal(modelIdFor("ollama-pro", "deepseek-v4-flash:preview"), "deepseek-v4-flash:preview");
});

test("a provider that drops mid-stream ends the client instead of hanging it", async () => {
  const http = await import("node:http");
  const { startCredentialProxy } = await import("../plugins/pi/scripts/lib/credential-proxy.mjs");

  // Upstream writes two chunks and destroys the socket, the way a provider does
  // when it fails halfway through a stream.
  const flaky = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: one\n\n");
    setTimeout(() => response.destroy(), 20);
  });
  await new Promise((resolve) => flaky.listen(0, "127.0.0.1", resolve));

  const home = fakeHome(flaky.address().port);
  const proxy = await startCredentialProxy({ homeDir: home, provider: "test-provider", authEntry: { key: "k" } });
  const local = proxy.url.replace("host.docker.internal", "127.0.0.1");

  try {
    // Without the error handler this read never settles and the run waits for
    // its own timeout — half an hour by default.
    const settled = await Promise.race([
      fetch(`${local}/chat`, { method: "POST", headers: { authorization: `Bearer ${proxy.token}` }, body: "{}" })
        .then((response) => response.text())
        .then(() => "finished", () => "errored"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 4000))
    ]);
    assert.notEqual(settled, "hung", "the client must not be left waiting");
  } finally {
    await proxy.close();
    await new Promise((resolve) => flaky.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("masking does not silently disable prompt caching on OpenAI", async () => {
  const { startCredentialProxy } = await import("../plugins/pi/scripts/lib/credential-proxy.mjs");
  const upstream = await startUpstream();

  // pi keys this decision off the model's base URL, which the mask replaces —
  // so the proxy has to put the key back for hosts that understand it.
  const openaiLike = fakeHome(upstream.port, { baseUrl: `http://api.openai.com.127.0.0.1.nip.io:${upstream.port}/v1` });
  const plain = fakeHome(upstream.port);

  for (const [home, expectKey] of [[openaiLike, true], [plain, false]]) {
    const proxy = await startCredentialProxy({
      homeDir: home,
      provider: "test-provider",
      model: "real-model",
      authEntry: { key: "k" }
    });
    const local = proxy.url.replace("host.docker.internal", "127.0.0.1");
    try {
      await fetch(`${local}/chat`, {
        method: "POST",
        headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "agent-model", messages: [] })
      }).catch(() => {});
      const call = upstream.seen.at(-1);
      const sent = call ? Boolean(JSON.parse(call.body).prompt_cache_key) : false;
      assert.equal(sent, expectKey);
    } finally {
      await proxy.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
  await upstream.close();
});

/** A home whose model declares sampling parameters, as a user would write them. */
function homeWithSampling(port, samplingParams) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-proxy-home-"));
  const agent = path.join(home, ".pi", "agent");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(
    path.join(agent, "models.json"),
    JSON.stringify({
      providers: {
        "test-provider": {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          models: [{ id: "real-model-v2", samplingParams }]
        }
      }
    })
  );
  return home;
}

async function withSamplingProxy(samplingParams, body) {
  const upstream = await startUpstream();
  const home = homeWithSampling(upstream.port, samplingParams);
  const proxy = await startCredentialProxy({
    homeDir: home,
    provider: "test-provider",
    model: "test-provider/real-model-v2",
    authEntry: { type: "api_key", key: "REAL-SECRET-KEY" }
  });
  const local = proxy.url.replace("host.docker.internal", "127.0.0.1");
  try {
    await fetch(`${local}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return JSON.parse(upstream.seen[0].body);
  } finally {
    await proxy.close();
    await upstream.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// The failure this exists for: pi accepts `samplingParams` in models.json and
// then never sends them, so a run goes out with no output ceiling at all and a
// model that starts repeating itself generates until the server's own maximum.
test("declared samplingParams reach the request pi omits them from", async () => {
  const sent = await withSamplingProxy(
    { max_tokens: 16384 },
    { model: "agent-model", messages: [{ role: "user", content: "hi" }] }
  );
  assert.equal(sent.max_tokens, 16384, "the ceiling the user declared is on the wire");
  assert.equal(sent.model, "real-model-v2", "masking still applies");
});

test("what pi did set is left alone — the proxy fills gaps, it does not overrule", async () => {
  const sent = await withSamplingProxy(
    { max_tokens: 16384, temperature: 0.2 },
    { model: "agent-model", max_tokens: 512, messages: [] }
  );
  assert.equal(sent.max_tokens, 512, "an explicit request parameter wins");
  assert.equal(sent.temperature, 0.2, "the untouched key is still delivered");
});

test("the two spellings of the output ceiling never both appear", async () => {
  const sent = await withSamplingProxy(
    { max_tokens: 16384 },
    { model: "agent-model", max_completion_tokens: 4096, messages: [] }
  );
  assert.equal(sent.max_completion_tokens, 4096);
  assert.ok(!("max_tokens" in sent), "an API that wants the newer name would reject the pair");
});

test("a model without samplingParams is passed through unchanged", async () => {
  const sent = await withSamplingProxy(undefined, { model: "agent-model", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(Object.keys(sent).sort(), ["messages", "model"], "nothing invented");
});

// pi picks the ceiling field from the provider name and base URL; the mask
// replaces both, so a provider that only understands `max_tokens` was being
// sent `max_completion_tokens` and silently ran with no ceiling at all.
test("the ceiling field survives the mask for a provider that needs the older one", async () => {
  const upstream = await startUpstream();
  // The provider has to be named as the user names it: the ceiling field is
  // decided from the real name and address, before the mask replaces both.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-proxy-home-"));
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".pi", "agent", "models.json"),
    JSON.stringify({ providers: { "ollama-pro": { baseUrl: "https://ollama.com/v1", api: "openai-completions" } } })
  );
  const proxy = await startCredentialProxy({
    homeDir: home,
    provider: "ollama-pro",
    model: "ollama-pro/some-model",
    authEntry: { type: "api_key", key: "K" }
  });
  try {
    assert.equal(proxy.providerEntry.compat?.maxTokensField, "max_tokens");
  } finally {
    await proxy.close();
    await upstream.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
