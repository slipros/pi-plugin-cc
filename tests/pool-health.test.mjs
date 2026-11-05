import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyPoolFailure,
  clearAllPools,
  clearPool,
  deadPools,
  partitionByPoolHealth,
  poolHealthPath,
  poolHoldMs,
  readPoolHealth,
  recordPoolFailure
} from "../plugins/pi/scripts/lib/pool-health.mjs";

/** Isolation: the liveness file lives under the plugin data dir, never the real one. */
function withIsolatedState(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-health-"));
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previous === undefined) {
        delete process.env.CLAUDE_PLUGIN_DATA;
      } else {
        process.env.CLAUDE_PLUGIN_DATA = previous;
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
}

const COOLDOWNS = { balanceMs: 3_600_000, quotaMs: 86_400_000, networkMs: 30_000 };
const variant = (pool) => ({ id: `m-${pool}`, pool, sandbox: {} });

test("failures of the pool are classified; failures of the task are not", async () => {
  // Balance: the case that started it — 402 with the provider's own wording.
  assert.equal(classifyPoolFailure('402 {"message":"Insufficient Balance"}').class, "balance");
  assert.equal(classifyPoolFailure("Payment required: balance too low").class, "balance");
  // Quota: status code, the provider's code 1310, the weekly-limit wording.
  assert.equal(classifyPoolFailure("429 Too Many Requests").class, "quota");
  assert.equal(classifyPoolFailure('{"error":{"code":"1310"}}').class, "quota");
  // The same code arrives numeric just as often.
  assert.equal(classifyPoolFailure('{"error":{"code":1310}}').class, "quota");
  assert.equal(classifyPoolFailure('{"error":{"code":13100}}'), null, "a longer code is a different code");
  assert.equal(classifyPoolFailure("Weekly usage limit reached for this account").class, "quota");
  // Network: the endpoint is not there at all.
  for (const text of [
    "fetch failed: ECONNREFUSED 127.0.0.1:8000",
    "request to https://api failed, reason: connect ETIMEDOUT",
    "getaddrinfo EAI_AGAIN api.example.com",
    "Error: socket hang up"
  ]) {
    assert.equal(classifyPoolFailure(text).class, "network", text);
  }
  // Task-level failures must never touch pool state: one mistyped command
  // would otherwise evict a live pool.
  assert.equal(classifyPoolFailure('400 {"error":"unknown model"}'), null);
  assert.equal(classifyPoolFailure("Failed to parse response"), null);
  assert.equal(classifyPoolFailure(""), null);
  assert.equal(classifyPoolFailure(null), null);
});

test("hold lengths follow the class: named quota window, otherwise the defaults", async () => {
  // Balance: an hour — money can arrive at any moment.
  assert.equal(poolHoldMs({ failureClass: "balance", reason: "402", failures: 1, ...COOLDOWNS }), 3_600_000);
  // Quota: the provider named its window, so that window wins over the day.
  assert.equal(
    poolHoldMs({ failureClass: "quota", reason: "retry after 45 minutes", failures: 1, ...COOLDOWNS }),
    45 * 60_000
  );
  // The header form names its window in bare seconds — still the provider's word.
  assert.equal(poolHoldMs({ failureClass: "quota", reason: "Retry-After: 3600", failures: 1, ...COOLDOWNS }), 3_600_000);
  assert.equal(poolHoldMs({ failureClass: "quota", reason: "retry-after: 90", failures: 1, ...COOLDOWNS }), 90_000);
  assert.equal(poolHoldMs({ failureClass: "quota", reason: "429 quota exceeded", failures: 1, ...COOLDOWNS }), 86_400_000);
  // Network: 30s → 60s → 120s → 300s on consecutive failures, capped.
  assert.equal(poolHoldMs({ failureClass: "network", reason: "ECONNREFUSED", failures: 1, ...COOLDOWNS }), 30_000);
  assert.equal(poolHoldMs({ failureClass: "network", reason: "ECONNREFUSED", failures: 2, ...COOLDOWNS }), 60_000);
  assert.equal(poolHoldMs({ failureClass: "network", reason: "ECONNREFUSED", failures: 3, ...COOLDOWNS }), 120_000);
  assert.equal(poolHoldMs({ failureClass: "network", reason: "ECONNREFUSED", failures: 4, ...COOLDOWNS }), 300_000);
  assert.equal(poolHoldMs({ failureClass: "network", reason: "ECONNREFUSED", failures: 9, ...COOLDOWNS }), 300_000);
});

