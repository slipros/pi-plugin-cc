/**
 * Run: npm test — or node --test tests/git-proxy.e2e.test.mjs
 *
 * The client here is the real `git`, against a real `git http-backend`. What the
 * unit tests cannot answer is whether git actually authenticates the way the
 * proxy expects — it sends no credential until challenged — and whether a push
 * refused mid-protocol looks like a failure to git rather than a silent no-op.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

import { gitProxyConfig, startGitProxy } from "../plugins/pi/scripts/lib/git-proxy.mjs";

const REAL_TOKEN = "upstream-token";

/**
 * Never spawnSync: the forge and the proxy this git talks to are servers in
 * this same process, and a synchronous child blocks the loop that would answer
 * it — the client then waits for a reply nobody can send.
 */
function git(args, { cwd, env = {}, expectFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      if (!expectFailure && status !== 0) {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`));
        return;
      }
      resolve({ status, stdout, stderr });
    });
  });
}

async function headOf(repository) {
  return (await git(["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
}

/** A bare repository with one commit, exported over smart HTTP. */
async function seedRepository(root) {
  const work = path.join(root, "work");
  const bare = path.join(root, "repo.git");
  fs.mkdirSync(work, { recursive: true });

  await git(["init", "-q", "-b", "main", work]);
  fs.writeFileSync(path.join(work, "file.txt"), "seed\n");
  await git(["add", "file.txt"], { cwd: work });
  await git(["-c", "user.name=t", "-c", "user.email=t@test", "commit", "-qm", "seed"], { cwd: work });
  await git(["clone", "-q", "--bare", work, bare]);
  // http-backend refuses to serve a push unless the repository opts in, which
  // would make "push was refused" ambiguous: the proxy has to be the reason.
  await git(["config", "http.receivepack", "true"], { cwd: bare });
  return bare;
}

/** CGI wrapper: git ships the server, not the transport around it. */
async function startForge(projectRoot) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://forge.invalid");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: request.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REMOTE_USER: "tester",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
        HTTP_GIT_PROTOCOL: request.headers["git-protocol"] ?? ""
      }
    });
    request.pipe(child.stdin);

    const chunks = [];
    let headersSent = false;
    child.stdout.on("data", (chunk) => {
      if (headersSent) {
        response.write(chunk);
        return;
      }
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      const split = buffer.indexOf("\r\n\r\n");
      if (split === -1) {
        return;
      }
      const headers = {};
      let status = 200;
      for (const line of buffer.subarray(0, split).toString("utf8").split("\r\n")) {
        const separator = line.indexOf(":");
        if (separator === -1) {
          continue;
        }
        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        if (name === "status") {
          status = Number.parseInt(value, 10) || 200;
        } else {
          headers[name] = value;
        }
      }
      headersSent = true;
      response.writeHead(status, headers);
      response.write(buffer.subarray(split + 4));
    });
    child.stdout.on("end", () => response.end());
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/**
 * The container's view: a gitconfig that knows only the proxy, and a HOME that
 * holds nothing else — the same isolation the sandbox mount produces.
 */
function containerHome(root, proxy) {
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const config = gitProxyConfig(proxy).replaceAll("host.docker.internal", "127.0.0.1");
  fs.writeFileSync(path.join(home, ".gitconfig"), config);
  return { HOME: home, GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"), GIT_CONFIG_SYSTEM: "/dev/null" };
}

async function withForge(spec, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-git-proxy-e2e-"));
  const bare = await seedRepository(root);
  const forge = await startForge(root);
  const proxy = await startGitProxy({
    hosts: { "forge.test": { upstream: forge.origin, user: "oauth2", token: REAL_TOKEN, ...spec } }
  });
  try {
    return await body({ root, bare, proxy, env: containerHome(root, proxy) });
  } finally {
    await proxy.close();
    forge.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("git clones through the proxy from an ssh-style remote it cannot speak", async () => {
  await withForge({}, async ({ root, env }) => {
    const target = path.join(root, "clone");
    // The URL the agent would find in a go.mod or a remote — no proxy in sight.
    await git(["clone", "-q", "ssh://git@forge.test/repo.git", target], { env });

    assert.equal(fs.readFileSync(path.join(target, "file.txt"), "utf8"), "seed\n");
  });
});

test("push fails, and the upstream keeps its old head", async () => {
  await withForge({}, async ({ root, bare, env }) => {
    const target = path.join(root, "clone");
    await git(["clone", "-q", "https://forge.test/repo.git", target], { env });
    const before = await headOf(bare);

    fs.writeFileSync(path.join(target, "file.txt"), "agent edit\n");
    await git(["add", "file.txt"], { cwd: target, env });
    await git(["-c", "user.name=a", "-c", "user.email=a@test", "commit", "-qm", "edit"], { cwd: target, env });

    const push = await git(["push", "origin", "main"], { cwd: target, env, expectFailure: true });
    assert.notEqual(push.status, 0);
    assert.match(push.stderr, /403|refus|denied/i);
    assert.equal(await headOf(bare), before);
  });
});

test("allowPush lets the same push through", async () => {
  await withForge({ allowPush: true }, async ({ root, bare, env }) => {
    const target = path.join(root, "clone");
    await git(["clone", "-q", "https://forge.test/repo.git", target], { env });
    const before = await headOf(bare);

    fs.writeFileSync(path.join(target, "file.txt"), "agent edit\n");
    await git(["add", "file.txt"], { cwd: target, env });
    await git(["-c", "user.name=a", "-c", "user.email=a@test", "commit", "-qm", "edit"], { cwd: target, env });
    await git(["push", "-q", "origin", "main"], { cwd: target, env });

    assert.notEqual(await headOf(bare), before);
  });
});
