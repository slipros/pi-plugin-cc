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

/** A home whose models.json says exactly what one test needs it to say. */
function homeWithProviders(providers) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-proxy-home-"));
  const agent = path.join(home, ".pi", "agent");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers }));
  return home;
}

/** What the mask hands the container for one provider entry, and nothing else. */
async function maskedEntryFor(provider, entry, model = `${provider}/some-model`) {
  const home = homeWithProviders({ [provider]: entry });
  const proxy = await startCredentialProxy({ homeDir: home, provider, model, authEntry: { key: "K" } });
  try {
    return proxy.providerEntry;
  } finally {
    await proxy.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// pi decides the ceiling field in `detectCompat` (`openai-completions.js`) from
// the provider name and the base URL — nine providers, not one — and the mask
// replaces both. A list covering a ninth of that table left the rest running
// with `max_completion_tokens` and therefore with no ceiling at all.
test("the ceiling field is restored for every provider pi's own table names", async () => {
  const legacy = [
    // Matched by base URL, the way pi matches them.
    ["gw", "https://llm.chutes.ai/v1"],
    ["seek", "https://api.deepseek.com/v1"],
    ["kimi", "https://api.moonshot.cn/v1"],
    ["cf", "https://gateway.ai.cloudflare.com/v1/acc/gw/openai"],
    ["tog", "https://api.together.ai/v1"],
    ["tog-xyz", "https://api.together.xyz/v1"],
    ["nim", "https://integrate.api.nvidia.com/v1"],
    ["ling", "https://api.ant-ling.com/v1"],
    ["glm", "https://api.z.ai/api/paas/v4"],
    ["glm-cn", "https://open.bigmodel.cn/api/paas/v4"],
    // Matched by provider name, also the way pi matches them: a user is free to
    // point pi's own provider at a mirror.
    ["deepseek", "https://mirror.example.com/v1"],
    ["moonshotai", "https://mirror.example.com/v1"],
    ["moonshotai-cn", "https://mirror.example.com/v1"],
    ["together", "https://mirror.example.com/v1"],
    ["cloudflare-ai-gateway", "https://mirror.example.com/v1"],
    ["nvidia", "https://mirror.example.com/v1"],
    ["ant-ling", "https://mirror.example.com/v1"],
    ["zai", "https://mirror.example.com/v1"],
    ["zai-coding-cn", "https://mirror.example.com/v1"],
    // Measured rather than read out of pi: this endpoint ignores the newer field.
    ["ollama-pro", "https://ollama.com/v1"]
  ];
  for (const [provider, baseUrl] of legacy) {
    const entry = await maskedEntryFor(provider, { baseUrl, api: "openai-completions" });
    assert.equal(entry.compat?.maxTokensField, "max_tokens", `${provider} at ${baseUrl}`);
  }

  // Everyone else keeps pi's own inference: guessing in the other direction
  // breaks a provider that refuses the field it does not use.
  for (const [provider, baseUrl] of [
    ["oai", "https://api.openai.com/v1"],
    ["groq", "https://api.groq.com/openai/v1"],
    ["router", "https://openrouter.ai/api/v1"]
  ]) {
    const entry = await maskedEntryFor(provider, { baseUrl, api: "openai-completions" });
    assert.equal(entry.compat?.maxTokensField, undefined, `${provider} at ${baseUrl}`);
  }
});

// The name a user gives a provider says nothing about what answers behind it:
// LiteLLM and vLLM are routinely called `…-ollama-…` and want the newer field.
test("a provider is judged by its address, not by having ollama in its name", async () => {
  const elsewhere = { baseUrl: "http://127.0.0.1:8000/v1", api: "openai-completions" };
  const gateway = await maskedEntryFor("my-ollama-gateway", elsewhere);
  assert.equal(gateway.compat?.maxTokensField, undefined, "the name is not evidence");

  // Local Ollama is matched honestly instead: where it actually answers.
  for (const baseUrl of ["http://localhost:11434/v1", "http://127.0.0.1:11434/v1", "http://[::1]:11434/v1"]) {
    const local = await maskedEntryFor("anything", { baseUrl, api: "openai-completions" });
    assert.equal(local.compat?.maxTokensField, "max_tokens", baseUrl);
  }
});

// The provider's `compat` was only read when its `models[]` happened to list
// the model being run — so a user who wrote `max_completion_tokens` on a
// provider whose models pi already knows had it dropped and the proxy's own
// guess put in its place. A stated choice is not a gap to fill.
test("an explicit compat wins even for a model the provider does not list", async () => {
  const stated = await maskedEntryFor(
    "seek",
    {
      baseUrl: "https://api.deepseek.com/v1",
      api: "openai-completions",
      compat: { maxTokensField: "max_completion_tokens" },
      models: [{ id: "some-other-model" }]
    },
    "seek/unlisted-model"
  );
  assert.equal(stated.compat?.maxTokensField, "max_completion_tokens", "the user's choice stands");

  // The rest of a provider-level compat crosses the mask on the same terms,
  // with the detected field filling only what nobody stated.
  const partial = await maskedEntryFor(
    "seek",
    {
      baseUrl: "https://api.deepseek.com/v1",
      api: "openai-completions",
      compat: { supportsReasoningEffort: false },
      models: [{ id: "some-other-model" }]
    },
    "seek/unlisted-model"
  );
  assert.deepEqual(partial.compat, { supportsReasoningEffort: false, maxTokensField: "max_tokens" });

  // A model that IS listed still overrules its provider, the way pi merges the
  // two (`provider-composer.js`).
  const specific = await maskedEntryFor(
    "seek",
    {
      baseUrl: "https://api.deepseek.com/v1",
      api: "openai-completions",
      compat: { maxTokensField: "max_completion_tokens" },
      models: [{ id: "listed-model", compat: { maxTokensField: "max_tokens" } }]
    },
    "seek/listed-model"
  );
  assert.equal(specific.compat?.maxTokensField, "max_tokens", "the more specific entry wins");
});

// The mask exists to stop an agent choosing its own model on the host's account.
// A body the proxy could not read went upstream exactly as written — measured
// with `content-encoding: gzip`, which reached the provider with the agent's own
// `model` intact and no ceiling applied.
test("a body that should have been read and could not be is refused, not relayed", async () => {
  const zlib = await import("node:zlib");
  const upstream = await startUpstream();
  const home = fakeHome(upstream.port);
  const proxy = await startCredentialProxy({
    homeDir: home,
    provider: "test-provider",
    model: "test-provider/real-model-v2",
    authEntry: { key: "K" }
  });
  const local = proxy.url.replace("host.docker.internal", "127.0.0.1");
  const auth = { authorization: `Bearer ${proxy.token}` };

  try {
    const gzipped = await fetch(`${local}/chat/completions`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "content-encoding": "gzip" },
      body: zlib.gzipSync(Buffer.from(JSON.stringify({ model: "expensive-model", messages: [] }), "utf8"))
    });
    assert.equal(gzipped.status, 400, "a body the proxy cannot decode does not travel");

    const broken = await fetch(`${local}/chat/completions`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{ model: not json at all"
    });
    assert.equal(broken.status, 400, "JSON that is not JSON is not somebody else's problem");
    assert.deepEqual(upstream.seen, [], "neither reached the provider");

    // Anything the proxy was never asked to understand is left alone: an upload
    // is not a chat request and carries no model to rewrite.
    const upload = await fetch(`${local}/files`, {
      method: "POST",
      headers: { ...auth, "content-type": "multipart/form-data; boundary=xx" },
      body: "--xx\r\ncontent-disposition: form-data; name=\"file\"\r\n\r\nbytes\r\n--xx--\r\n"
    });
    assert.equal(upload.status, 200);
    assert.match(upstream.seen.at(-1).body, /name="file"/, "the upload crossed untouched");

    // And a request with no body at all is still a request.
    const listing = await fetch(`${local}/models`, { headers: auth });
    assert.equal(listing.status, 200);
    assert.equal(upstream.seen.at(-1).url, "/v1/models");
  } finally {
    await proxy.close();
    await upstream.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Everything the proxy says for itself is read by the agent, which is on the
// other side of the mask: a 502 quoting `connect ECONNREFUSED 127.0.0.1:1` names
// the endpoint as surely as a header would.
test("a transport failure is reported to the host, not described to the container", async () => {
  const home = fakeHome(0, { baseUrl: "http://127.0.0.1:1/v1" });
  const warnings = [];
  const proxy = await startCredentialProxy({
    homeDir: home,
    provider: "test-provider",
    model: "test-provider/real-model-v2",
    authEntry: { key: "K" },
    onWarning: (message) => warnings.push(message)
  });
  const local = proxy.url.replace("host.docker.internal", "127.0.0.1");

  try {
    const response = await fetch(`${local}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "agent-model", messages: [] })
    });
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.ok(!body.includes("127.0.0.1"), `the address is not in ${body}`);
    assert.ok(!/ECONNREFUSED/i.test(body), `the transport error is not in ${body}`);
    // The detail is not lost — it goes where it can be acted on.
    assert.match(warnings.join("\n"), /127\.0\.0\.1:1/);
  } finally {
    await proxy.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Handing back the provider's own response headers named it outright:
// `openai-organization`, `server: cloudflare`, a vendor-prefixed rate limit.
test("provider response headers do not cross the mask, and streaming still does", async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "retry-after": "3",
      "x-ratelimit-remaining-requests": "42",
      "openai-organization": "org-real-account",
      "anthropic-ratelimit-requests-remaining": "7",
      "x-request-id": "req_provider_side",
      server: "cloudflare",
      "set-cookie": "session=provider"
    });
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const home = fakeHome(server.address().port);
  const proxy = await startCredentialProxy({ homeDir: home, provider: "test-provider", authEntry: { key: "K" } });
  const local = proxy.url.replace("host.docker.internal", "127.0.0.1");

  try {
    const response = await fetch(`${local}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
      body: "{}"
    });
    await response.text();

    // What a client needs to read the answer, and SSE above all.
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.equal(response.headers.get("retry-after"), "3");
    assert.equal(response.headers.get("x-ratelimit-remaining-requests"), "42");
    // What names the provider.
    for (const header of [
      "openai-organization",
      "anthropic-ratelimit-requests-remaining",
      "x-request-id",
      "server",
      "set-cookie"
    ]) {
      assert.equal(response.headers.get(header), null, `${header} must not reach the container`);
    }
  } finally {
    await proxy.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// A preset that names no model gets the credential boundary and neither of the
// other two guarantees. Quietly weaker on some runs than on others is the worst
// of the three states.
test("a run with no model says so rather than masking nothing quietly", async () => {
  const upstream = await startUpstream();
  const home = fakeHome(upstream.port);
  const warnings = [];
  const proxy = await startCredentialProxy({
    homeDir: home,
    provider: "test-provider",
    authEntry: { key: "K" },
    onWarning: (message) => warnings.push(message)
  });
  const named = [];
  const withModel = await startCredentialProxy({
    homeDir: home,
    provider: "test-provider",
    model: "test-provider/real-model-v2",
    authEntry: { key: "K" },
    onWarning: (message) => named.push(message)
  });

  try {
    assert.equal(proxy.realModel, null);
    assert.match(warnings.join("\n"), /names no model/i);
    assert.deepEqual(named, [], "a run that did pick a model has nothing to warn about");
  } finally {
    await proxy.close();
    await withModel.close();
    await upstream.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// The answer that ran into the ceiling is by definition a long one, and a
// bounded HEAD of the body lost exactly those: `finish_reason` sits behind the
// whole answer, so 70 KB of output recorded no reason for stopping at all.
test("a long answer keeps the reason it stopped", async () => {
  const long = JSON.stringify({
    id: "cmpl-long",
    choices: [{ index: 0, message: { role: "assistant", content: "x".repeat(70 * 1024) }, finish_reason: "length" }],
    usage: { prompt_tokens: 11, completion_tokens: 4096 }
  });
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    // In chunks, the way a body of this size actually arrives.
    for (let at = 0; at < long.length; at += 8 * 1024) {
      response.write(long.slice(at, at + 8 * 1024));
    }
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const home = fakeHome(server.address().port);
  const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-proxy-db-"));
  const previousDatabase = process.env.PI_PLUGIN_DB;
  process.env.PI_PLUGIN_DB = path.join(databaseDir, "jobs.db");
  const proxy = await startCredentialProxy({
    homeDir: home,
    provider: "test-provider",
    model: "test-provider/real-model-v2",
    authEntry: { key: "K" },
    jobId: "proxy-tail-test"
  });
  const local = proxy.url.replace("host.docker.internal", "127.0.0.1");

  try {
    const response = await fetch(`${local}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "agent-model", messages: [] })
    });
    const received = await response.text();
    assert.equal(received.length, long.length, "the answer itself is untouched");
    await proxy.close();
    assert.equal(proxy.stats().lastFinishReason, "length", "the reason survived a body far past the window");
  } finally {
    await proxy.close();
    await new Promise((resolve) => server.close(resolve));
    if (previousDatabase === undefined) {
      delete process.env.PI_PLUGIN_DB;
    } else {
      process.env.PI_PLUGIN_DB = previousDatabase;
    }
    fs.rmSync(databaseDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// The meter is the proxy's instrument and these two failures are the proxy's:
// how much of a body reaches it, and which providers it can read when it does.
test("a body kept as a tail still says why the answer stopped and what it cost", async () => {
  const { createStreamMeter } = await import("../plugins/pi/scripts/lib/sse-meter.mjs");
  const whole = JSON.stringify({
    choices: [{ message: { content: "y".repeat(4096) }, finish_reason: "length" }],
    usage: { prompt_tokens: 7, completion_tokens: 9 }
  });

  const cut = createStreamMeter();
  cut.finishNonStream(whole.slice(-2048));
  const fromTail = cut.summary();
  assert.equal(fromTail.finish_reason, "length");
  assert.equal(fromTail.out_tokens, 9, "the usage behind the answer is read too");

  // A body that fits is still parsed rather than scanned.
  const kept = createStreamMeter();
  kept.finishNonStream(whole);
  assert.equal(kept.summary().finish_reason, "length");
  assert.equal(kept.summary().in_tokens, 7);

  // Text that merely talks about a finish reason is not one: inside a JSON body
  // the answer's own quotes are escaped.
  const quoted = createStreamMeter();
  quoted.finishNonStream(JSON.stringify({ choices: [{ message: { content: '{"finish_reason":"length"}' } }] }));
  assert.equal(quoted.summary().finish_reason, null);
});

test("Google's spelling of the finish reason is read, and read raw", async () => {
  const { createStreamMeter } = await import("../plugins/pi/scripts/lib/sse-meter.mjs");
  const streamed = createStreamMeter();
  streamed.push(
    Buffer.from(
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "MAX_TOKENS" }] })}\n\n`,
      "utf8"
    )
  );
  // Raw, as every other provider's is: what `MAX_TOKENS` means is the reader's
  // decision, and a value normalised on the way in cannot be un-normalised.
  assert.equal(streamed.summary().finish_reason, "MAX_TOKENS");

  const whole = createStreamMeter();
  whole.finishNonStream(JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS" }] }));
  assert.equal(whole.summary().finish_reason, "MAX_TOKENS");
});
