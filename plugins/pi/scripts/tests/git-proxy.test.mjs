/**
 * Run: node --test scripts/tests/git-proxy.test.mjs
 *
 * The upstream here is a local server standing in for a forge: what matters is
 * which requests reach it, and with which credential.
 */

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { activeGitProxy, gitProxyConfig, resolveGitProxyHosts, startGitProxy } from "../lib/git-proxy.mjs";
import { PROXY_BIND_ADDRESS } from "../lib/proxy-bind.mjs";
import { buildDockerRunArgs } from "../lib/sandbox.mjs";

const REAL_TOKEN = "forge-secret-token";

async function startUpstream(handler) {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    if (handler) {
      handler(request, response);
      return;
    }
    response.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
    response.end("refs");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, seen, origin: `http://127.0.0.1:${server.address().port}` };
}

async function withProxy({ handler = null, spec = {} } = {}, body) {
  const upstream = await startUpstream(handler);
  const proxy = await startGitProxy({
    hosts: { "forge.test": { upstream: upstream.origin, user: "oauth2", token: REAL_TOKEN, ...spec } }
  });
  // The container reaches the proxy through the host gateway; a test reaches the
  // same listener on loopback.
  const base = proxy.url.replace("host.docker.internal", "127.0.0.1");
  try {
    return await body({ proxy, upstream, base });
  } finally {
    await proxy.close();
    upstream.server.close();
  }
}

function authHeader(token) {
  return `Basic ${Buffer.from(`git:${token}`, "utf8").toString("base64")}`;
}

async function call(base, path, { token, method = "GET", body: payload = null } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: token === undefined ? {} : { authorization: authHeader(token) },
    body: payload,
    redirect: "manual"
  });
}

test("a request without credentials is challenged, so git offers its token", async () => {
  await withProxy({}, async ({ base }) => {
    const response = await call(base, "/forge.test/repo.git/info/refs?service=git-upload-pack", { token: undefined });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /^Basic/);
  });
});

test("a wrong run token never reaches the upstream", async () => {
  await withProxy({}, async ({ base, upstream }) => {
    const response = await call(base, "/forge.test/repo.git/info/refs?service=git-upload-pack", { token: "wrong" });
    assert.equal(response.status, 403);
    assert.equal(upstream.seen.length, 0);
  });
});

test("fetch is forwarded with the real credential, which the container never held", async () => {
  await withProxy({}, async ({ base, proxy, upstream }) => {
    const response = await call(base, "/forge.test/repo.git/info/refs?service=git-upload-pack", { token: proxy.token });
    assert.equal(response.status, 200);
    assert.equal(upstream.seen.length, 1);

    const [request] = upstream.seen;
    assert.equal(request.url, "/repo.git/info/refs?service=git-upload-pack");
    const decoded = Buffer.from(request.authorization.replace(/^Basic\s+/, ""), "base64").toString("utf8");
    assert.equal(decoded, `oauth2:${REAL_TOKEN}`);
    assert.notEqual(decoded, `git:${proxy.token}`);
  });
});

test("upload-pack POST is forwarded body and all", async () => {
  await withProxy({}, async ({ base, proxy, upstream }) => {
    const response = await call(base, "/forge.test/repo.git/git-upload-pack", {
      token: proxy.token,
      method: "POST",
      body: "0032want cafebabe\n"
    });
    assert.equal(response.status, 200);
    assert.equal(upstream.seen.at(-1).url, "/repo.git/git-upload-pack");
  });
});

test("push is refused at both of its steps, before any credential is attached", async () => {
  await withProxy({}, async ({ base, proxy, upstream }) => {
    const advertisement = await call(base, "/forge.test/repo.git/info/refs?service=git-receive-pack", {
      token: proxy.token
    });
    assert.equal(advertisement.status, 403);

    const push = await call(base, "/forge.test/repo.git/git-receive-pack", { token: proxy.token, method: "POST" });
    assert.equal(push.status, 403);
    assert.equal(upstream.seen.length, 0);
  });
});

test("allowPush opens the write path for a forge that asks for it", async () => {
  await withProxy({ spec: { allowPush: true } }, async ({ base, proxy, upstream }) => {
    const push = await call(base, "/forge.test/repo.git/git-receive-pack", { token: proxy.token, method: "POST" });
    assert.equal(push.status, 200);
    assert.equal(upstream.seen.at(-1).url, "/repo.git/git-receive-pack");
  });
});

