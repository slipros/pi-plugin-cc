import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("parallel writers keep every job, and never delete each other's results", async () => {
  const { spawn } = await import("node:child_process");
  const state = await import("../plugins/pi/scripts/lib/state.mjs");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-state-race-"));
  const jobsDir = path.dirname(state.resolveJobFile(root, "probe"));

  // Existing history: the thing a concurrent writer used to wipe out.
  for (let index = 0; index < 12; index += 1) {
    const id = `old-${index}`;
    state.writeJobFile(root, id, { id, status: "completed", title: id });
    state.upsertJob(root, { id, status: "completed" });
  }

  // Four processes updating their own job as fast as a progress reporter would.
  const writer = `
    import { upsertJob, writeJobFile } from "${path.resolve("plugins/pi/scripts/lib/state.mjs")}";
    const [root, id] = [process.argv[1], process.argv[2]];
    writeJobFile(root, id, { id, status: "running", title: id });
    for (let i = 0; i < 60; i += 1) upsertJob(root, { id, phase: "step-" + i, status: "running" });
  `;
  const children = ["a", "b", "c", "d"].map((name) =>
    spawn(process.execPath, ["--input-type=module", "-e", writer, root, `new-${name}`], { stdio: "ignore" })
  );
  await Promise.all(children.map((child) => new Promise((resolve) => child.on("close", resolve))));

  try {
    const jobs = state.listJobs(root);
    assert.equal(jobs.filter((job) => job.id.startsWith("old-")).length, 12, "history survives concurrent writers");
    for (const name of ["a", "b", "c", "d"]) {
      assert.ok(jobs.some((job) => job.id === `new-${name}`), `writer ${name} is not lost`);
    }
    assert.equal(fs.readdirSync(jobsDir).filter((file) => file.endsWith(".json")).length, 16);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.dirname(jobsDir), { recursive: true, force: true });
  }
});
