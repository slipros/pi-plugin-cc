import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const { resolveCommitIdentity } = await import("../plugins/pi/scripts/lib/git.mjs");

function tree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-identity-"));
}

function writeIdentity(directory, { name, email }) {
  const lines = ["[user]"];
  if (name) lines.push(`\tname = ${name}`);
  if (email) lines.push(`\temail = ${email}`);
  fs.writeFileSync(path.join(directory, ".gitconfig"), `${lines.join("\n")}\n`);
}

test("outside a repository the identity comes from the .gitconfig above the run root", () => {
  // The case that produced commits a corporate forge refused: an epic workspace
  // holding several checkouts is not a repository itself, so no
  // `includeIf "gitdir:…"` rule fires and git answers with the personal address
  // from the global file — a valid-looking answer, wrong for the tree.
  const root = tree();
  const workspace = path.join(root, "epic");
  fs.mkdirSync(workspace);
  writeIdentity(root, { name: "Project Owner", email: "owner@corp.example" });

  assert.deepEqual(resolveCommitIdentity(workspace), {
    name: "Project Owner",
    email: "owner@corp.example"
  });

  fs.rmSync(root, { recursive: true, force: true });
});

test("the nearest .gitconfig wins, the way the includeIf chain is written", () => {
  const root = tree();
  const inner = path.join(root, "client", "epic");
  fs.mkdirSync(inner, { recursive: true });
  writeIdentity(root, { name: "General", email: "general@corp.example" });
  writeIdentity(path.dirname(inner), { name: "Client", email: "client@corp.example" });

  assert.deepEqual(resolveCommitIdentity(inner), { name: "Client", email: "client@corp.example" });

  fs.rmSync(root, { recursive: true, force: true });
});

test("half an identity is not an answer, so the search goes on", () => {
  // Git refuses to commit with a name and no address; taking the near file
  // anyway would produce a run that dies at its first commit.
  const root = tree();
  const inner = path.join(root, "epic");
  fs.mkdirSync(inner);
  writeIdentity(root, { name: "Complete", email: "complete@corp.example" });
  writeIdentity(inner, { email: "half@corp.example" });

  assert.deepEqual(resolveCommitIdentity(inner), { name: "Complete", email: "complete@corp.example" });

  fs.rmSync(root, { recursive: true, force: true });
});

test("inside a repository git's own resolution still decides", () => {
  const root = tree();
  const repository = path.join(root, "service");
  fs.mkdirSync(repository);
  // The tree above says one thing, the repository another: a repository is
  // where git resolves the whole chain itself, and its answer is the one to use.
  writeIdentity(root, { name: "Tree", email: "tree@corp.example" });
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "Repository"],
    ["config", "user.email", "repository@corp.example"]
  ]) {
    spawnSync("git", args, { cwd: repository });
  }

  assert.deepEqual(resolveCommitIdentity(repository), {
    name: "Repository",
    email: "repository@corp.example"
  });

  fs.rmSync(root, { recursive: true, force: true });
});