test("dumb-HTTP fetch and unknown paths do not reach the upstream", async () => {
  await withProxy({}, async ({ base, proxy, upstream }) => {
    const dumb = await call(base, "/forge.test/repo.git/objects/info/packs", { token: proxy.token });
    assert.equal(dumb.status, 403);

    const bare = await call(base, "/forge.test/repo.git/info/refs", { token: proxy.token });
    assert.equal(bare.status, 403);
    assert.equal(upstream.seen.length, 0);
  });
});

test("only configured hosts resolve, and traversal does not escape the prefix", async () => {
  await withProxy({}, async ({ base, proxy, upstream }) => {
    const elsewhere = await call(base, "/evil.test/repo.git/info/refs?service=git-upload-pack", { token: proxy.token });
    assert.equal(elsewhere.status, 400);

    const traversal = await call(base, "/forge.test/../evil/info/refs?service=git-upload-pack", { token: proxy.token });
    assert.ok(traversal.status >= 400);
    assert.equal(upstream.seen.length, 0);
  });
});

test("a redirect to another host is refused, not relayed", async () => {
  const handler = (request, response) => {
    response.writeHead(302, { location: "https://elsewhere.test/repo.git/info/refs" });
    response.end();
  };
  await withProxy({ handler }, async ({ base, proxy }) => {
    const response = await call(base, "/forge.test/repo.git/info/refs?service=git-upload-pack", { token: proxy.token });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("location"), null);
  });
});

test("a redirect to the same forge comes back as a path on the proxy", async () => {
  // What GitLab answers to the `.git`-less URL `go` probes.
  const handler = (request, response) => {
    if (request.url.startsWith("/repo/")) {
      const upstream = `http://127.0.0.1:${request.socket.localPort}`;
      response.writeHead(301, { location: `${upstream}/repo.git/info/refs?service=git-upload-pack` });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
    response.end("refs");
  };
  await withProxy({ handler }, async ({ base, proxy }) => {
    const response = await call(base, "/forge.test/repo/info/refs?service=git-upload-pack", { token: proxy.token });
    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), "/forge.test/repo.git/info/refs?service=git-upload-pack");

    // Following it lands on the gate again, not past it.
    const followed = await call(base, response.headers.get("location"), { token: proxy.token });
    assert.equal(followed.status, 200);
  });
});

test("a redirect cannot smuggle push past the gate", async () => {
  const handler = (request, response) => {
    const upstream = `http://127.0.0.1:${request.socket.localPort}`;
    response.writeHead(301, { location: `${upstream}/repo.git/info/refs?service=git-receive-pack` });
    response.end();
  };
  await withProxy({ handler }, async ({ base, proxy, upstream }) => {
    const response = await call(base, "/forge.test/repo/info/refs?service=git-upload-pack", { token: proxy.token });
    const followed = await call(base, response.headers.get("location"), { token: proxy.token });
    assert.equal(followed.status, 403);
    assert.equal(upstream.seen.filter((entry) => entry.url.includes("receive-pack")).length, 0);
  });
});

test("the token dies with the run", async () => {
  const upstream = await startUpstream();
  const proxy = await startGitProxy({
    hosts: { "forge.test": { upstream: upstream.origin, token: REAL_TOKEN } }
  });
  const base = proxy.url.replace("host.docker.internal", "127.0.0.1");
  await proxy.close();
  await assert.rejects(() => call(base, "/forge.test/repo.git/info/refs?service=git-upload-pack", { token: proxy.token }));
  upstream.server.close();
});