test("a recorded failure puts the pool out of the choice until its deadline, then back in", async () => {
  await withIsolatedState(async () => {
    const now = Date.now();
    const record = recordPoolFailure("deepseek", "balance", '402 Insufficient Balance', { now, ...COOLDOWNS });
    assert.equal(record.class, "balance");
    assert.ok(poolHealthPath().endsWith("pool-health.json"));

    assert.deepEqual(Object.keys(deadPools({ now: now + 1000 })), ["deepseek"]);
    assert.deepEqual(deadPools({ now: now + 3_600_001 }), {}, "past the deadline the pool participates again");
    // Written to disk next to the plugin's other records, so the next process sees it.
    assert.deepEqual(Object.keys(readPoolHealth()), ["deepseek"]);

    // A success erases the record entirely — before the deadline, too.
    assert.equal(clearPool("deepseek"), true);
    assert.deepEqual(deadPools(), {});
    assert.deepEqual(readPoolHealth(), {});
  });
});

test("simultaneous failures on different pools all survive the write", async () => {
  const { execFile: execFileCb } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = promisify(execFileCb);
  const moduleUrl = new URL("../plugins/pi/scripts/lib/pool-health.mjs", import.meta.url).pathname;

  await withIsolatedState(async () => {
    // One process per pool, 40 records each: without the lock each writer
    // writes back only the pool it read, and the slower one drops the rest —
    // the reviewer's reproduction of one outage fanning out to the fleet.
    const pools = ["alpha", "beta", "gamma"];
    const ROUNDS = 40;
    await Promise.all(
      pools.map((pool) =>
        execFile(
          process.execPath,
          [
            "-e",
            `
import { recordPoolFailure } from ${JSON.stringify(moduleUrl)};
for (let i = 0; i < ${ROUNDS}; i++) {
  recordPoolFailure(${JSON.stringify(pool)}, "network", "ECONNREFUSED", ${JSON.stringify(COOLDOWNS)});
}
`
          ],
          { env: { ...process.env, CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA } }
        )
      )
    );

    // Every death is still there: the file parses and carries each pool with
    // its full failure count — none of the writes was silently dropped.
    const state = JSON.parse(fs.readFileSync(poolHealthPath(), "utf8"));
    for (const pool of pools) {
      assert.equal(state.pools[pool]?.failures, ROUNDS, `pool ${pool} kept every record`);
    }
  });
});

test("consecutive failures accumulate the network hold; a cleared record starts over", async () => {
  await withIsolatedState(async () => {
    const now = Date.now();
    recordPoolFailure("vllm", "network", "ECONNREFUSED", { now, ...COOLDOWNS });
    const second = recordPoolFailure("vllm", "network", "ECONNREFUSED", { now, ...COOLDOWNS });
    assert.equal(second.failures, 2);
    assert.ok(second.retryAtMs - now >= 60_000, "the hold grew with the second failure");

    clearPool("vllm");
    const fresh = recordPoolFailure("vllm", "network", "ECONNREFUSED", { now, ...COOLDOWNS });
    assert.equal(fresh.failures, 1, "the short hold again, not the accumulated one");
  });
});

test("reset works per pool and wholesale", async () => {
  await withIsolatedState(async () => {
    const now = Date.now();
    recordPoolFailure("a", "quota", "429", { now, ...COOLDOWNS });
    recordPoolFailure("b", "network", "ETIMEDOUT", { now, ...COOLDOWNS });
    assert.equal(clearPool("a"), true);
    assert.equal(clearPool("a"), false, "resetting a live pool says so instead of pretending");
    assert.deepEqual(Object.keys(readPoolHealth()), ["b"]);
    assert.equal(clearAllPools(), 1);
    assert.deepEqual(readPoolHealth(), {});
  });
});

