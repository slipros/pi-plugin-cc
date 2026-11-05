import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  attachMounts,
  missingMountSources,
  normalizeSandbox,
  sandboxPreflight
} from "../plugins/pi/scripts/lib/sandbox.mjs";

function sandboxed(mounts) {
  return attachMounts(normalizeSandbox({ mode: "docker" }, {}), mounts);
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-mount-verify-"));
}

// B85-12: `--mount <epic root>:<epic root>` on a path that does not exist on
// the host used to start a run anyway — the agent wrote its report into a
// container-only analog of the path and the host found nothing.

test("an existing host path outside the workspace mounts without complaint", () => {
  const dir = tempDir();
  try {
    assert.deepEqual(missingMountSources(sandboxed([`${dir}:${dir}`]), { cwd: "/somewhere/else" }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing host path is refused, naming the exact path docker would fake", () => {
  const missing = path.join(os.tmpdir(), "pi-mount-verify-absent", "reports");
  assert.deepEqual(missingMountSources(sandboxed([`${missing}:${missing}`]), { cwd: os.tmpdir() }), [
    { mount: `${missing}:${missing}`, hostPath: missing }
  ]);
});

test("a relative source is judged against the run root, not the process cwd", () => {
  const root = tempDir();
  try {
    fs.mkdirSync(path.join(root, "shared"));
    assert.deepEqual(missingMountSources(sandboxed(["./shared:/shared"]), { cwd: root }), []);
    assert.deepEqual(
      missingMountSources(sandboxed(["./absent:/absent"]), { cwd: root }).map((entry) => entry.hostPath),
      [path.join(root, "absent")]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a home-relative source expands before the check", () => {
  const missing = path.join(os.homedir(), "pi-mount-verify-absent-home");
  assert.deepEqual(missingMountSources(sandboxed([`~/pi-mount-verify-absent-home:/data`])).map((e) => e.hostPath), [
    missing
  ]);
});

test("named volumes have no host side and are never flagged", () => {
  assert.deepEqual(missingMountSources(sandboxed(["cache-vol:/var/cache"])), []);
});

test("a non-sandboxed run has nothing to verify", () => {
  assert.deepEqual(missingMountSources(normalizeSandbox("none", {}), { cwd: os.tmpdir() }), []);
});

test("preflight fails before a job record exists, with a fixable message", () => {
  const missing = path.join(os.tmpdir(), "pi-mount-verify-preflight-absent");
  const preflight = sandboxPreflight(sandboxed([`${missing}:${missing}`, "/tmp:/tmp:ro"]), { cwd: os.tmpdir() });
  assert.equal(preflight.ok, false);
  const mountErrors = preflight.errors.filter((line) => line.startsWith("Mount "));
  assert.equal(mountErrors.length, 1, preflight.errors.join("\n"));
  assert.match(mountErrors[0], new RegExp(missing));
  assert.match(mountErrors[0], /does not exist/);
  assert.match(mountErrors[0], /container-only analog/);
});

test("the run path wires the run root into preflight, so relative mounts resolve there", async () => {
  const { buildRunSettings } = await import("../plugins/pi/scripts/pi-companion.mjs");

  const runRoot = tempDir();
  const workspaceRoot = tempDir();
  fs.mkdirSync(path.join(runRoot, "exists"));
  try {
    // A missing run root must be a refusal, not a throw-shaped success: the
    // wiring of `cwd` here is what keeps `./absent` from being judged against
    // the process cwd instead of the tree the agent actually runs in.
    assert.throws(
      () =>
        buildRunSettings({
          command: "delegate",
          flags: { sandbox: "docker", mount: ["./exists:/x", "./absent:/y"] },
          workspaceRoot,
          runRoot,
          config: {}
        }),
      (error) => {
        const lines = String(error.message).split("\n").filter((line) => line.startsWith("- Mount "));
        if (lines.length !== 1) return false;
        return lines[0].includes(path.join(runRoot, "absent")) && !lines[0].includes("exists");
      },
      `expected exactly one mount error, for ./absent under ${runRoot}`
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