test("the container's gitconfig rewrites every form a remote can take", () => {
  const proxy = {
    url: "http://host.docker.internal:41234",
    token: "pi-git-test",
    hosts: [{ host: "git.example", sshPorts: ["2222"] }]
  };
  const config = gitProxyConfig(proxy);
  assert.match(config, /insteadOf = https:\/\/git\.example\//);
  assert.match(config, /insteadOf = git@git\.example:/);
  assert.match(config, /insteadOf = ssh:\/\/git@git\.example\//);
  assert.match(config, /insteadOf = ssh:\/\/git@git\.example:2222\//);
  assert.match(config, /url "http:\/\/git:pi-git-test@host\.docker\.internal:41234\/git\.example\/"/);
  // The forge credential is the one thing that must not be in a file the
  // container can read.
  assert.ok(!config.includes(REAL_TOKEN));
});

test("a token command may answer bare, as KEY=value, or quoted", async () => {
  const upstream = await startUpstream();
  for (const [command, label] of [
    [`printf 'plain-token'`, "bare"],
    [`printf 'GITLAB_RO_TOKEN=plain-token\n'`, "kv"],
    [`printf 'GITLAB_RO_TOKEN="plain-token"\n'`, "dotenv"]
  ]) {
    const proxy = await startGitProxy({
      hosts: { "forge.test": { upstream: upstream.origin, user: "oauth2", tokenCommand: command } }
    });
    const base = proxy.url.replace("host.docker.internal", "127.0.0.1");
    await call(base, "/forge.test/repo.git/info/refs?service=git-upload-pack", { token: proxy.token });
    const decoded = Buffer.from(upstream.seen.at(-1).authorization.replace(/^Basic\s+/, ""), "base64").toString("utf8");
    assert.equal(decoded, "oauth2:plain-token", `${label} form`);
    await proxy.close();
  }
  upstream.server.close();
});

test("a token that itself contains = survives intact", async () => {
  const upstream = await startUpstream();
  const proxy = await startGitProxy({
    hosts: { "forge.test": { upstream: upstream.origin, user: "oauth2", tokenCommand: `printf 'glpat-abc=='` }
  } });
  const base = proxy.url.replace("host.docker.internal", "127.0.0.1");
  await call(base, "/forge.test/repo.git/info/refs?service=git-upload-pack", { token: proxy.token });
  const decoded = Buffer.from(upstream.seen.at(-1).authorization.replace(/^Basic\s+/, ""), "base64").toString("utf8");
  assert.equal(decoded, "oauth2:glpat-abc==");
  await proxy.close();
  upstream.server.close();
});

test("a profile narrows the host table, and false opts out", () => {
  const config = { gitProxy: { "a.test": { token: "x" }, "b.test": { token: "y" } } };
  assert.deepEqual(Object.keys(resolveGitProxyHosts(config, {})), ["a.test", "b.test"]);
  assert.deepEqual(Object.keys(resolveGitProxyHosts(config, { gitProxy: ["b.test"] })), ["b.test"]);
  assert.equal(resolveGitProxyHosts(config, { gitProxy: false }), null);
  assert.equal(resolveGitProxyHosts({}, {}), null);
});

test("the proxy holding real forge tokens stays off the network", async () => {
  // A wider bind would expose a credential-holding listener to everything that
  // can route to this host; the container does not need it to reach the proxy.
  assert.equal(PROXY_BIND_ADDRESS, "127.0.0.1");

  const upstream = await startUpstream();
  const proxy = await startGitProxy({ hosts: { "forge.test": { upstream: upstream.origin, token: REAL_TOKEN } } });
  const bound = await new Promise((resolve) => {
    const probe = http.get(`http://127.0.0.1:${new URL(proxy.url).port}/`, (response) => {
      response.resume();
      resolve(response.socket.localAddress);
    });
    probe.on("error", () => resolve(null));
  });
  assert.equal(bound, "127.0.0.1");
  await proxy.close();
  upstream.server.close();
});

test("a profile asking for a proxy is not mistaken for a running one", () => {
  assert.equal(activeGitProxy({ gitProxy: true }), null);
  assert.equal(activeGitProxy({ gitProxy: ["a.test"] }), null);
  assert.ok(activeGitProxy({ gitProxy: { token: "t", url: "http://x", hosts: [] } }));
});

test("a run with a proxy mounts its own gitconfig instead of the host's", () => {
  const sandbox = {
    mode: "docker",
    image: "pi-sandbox-go:latest",
    mounts: ["~/.gitconfig:/home/pi/.gitconfig:ro"],
    env: [],
    gitProxy: { url: "http://host.docker.internal:41234", token: "pi-git-test", hosts: [{ host: "git.example", sshPorts: [] }] }
  };
  const args = buildDockerRunArgs({ sandbox, cwd: "/tmp", piArgs: [] });
  const mounts = args.filter((arg, index) => args[index - 1] === "-v");
  const gitconfigMounts = mounts.filter((mount) => mount.endsWith("/home/pi/.gitconfig:ro"));

  assert.equal(gitconfigMounts.length, 1);
  assert.ok(!gitconfigMounts[0].startsWith(`${process.env.HOME}/.gitconfig`));
  assert.ok(args.includes("host.docker.internal:host-gateway"));
});