test("the choice drops a dead pool outright and lists every pool when all are dead", async () => {
  const { selectLiveVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  await withIsolatedState(async () => {
    const now = Date.now();
    // Two pools dead at different deadlines, one alive.
    recordPoolFailure("far", "balance", "402", { now: now - 1000, ...COOLDOWNS });
    const far = recordPoolFailure("far", "balance", "402", { now, ...COOLDOWNS });
    recordPoolFailure("near", "network", "ECONNREFUSED", { now, ...COOLDOWNS });

    const variants = [variant("far"), variant("near"), variant("live")];
    const picked = selectLiveVariants(variants, { now });
    assert.deepEqual(picked.variants.map((entry) => entry.pool), ["live"], "the dead pool is skipped before any slot wait");
    assert.match(picked.message, /dead/);
    assert.match(picked.message, /far/);
    assert.match(picked.message, /near/);

    // Every candidate dead: nothing is silently refused — the line names each
    // pool, its class and its deadline, and the nearest deadline goes first.
    const allDead = selectLiveVariants([variant("far"), variant("near")], { now });
    assert.deepEqual(allDead.variants.map((entry) => entry.pool), ["near", "far"]);
    assert.match(allDead.message, /nearest/);
    assert.ok(allDead.message.includes(new Date(far.retryAtMs).toISOString().slice(0, 10)));
  });
});

test("partitioning reads the record, not the variant list shape", async () => {
  await withIsolatedState(async () => {
    const now = Date.now();
    recordPoolFailure("dead", "quota", "429", { now, ...COOLDOWNS });
    const { alive, dead, deadByPool } = partitionByPoolHealth([variant("dead"), variant("ok")], { now });
    assert.deepEqual(alive.map((entry) => entry.pool), ["ok"]);
    assert.deepEqual(dead.map((entry) => entry.pool), ["dead"]);
    assert.equal(deadByPool.dead.class, "quota");
  });
});

test("an expired record still prints in the state, but no longer skips anything", async () => {
  await withIsolatedState(async () => {
    const now = Date.now() - 4 * COOLDOWNS.networkMs;
    const record = recordPoolFailure("x", "network", "ETIMEDOUT", { now, ...COOLDOWNS });
    assert.ok(record.retryAtMs < Date.now(), "test needs an already-expired hold");
    assert.deepEqual(deadPools(), {});
    assert.equal(Object.keys(readPoolHealth()).length, 1);
  });
});

test("a state file that cannot be read means nothing is dead, never a refusal", async () => {
  await withIsolatedState(async () => {
    fs.mkdirSync(path.dirname(poolHealthPath()), { recursive: true });
    fs.writeFileSync(poolHealthPath(), "{ not json");
    assert.deepEqual(deadPools(), {});
    assert.deepEqual(partitionByPoolHealth([variant("p")]).alive.length, 1);
  });
});

/** A config in the owner's form, two pools of one model each. */
function twoPoolConfig({ pid }) {
  return {
    concurrencyPools: [
      {
        pool: `alpha-${pid}`,
        limit: 1,
        models: [{ id: `fast-${pid}`, provider: "prov", name: "fast-model" }]
      },
      {
        pool: `beta-${pid}`,
        limit: 1,
        models: [{ id: `slow-${pid}`, provider: "prov2", name: "slow-model" }]
      }
    ],
    sandboxProfiles: { base: { image: "busybox:latest" } },
    presets: [{ id: "role", models: [`fast-${pid}`, `slow-${pid}`], sandboxService: "base" }]
  };
}

test("dispatch skips a dead pool without paying poolWaitMs for the skip", async () => {
  await withIsolatedState(async () => {
    const { buildVariants, selectLiveVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
    const { awaitSandboxSlot, awaitVariantSlot } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
    const { normalizeConfigLayer } = await import("../plugins/pi/scripts/lib/config.mjs");
    const pid = `${process.pid}-${Date.now()}`;
    const config = normalizeConfigLayer(twoPoolConfig({ pid }));
    const variants = buildVariants(config.presets.role, config).variants;
    const deadPool = variants[0].pool;
    const livePool = variants[1].pool;

    // The dead pool's slot is held the whole time: if liveness were checked
    // after (or instead of) the slot race, the run would queue for poolWaitMs.
    const held = await awaitSandboxSlot(variants[0].sandbox, { timeoutMs: 1000, pollMs: 10 });
    try {
      recordPoolFailure(deadPool, "balance", "402 Insufficient Balance", { ...COOLDOWNS });
      const live = selectLiveVariants(variants);
      const startedAt = Date.now();
      const picked = await awaitVariantSlot(live.variants, { poolWaitMs: 5000, timeoutMs: 5000 });
      assert.ok(Date.now() - startedAt < 2000, `the skip must not cost the ${5000}ms threshold`);
      assert.equal(picked.pool, livePool, "the live pool runs the task");
      picked.release();
    } finally {
      held.release();
    }
  });
});

test("settlePoolHealth: success erases, pool death records, task error leaves state alone", async () => {
  const { settlePoolHealth } = await import("../plugins/pi/scripts/pi-companion.mjs");
  await withIsolatedState(async () => {
    const settings = (pool) => ({
      sandbox: { poolName: pool },
      poolCooldowns: COOLDOWNS
    });

    // A dead pool that then runs successfully is fully forgiven.
    recordPoolFailure("deepseek", "balance", "402 Insufficient Balance", { ...COOLDOWNS });
    assert.deepEqual(deadPools().deepseek !== undefined, true);
    settlePoolHealth(settings("deepseek"), { exitStatus: 0 }, null);
    assert.deepEqual(deadPools(), {}, "the record is erased entirely, not just marked");

    // A provider-side death records the pool with its class and deadline.
    settlePoolHealth(settings("deepseek"), { exitStatus: 1, errors: ['402 {"message":"Insufficient Balance"}'] }, null);
    assert.equal(deadPools().deepseek.class, "balance");

    // A thrown engine error can carry the refusal too.
    settlePoolHealth(settings("vllm"), null, new Error("connect ECONNREFUSED 127.0.0.1:8000"));
    assert.equal(deadPools().vllm.class, "network");

    // A failure of the task or the brief changes nothing.
    settlePoolHealth(settings("zai"), { exitStatus: 1, errors: ['400 {"error":"unknown model"}'] }, null);
    assert.equal(deadPools().zai, undefined, "a 400 must not evict a live pool");

    // The engines append the process stderr as one trailing element; a 429
    // seen there is chatter of the local run, not the provider's verdict —
    // it must not cost a live pool a day. The provider channel still does.
    const stderrTail = "node:internal/process: 429 while printing the report\nfetch failed";
    settlePoolHealth(
      settings("kimi"),
      { exitStatus: 1, errors: ['400 {"error":"bad request"}', stderrTail], stderr: stderrTail },
      null
    );
    assert.equal(deadPools().kimi, undefined, "a 429 inside the stderr tail is not the provider speaking");
    settlePoolHealth(settings("deepseek"), { exitStatus: 1, errors: ["429 Too Many Requests"] }, null);
    assert.equal(deadPools().deepseek.class, "quota", "a real provider 429 still evicts");

    // No pool in play: nothing read, nothing written.
    const before = JSON.stringify(readPoolHealth());
    settlePoolHealth({ sandbox: { poolName: "ghost" } }, { exitStatus: 1, errors: ["402"] }, null);
    assert.equal(JSON.stringify(readPoolHealth()), before, "cooldowns unset means the run is not pool-shaped");
  });
});

test("a preset of the old shape ignores pool liveness state entirely", async () => {
  await withIsolatedState(async () => {
    const { normalizeConfigLayer } = await import("../plugins/pi/scripts/lib/config.mjs");
    const { selectLiveVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
    const config = normalizeConfigLayer(twoPoolConfig({ pid: `old-${process.pid}` }));
    recordPoolFailure(`alpha-old-${process.pid}`, "balance", "402", { ...COOLDOWNS });
    // The old shape resolves to no variants at all: selectLiveVariants never
    // runs, so the records on disk cannot change where the run goes.
    const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
    const plan = buildVariants({ sandbox: "base" }, config);
    assert.deepEqual(plan.variants, []);
    assert.equal(selectLiveVariants([]).variants.length, 0);
    // Behavior, not importability: the resolver still resolves — and refuses
    // what it must refuse.
    const { resolveRunSettings } = await import("../plugins/pi/scripts/lib/config.mjs");
    assert.throws(() => resolveRunSettings({ presets: {} }, "run", { preset: "nope" }), /Unknown preset/);
  });
});

test("the three cooldown fields merge field by field through the config layers", async () => {
  const { BUILT_IN_CONFIG, mergeConfigLayer } = await import("../plugins/pi/scripts/lib/config.mjs");
  assert.equal(BUILT_IN_CONFIG.poolCooldownBalanceMs, 3_600_000);
  assert.equal(BUILT_IN_CONFIG.poolCooldownQuotaMs, 86_400_000);
  assert.equal(BUILT_IN_CONFIG.poolCooldownNetworkMs, 30_000);
  const merged = mergeConfigLayer(BUILT_IN_CONFIG, { poolCooldownNetworkMs: 5_000 });
  assert.equal(merged.poolCooldownNetworkMs, 5_000, "one field retuned, the others kept");
  assert.equal(merged.poolCooldownBalanceMs, 3_600_000);
});

test("the pools command tells a torn file apart from an empty one", async () => {
  const { execFile: execFileCb } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = promisify(execFileCb);
  const script = new URL("../plugins/pi/scripts/pi-companion.mjs", import.meta.url).pathname;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pools-torn-"));
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    fs.mkdirSync(path.dirname(poolHealthPath()), { recursive: true });
    fs.writeFileSync(poolHealthPath(), "{ half a record");
    const listed = await execFile(process.execPath, [script, "pools"]);
    assert.match(listed.stdout, /cannot be parsed/, "damage is shown, not papered over");
    const asJson = JSON.parse((await execFile(process.execPath, [script, "pools", "--json"])).stdout);
    assert.equal(asJson.corrupted, true);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the pools command prints state and resets it by name and wholesale", async () => {
  const { execFile: execFileCb } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = promisify(execFileCb);
  const script = new URL("../plugins/pi/scripts/pi-companion.mjs", import.meta.url).pathname;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pools-cli-"));
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    recordPoolFailure("deepseek", "balance", "402 Insufficient Balance", { ...COOLDOWNS });
    recordPoolFailure("vllm", "network", "ECONNREFUSED", { ...COOLDOWNS });

    const listed = await execFile(process.execPath, [script, "pools"]);
    assert.match(listed.stdout, /`deepseek` — balance, until /);
    assert.match(listed.stdout, /Insufficient Balance/);
    assert.match(listed.stdout, /`vllm` — network/);
    const asJson = JSON.parse((await execFile(process.execPath, [script, "pools", "--json"])).stdout);
    assert.equal(asJson.pools.deepseek.class, "balance");

    await execFile(process.execPath, [script, "pools", "--reset", "deepseek"]);
    assert.deepEqual(Object.keys(readPoolHealth()), ["vllm"]);
    await execFile(process.execPath, [script, "pools", "--reset-all"]);
    assert.deepEqual(readPoolHealth(), {});
    await assert.rejects(
      () => execFile(process.execPath, [script, "pools", "--reset", "ghost"]),
      /nothing to reset/,
      "resetting a pool with no record says so instead of pretending"
    );
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
