import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The sweep works on the real temp directory, so the test moves TMPDIR first.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-credential-sweep-"));
process.env.TMPDIR = tmp;

const { cleanupCredentialSlices } = await import("../plugins/pi/scripts/lib/sandbox.mjs");

const dir = path.join(os.tmpdir(), "pi-companion", "auth");
const HOUR_AGO = Date.now() - 2 * 3_600_000;

/** A per-run file as the companion names it: `<what>.<pid>.json`. */
function slice(name, { aged = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, "{}");
  if (aged) {
    fs.utimesSync(file, HOUR_AGO / 1000, HOUR_AGO / 1000);
  }
  return file;
}

/** A pid that is certainly not running: allocate one and let it exit. */
function deadPid() {
  // 2^22 is above the default pid_max on both macOS and Linux, so nothing owns it.
  return 4_194_303;
}

test("a live run's credentials survive a sweep, however old the file is", () => {
  // The defect: an hour of age was read as abandonment, so any later command
  // deleted the auth.json a longer run still had mounted, and the run died on
  // its next read with ENOENT.
  const mine = slice(`auth-run.${process.pid}.json`, { aged: true });
  const other = slice(`auth-run.${process.ppid}.json`, { aged: true });
  cleanupCredentialSlices();
  assert.equal(fs.existsSync(mine), false, "this process cleans up after itself");
  assert.equal(fs.existsSync(other), true, "a running owner keeps its credentials");
  fs.rmSync(other, { force: true });
});

test("a dead owner's file goes immediately, without waiting out the hour", () => {
  const orphan = slice(`auth-run.${deadPid()}.json`);
  cleanupCredentialSlices();
  assert.equal(fs.existsSync(orphan), false);
});

test("a file with no pid in its name still falls back to age", () => {
  const fresh = slice("auth-run.json");
  const stale = slice("auth-run.stale.json", { aged: true });
  cleanupCredentialSlices();
  assert.equal(fs.existsSync(fresh), true, "too young to be nobody's");
  assert.equal(fs.existsSync(stale), false);
});
