import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeConfigLayer } from "../plugins/pi/scripts/lib/config.mjs";

const UNIQUE = `${process.pid}-${Date.now()}`;

/** A config in the owner's form: three arrays, models by global id. */
function ownerFormConfig({ limit = 1, priority = null, aliases = null } = {}) {
  return {
    concurrencyPools: [
      {
        pool: `alpha-${UNIQUE}`,
        limit,
        ...(priority === null ? {} : { priority }),
        ...(aliases ? { aliases } : {}),
        models: [
          { id: `fast-${UNIQUE}`, provider: "prov", name: "fast-model" },
          { id: `smart-${UNIQUE}`, provider: "prov", name: "smart-model", thinking: "high" }
        ]
      },
      {
        pool: `beta-${UNIQUE}`,
        limit,
        ...(priority === null ? {} : { priority }),
        models: [{ id: `other-${UNIQUE}`, provider: "prov2", name: "other-model" }]
      }
    ],
    sandboxServices: [
      { id: "base", image: "busybox:latest", env: ["PATH=/toolchain"], mounts: ["/srv/base:/base:ro"], args: ["--cpus", "6"] },
      {
        id: "agent",
        extend: "base",
        image: "busybox:latest",
        env: ["EXTRA=1"],
        mounts: ["/srv/extra:/extra:ro"],
        args: ["--security-opt", "no-new-privileges"]
      }
    ],
    presets: [
      {
        id: "role",
        models: [`fast-${UNIQUE}`, `other-${UNIQUE}`],
        sandboxService: "agent"
      }
    ]
  };
}

function variantByPool(variants, poolName) {
  return variants.find((variant) => variant.pool === poolName);
}

function variantById(variants, id) {
  return variants.find((variant) => variant.id === id);
}

// Дословный пример владельца (спека B-52, раздел «ЦЕЛЕВАЯ ФОРМА»); содержимое
// монтирований/env сокращено до маркеров, как в спеке, — важна структура.
function ownerExampleLiteral() {
  return {
    sandboxServices: [
      {
        id: "sandbox-base",
        image: "pi-sandbox-agent:latest",
        dockerfile: "agent",
        mounts: ["<14 монтирований базы: тулчейн, кэши volume, хуки, скилл vision>"],
        env: ["<PATH, GOPROXY, GOPRIVATE, GOFLAGS, лимиты потоков BLAS — 12 строк>"],
        extensions: ["/pi-agent/host-extensions/hooks/index.ts", "<lsp-адаптер>"],
        args: ["--cpus", "6"],
        skills: ["/pi-skills/vision"]
      },
      {
        id: "sandbox-agent",
        extend: "sandbox-base",
        image: "pi-sandbox-agent:latest",
        args: [
          "--security-opt",
          "seccomp=@sandbox/dind-seccomp.json",
          "--security-opt",
          "systempaths=unconfined",
          "--device",
          "/dev/net/tun",
          "--add-host",
          "host.docker.internal:host-gateway"
        ],
        env: [
          "PI_DIND=1",
          "DOCKERD_ROOTLESS_ROOTLESSKIT_FLAGS=--pidns",
          "TESTCONTAINERS_RYUK_DISABLED=true",
          "TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1",
          "PI_REGISTRY_MIRROR=http://host.docker.internal:5000"
        ],
        mounts: ["pi-dind-agent-images:/home/pi/.local/share/docker:isolate"]
      }
    ],
    concurrencyPools: [
      {
        pool: "zai",
        limit: 5,
        priority: 10,
        models: [
          { id: "zai-glm-5.3", provider: "zai-coding-cn", name: "glm-5.3" },
          { id: "zai-glm-5.3-flash", provider: "zai-coding-cn", name: "glm-5.3-flash" }
        ]
      },
      {
        pool: "vllm",
        limit: 1,
        priority: 10,
        models: [
          {
            id: "vllm-Qwen3.8-27B",
            provider: "vllm",
            name: "Qwen3.8-27B",
            samplingParams: { temperature: 1, max_tokens: 120000 }
          },
          {
            id: "vllm-dev-Qwen3.8-27B",
            provider: "vllm",
            name: "Qwen3.8-27B",
            samplingParams: { temperature: 0.8, max_tokens: 120000 }
          }
        ]
      },
      {
        pool: "deepseek",
        limit: 5,
        priority: 10,
        models: [
          { id: "deepseek-deepseek-v4-pro", provider: "deepseek", name: "deepseek-v4-flash-pro" },
          { id: "deepseek-deepseek-v4-flash", provider: "deepseek", name: "deepseek-v4-flash" }
        ]
      }
    ],
    presets: [
      {
        id: "go-developer",
        models: ["zai-glm-5.3-flash", "deepseek-deepseek-v4-flash", "vllm-dev-Qwen3.8-27B"],
        sandboxService: "sandbox-agent"
      }
    ]
  };
}

test("the owner's example reads verbatim: three arrays become a preset with models and a service", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");

  const config = normalizeConfigLayer(ownerExampleLiteral());
  assert.deepEqual(Object.keys(config.concurrencyPools), ["zai", "vllm", "deepseek"], "pool order is kept");
  const service = config.sandboxProfiles["sandbox-agent"];
  assert.equal(service.profile, "sandbox-base", "extend became the profile link");
  assert.ok(service.env.includes("PI_DIND=1") && service.mounts[0].includes("dind"), "the child's own fields stay");

  const { variants } = buildVariants(config.presets["go-developer"], config);
  assert.deepEqual(
    variants.map((variant) => variant.id),
    ["zai-glm-5.3-flash", "deepseek-deepseek-v4-flash", "vllm-dev-Qwen3.8-27B"],
    "the preset's listing order is the choice order when priorities tie"
  );
  const zai = variants[0];
  assert.equal(zai.model, "zai-coding-cn/glm-5.3-flash");
  assert.equal(zai.pool, "zai");
  assert.equal(zai.sandbox.poolName, "zai", "slots come from the pool of the model");
  assert.equal(zai.sandbox.maxConcurrent, 5);
  assert.equal(zai.sandbox.profileName, "sandbox-agent", "one sandbox for the role, named by the preset");

  // Two ids may share one name and differ only in samplingParams.
  const prod = config.concurrencyPools.vllm.models["vllm-Qwen3.8-27B"];
  const dev = config.concurrencyPools.vllm.models["vllm-dev-Qwen3.8-27B"];
  assert.equal(prod.name, dev.name);
  assert.notDeepEqual(prod.samplingParams, dev.samplingParams);
});

test("duplicates and removed-form fields are refused by name", async () => {

  const duplicate = ownerExampleLiteral();
  duplicate.concurrencyPools.push({ pool: "zai", limit: 2, models: [] });
  assert.throws(() => normalizeConfigLayer(duplicate), /Duplicate pool "zai".*concurrencyPools/);

  const dupeService = ownerExampleLiteral();
  dupeService.sandboxServices.push({ id: "sandbox-base", image: "x" });
  assert.throws(() => normalizeConfigLayer(dupeService), /Duplicate id "sandbox-base"/);

  const dupeModel = ownerFormConfig();
  dupeModel.concurrencyPools[1].models.push({ id: `fast-${UNIQUE}`, provider: "prov2", name: "x" });
  // The cross-pool duplicate is caught when the registry is built: within one
  // layer the ids are unique per pool, uniqueness is global.
  const { modelRegistry } = await import("../plugins/pi/scripts/pi-companion.mjs");
  assert.throws(
    () => modelRegistry(normalizeConfigLayer(dupeModel)),
    new RegExp(`Model id "fast-${UNIQUE}" is defined in both pool.*globally unique`)
  );

  const dupeInPool = ownerFormConfig();
  dupeInPool.concurrencyPools[0].models.push({ id: `fast-${UNIQUE}`, provider: "prov", name: "fast-model" });
  assert.throws(() => normalizeConfigLayer(dupeInPool), new RegExp(`Duplicate model id "fast-${UNIQUE}"`));

  const incomplete = ownerFormConfig();
  delete incomplete.concurrencyPools[0].models[0].provider;
  assert.throws(() => normalizeConfigLayer(incomplete), /needs "provider" and "name"/);

  assert.throws(
    () => normalizeConfigLayer({ presets: [{ id: "old", pools: ["zai:fast"] }] }),
    /removed "pools" field.*"models"/,
    "the cancelled pools form does not come back through a second door"
  );
  assert.throws(
    () => normalizeConfigLayer({ presets: [{ id: "old", requires: ["dind"] }] }),
    /removed "requires" field/
  );
  assert.throws(
    () => normalizeConfigLayer({ concurrencyPools: [{ pool: "zai", limit: 1, default: "fast", models: [] }] }),
    /removed "default" field/
  );
  assert.throws(
    () => normalizeConfigLayer({ concurrencyPools: [{ pool: "zai", limit: 1, sandbox: "agent", models: [] }] }),
    /removed "sandbox" field/
  );
  assert.throws(
    () => normalizeConfigLayer({ concurrencyPools: [{ pool: "zai", limit: 1, models: { fast: {} } }] }),
    /Named variant maps are gone/
  );
});

test("extend folds the base's lists in; a cycle is refused with the chain", async () => {
  const { normalizeSandbox } = await import("../plugins/pi/scripts/lib/sandbox.mjs");

  const config = normalizeConfigLayer(ownerFormConfig());
  const agent = normalizeSandbox("agent", config.sandboxProfiles);
  // The base's toolchain plus the child's own extras; args are positional and
  // must survive in order, both halves of them.
  assert.ok(agent.env.includes("PATH=/toolchain") && agent.env.includes("EXTRA=1"));
  assert.ok(agent.mounts.includes("/srv/base:/base:ro") && agent.mounts.includes("/srv/extra:/extra:ro"));
  const args = agent.args.join(" ");
  assert.ok(args.includes("--cpus 6") && args.includes("--security-opt no-new-privileges"));

  const cycle = normalizeConfigLayer(ownerFormConfig());
  cycle.sandboxProfiles.a = { profile: "b" };
  cycle.sandboxProfiles.b = { profile: "a" };
  assert.throws(() => normalizeSandbox("a", cycle.sandboxProfiles), /extends itself: a → b/);
});

test("old forms keep working: maps, numeric pools; concurrencyGroup is refused, naming the replacement", async () => {
  const { normalizeConcurrencyPool, normalizeConfigLayer, refuseRemovedConcurrencyGroup } = await import(
    "../plugins/pi/scripts/lib/config.mjs"
  );
  const { normalizeSandbox } = await import("../plugins/pi/scripts/lib/sandbox.mjs");

  assert.deepEqual(normalizeConcurrencyPool(7), { limit: 7 });

  const today = {
    concurrencyPools: { zai: 7 },
    sandboxProfiles: { agent: { image: "busybox:latest", maxConcurrent: 7 } },
    presets: { "python-developer": { model: "zai/gpt-5", thinking: "high", sandbox: "agent" } }
  };
  // Normalization is a no-op on today's shape, apart from reading each numeric
  // pool as its {limit} record.
  assert.deepEqual(normalizeConfigLayer(today), {
    concurrencyPools: { zai: { limit: 7 } },
    sandboxProfiles: { agent: { image: "busybox:latest", maxConcurrent: 7 } },
    presets: { "python-developer": { model: "zai/gpt-5", thinking: "high", sandbox: "agent" } }
  });
  const merged = normalizeConfigLayer(today);
  assert.equal(normalizeSandbox("agent", merged.sandboxProfiles).maxConcurrent, 7);

  // The profile-level pool is a removed form: refusal, not silent ignore — a
  // silently ignored field leaves a config that looks tuned and is not.
  assert.throws(
    () =>
      refuseRemovedConcurrencyGroup(
        normalizeConfigLayer({ sandboxProfiles: { agent: { image: "img", concurrencyGroup: "zai" } } })
      ),
    /removed "concurrencyGroup" field.*"concurrencyPools"/s,
    "the refusal names what replaced the field"
  );
  assert.throws(
    () => refuseRemovedConcurrencyGroup(normalizeConfigLayer({ presets: [{ id: "role", concurrencyGroup: "zai" }] })),
    /Preset "role" uses the removed "concurrencyGroup" field.*"concurrencyPools"/s
  );
  // Объектная песочница несёт per-role поля, и до дельты поле читалось именно
  // из нормализованной песочницы: отказ обязан накрывать и эту позицию записи.
  assert.throws(
    () =>
      refuseRemovedConcurrencyGroup(
        normalizeConfigLayer({ presets: [{ id: "role", sandbox: { profile: "agent", concurrencyGroup: "zai" } }] })
      ),
    /Preset "role" \(sandbox\) uses the removed "concurrencyGroup" field/s,
    "the object preset.sandbox form is refused too"
  );
  assert.throws(
    () => refuseRemovedConcurrencyGroup(normalizeConfigLayer({ defaults: { sandbox: { concurrencyGroup: "zai" } } })),
    /defaults \(sandbox\) uses the removed "concurrencyGroup" field/s,
    "the object defaults.sandbox form is refused too"
  );
});

// Тайминги пула доходят до прогона через Number(): "30s" там превращается в
// NaN — прогон вечно ждёт занятый слот, а после него падает с RangeError,
// маскируя исходную ошибку. Поэтому мусорное значение — отказ конфигурации
// с именем поля, а не молчаливый дефолт; priority из того же правила.
test("pool timings and priority are validated at normalization: junk is refused naming the field", async () => {
  const { normalizeConfigLayer } = await import("../plugins/pi/scripts/lib/config.mjs");

  for (const field of ["poolWaitMs", "poolCooldownBalanceMs", "poolCooldownQuotaMs", "poolCooldownNetworkMs"]) {
    assert.throws(
      () => normalizeConfigLayer({ [field]: "30s" }),
      new RegExp(`Config field "${field}" must be a non-negative number of milliseconds`),
      `${field} must refuse "30s"`
    );
    assert.throws(() => normalizeConfigLayer({ [field]: -1 }), new RegExp(`Config field "${field}"`), `${field} must refuse a negative`);
  }
  const valid = normalizeConfigLayer({ poolWaitMs: 5000, poolCooldownNetworkMs: 0 });
  assert.equal(valid.poolWaitMs, 5000, "a number passes through");
  assert.equal(valid.poolCooldownNetworkMs, 0, "zero is a legal cooldown");

  assert.throws(
    () => normalizeConfigLayer({ concurrencyPools: { p: { limit: 2, priority: "high" } } }),
    /Concurrency pool "p" needs a finite numeric "priority", got "high"/,
    "a junk priority is refused, not read as NaN"
  );
  assert.equal(normalizeConfigLayer({ concurrencyPools: { p: { limit: 2, priority: 0 } } }).concurrencyPools.p.priority, 0);
});

// Букальный `--model provider/name` (не из пресета) называет СВОЕГО
// провайдера: если после выбора варианта ключ Credential-прокси ставится по
// победителю, чужой аккаунт получает модель, которую он, возможно, не
// обслуживает. Голое имя — наоборот, едет на эндпоинте победителя.
test("applyPickedVariant: a literal provider/name model keeps its own provider; a bare name takes the winner's", async () => {
  const { applyPickedVariant } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const picked = {
    provider: "zai-coding-cn",
    model: "zai-coding-cn/glm-5",
    thinking: null,
    sandbox: { poolName: "zai", maxConcurrent: 2 }
  };

  const literal = { model: "openrouter/foo", provider: null, sandbox: {} };
  applyPickedVariant(literal, picked);
  assert.equal(literal.model, "openrouter/foo", "the literal model travels as written");
  assert.equal(literal.provider, "openrouter", "the literal names its own provider");
  assert.equal(literal.sandbox.provider, "openrouter", "the credential proxy keys on the literal's provider");

  const bare = { model: "some-preset-id", provider: null, sandbox: {} };
  applyPickedVariant(bare, picked);
  assert.equal(bare.provider, "zai-coding-cn", "a bare name runs on the winner's endpoint");
  assert.equal(bare.sandbox.provider, "zai-coding-cn");

  const none = { model: null, provider: null, sandbox: {} };
  applyPickedVariant(none, picked);
  assert.equal(none.model, "zai-coding-cn/glm-5");
  assert.equal(none.provider, "zai-coding-cn", "no model choice at all follows the winner");
});

test("a project layer with one pool does not wipe the user's pools, and cannot point models at a provider", async () => {
  const { sanitizeProjectLayer, BUILT_IN_CONFIG, mergeConfigLayer } = await import(
    "../plugins/pi/scripts/lib/config.mjs"
  );

  const user = normalizeConfigLayer(ownerFormConfig());
  const projectWarnings = [];
  const project = sanitizeProjectLayer(
    normalizeConfigLayer({
      concurrencyPools: [{ pool: `beta-${UNIQUE}`, limit: 9, models: [{ id: "x", provider: "evil", name: "m" }] }],
      sandboxServices: [{ id: "sneaky", image: "img", mounts: ["/:/host:rw"], args: ["--privileged"] }]
    }),
    projectWarnings
  );
  const merged = mergeConfigLayer(mergeConfigLayer(BUILT_IN_CONFIG, user), project);

  assert.equal(merged.concurrencyPools[`alpha-${UNIQUE}`].limit, 1, "the user's pool survives");
  assert.equal(merged.concurrencyPools[`beta-${UNIQUE}`].limit, 9, "the project's capacity change lands");
  assert.equal(
    merged.concurrencyPools[`beta-${UNIQUE}`].models,
    undefined,
    "the project cannot decide which provider a pool's models hit"
  );
  assert.ok(projectWarnings.some((line) => line.includes("cannot point a pool's models")), JSON.stringify(projectWarnings));

  // The trust boundary covers the new block exactly like the old one: a service
  // is a profile once normalized, so its mounts and args are stripped.
  assert.ok(projectWarnings.some((line) => line.includes("sneaky.sandbox.mounts ignored")), JSON.stringify(projectWarnings));
  assert.equal(merged.sandboxProfiles.sneaky.mounts, undefined);
  assert.equal(merged.sandboxProfiles.sneaky.args, undefined);
});

test("a project layer cannot set samplingParams on any sandbox, nor tune pool waits and cooldowns", async () => {
  const { sanitizeProjectLayer, BUILT_IN_CONFIG, mergeConfigLayer } = await import(
    "../plugins/pi/scripts/lib/config.mjs"
  );

  // samplingParams travels from the resolved sandbox into every paid request
  // body, so each of the three places a project layer could inject it is its
  // own attack path and gets its own case.
  const paths = [
    ["preset", { presets: { [`p-${UNIQUE}`]: { model: "m", sandbox: { profile: "s", samplingParams: { max_tokens: 1000000 } } } } }],
    ["defaults.sandbox", { defaults: { sandbox: { samplingParams: { max_tokens: 1000000 } } } }],
    ["user profile override", { sandboxProfiles: { [`svc-${UNIQUE}`]: { image: "img", samplingParams: { max_tokens: 1000000 } } } }]
  ];
  for (const [name, layer] of paths) {
    const warnings = [];
    const clean = sanitizeProjectLayer(normalizeConfigLayer(layer), warnings);
    const merged = mergeConfigLayer(BUILT_IN_CONFIG, clean);
    assert.ok(
      warnings.some((line) => line.includes("samplingParams ignored")),
      `${name}: warned, got ${JSON.stringify(warnings)}`
    );
    const sandboxes = [
      ...Object.values(clean.presets ?? {}).map((p) => p.sandbox),
      clean.defaults?.sandbox,
      ...Object.values(clean.sandboxProfiles ?? {})
    ];
    for (const s of sandboxes) {
      if (s && typeof s === "object") assert.equal(s.samplingParams, undefined, name);
    }
    assert.ok(merged, "merged without throwing");
  }

  // Pool timing knobs are top-level, not sandbox keys, but the project layer
  // feeds them into mergeConfigLayer all the same: shortening a cooldown keeps
  // re-hitting a provider the owner wrote off as dead.
  const warnings = [];
  const clean = sanitizeProjectLayer(
    normalizeConfigLayer({ poolWaitMs: 1, poolCooldownBalanceMs: 1, poolCooldownQuotaMs: 1, poolCooldownNetworkMs: 1 }),
    warnings
  );
  const mergedTiming = mergeConfigLayer(BUILT_IN_CONFIG, clean);
  assert.equal(mergedTiming.poolWaitMs, 30_000, "the owner's wait survives");
  assert.equal(mergedTiming.poolCooldownBalanceMs, 3_600_000);
  assert.equal(mergedTiming.poolCooldownQuotaMs, 86_400_000);
  assert.equal(mergedTiming.poolCooldownNetworkMs, 30_000);
  for (const key of ["poolWaitMs", "poolCooldownBalanceMs", "poolCooldownQuotaMs", "poolCooldownNetworkMs"]) {
    assert.ok(warnings.some((line) => line.startsWith(`${key} ignored`)), JSON.stringify(warnings));
  }
});

test("an unknown model id or service is refused with what is known, and provider/name gets a hint", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const config = normalizeConfigLayer(ownerFormConfig());

  assert.throws(
    () => buildVariants({ models: [`ghost-${UNIQUE}`], sandbox: "agent" }, config),
    new RegExp(`references model "ghost-${UNIQUE}".*Known models: fast-${UNIQUE}, smart-${UNIQUE}, other-${UNIQUE}`)
  );
  assert.throws(
    () => buildVariants({ models: ["prov/fast-model"], sandbox: "agent" }, config),
    /"prov\/fast-model" is provider\/name — address this model by its id/,
    "the old addressing habit is named, not just refused"
  );
  assert.throws(
    () => buildVariants({ models: [`fast-${UNIQUE}`], sandbox: "no-such-service" }, config),
    /Unknown sandbox "no-such-service".*base, agent/
  );
});

// sandboxService допускает объект: роль несёт СВОИ добавки (pi-хуки набором,
// GIT_CONFIG_*), и им нужно место рядом с сервисом. Контур обязан совпасть со
// старой формой `sandbox: {profile, env}` — списки роли складываются с
// сервисом, скаляры перекрывают.
test("a sandboxService object folds into the service with the role's additions, same contour as the old sandbox form", async () => {
  const { normalizeConfigLayer } = await import("../plugins/pi/scripts/lib/config.mjs");
  const { normalizeSandbox } = await import("../plugins/pi/scripts/lib/sandbox.mjs");

  const contour = (config, sandbox) => {
    const full = normalizeSandbox(sandbox, config.sandboxProfiles ?? {});
    delete full.profileName;
    return full;
  };

  const rawObject = ownerFormConfig();
  rawObject.presets.find((p) => p.id === "role").sandboxService = {
    id: "agent",
    env: ["PI_HOOKS=go-cache-guard", "GIT_CONFIG_COUNT=1"],
    mounts: ["/srv/role:/role:ro"]
  };
  const objectForm = normalizeConfigLayer(rawObject);
  const rawOld = ownerFormConfig();
  delete rawOld.presets.find((p) => p.id === "role").sandboxService;
  rawOld.presets.find((p) => p.id === "role").sandbox = {
    profile: "agent",
    env: ["PI_HOOKS=go-cache-guard", "GIT_CONFIG_COUNT=1"],
    mounts: ["/srv/role:/role:ro"]
  };
  const oldForm = normalizeConfigLayer(rawOld);

  // Same allowed contour either way — the object is sugar over the old shape.
  assert.deepEqual(contour(objectForm, objectForm.presets.role.sandbox), contour(oldForm, oldForm.presets.role.sandbox));

  const resolved = contour(objectForm, objectForm.presets.role.sandbox);
  // The service's own equipment is still there: the role's lists ADD, not wipe.
  assert.ok(resolved.env.includes("PATH=/toolchain"), "the base's env survives");
  assert.ok(resolved.env.includes("EXTRA=1"), "the service's env survives");
  assert.ok(resolved.env.includes("PI_HOOKS=go-cache-guard"), "the role's env is added on top");
  assert.ok(resolved.mounts.includes("/srv/base:/base:ro") && resolved.mounts.includes("/srv/role:/role:ro"));
  assert.deepEqual(resolved.args, ["--cpus", "6", "--security-opt", "no-new-privileges"], "args add positionally");

  // Malformed object: no id to name the service — a refusal, not a guess.
  assert.throws(
    () => normalizeConfigLayer({ presets: [{ id: "broken", models: [], sandboxService: { env: ["X=1"] } }] }),
    /sandboxService.*neither a service id nor an object with a string "id"/
  );
  // Unknown service id (object form) — refused with the known list, same as string.
  assert.throws(
    () => {
      const raw = ownerFormConfig();
      raw.presets.find((p) => p.id === "role").sandboxService = { id: "no-such-service" };
      const config = normalizeConfigLayer(raw);
      contour(config, config.presets.role.sandbox);
    },
    /Unknown sandbox "no-such-service".*base, agent/
  );
});

test("models of one pool share one quota, and a bare number still reads as a limit", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { awaitSandboxSlot, describeSlotUsage } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const config = normalizeConfigLayer(ownerFormConfig({ limit: 1 }));
  config.presets.role.models = [`fast-${UNIQUE}`, `smart-${UNIQUE}`, `other-${UNIQUE}`];
  const { variants } = buildVariants(config.presets.role, config);
  const fast = variantById(variants, `fast-${UNIQUE}`);
  const smart = variantById(variants, `smart-${UNIQUE}`);
  const other = variantById(variants, `other-${UNIQUE}`);

  assert.equal(fast.sandbox.poolName, fast.pool, "the pool is the quota scope, not the model");
  assert.equal(fast.sandbox.maxConcurrent, 1);
  assert.equal(smart.sandbox.poolName, fast.sandbox.poolName, "same pool, same scope");

  // A slot held by `fast` must be visible to `smart` of the SAME pool, while a
  // different pool with the same limit is untouched.
  const claim = await awaitSandboxSlot(fast.sandbox, { timeoutMs: 1000, pollMs: 10 });
  try {
    assert.equal(describeSlotUsage(fast.sandbox).used, 1);
    await assert.rejects(
      () => awaitSandboxSlot(smart.sandbox, { timeoutMs: 0, pollMs: 10 }),
      /allows 1 container/,
      "the second model of one pool sees the first one's slot"
    );
    const slot = await awaitSandboxSlot(other.sandbox, { timeoutMs: 1000, pollMs: 10 });
    slot.release();
  } finally {
    claim.release();
  }
});

test("pool priority orders the candidates; equal priorities keep the preset's listing order", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const config = normalizeConfigLayer(ownerFormConfig());
  config.concurrencyPools[`alpha-${UNIQUE}`].priority = 5;
  config.concurrencyPools[`beta-${UNIQUE}`].priority = 1;

  const ordered = buildVariants(config.presets.role, config).variants.map((variant) => variant.pool);
  assert.deepEqual(ordered, [`alpha-${UNIQUE}`, `beta-${UNIQUE}`], "bigger priority goes first");

  // A pool that states no priority is the fallback, not the first choice: the
  // reverse default sent every run to the unranked pool.
  delete config.concurrencyPools[`beta-${UNIQUE}`].priority;
  const unranked = buildVariants(config.presets.role, config).variants.map((variant) => variant.pool);
  assert.deepEqual(unranked, [`alpha-${UNIQUE}`, `beta-${UNIQUE}`], "a pool with no priority sorts last");

  // Equal priorities fall back to the order the preset listed the models in —
  // the owner's example ties all pools at 10 and orders through the list.
  config.concurrencyPools[`alpha-${UNIQUE}`].priority = 10;
  config.concurrencyPools[`beta-${UNIQUE}`].priority = 10;
  const tied = buildVariants(config.presets.role, config).variants.map((variant) => variant.id);
  assert.deepEqual(tied, [`fast-${UNIQUE}`, `other-${UNIQUE}`]);
});

test("a busy pool is skipped after the wait threshold, and only an all-busy preset queues", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { awaitSandboxSlot, awaitVariantSlot } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const config = normalizeConfigLayer(ownerFormConfig({ limit: 1 }));
  const { variants } = buildVariants(config.presets.role, config);
  const first = variants[0];
  const second = variants[1];
  const progress = [];
  const onProgress = (event) => progress.push(event.message ?? "");

  // Threshold 0: a busy pool is left immediately for a free one. Timed,
  // because "eventually picks the free one" is also what ignoring the
  // threshold looks like — the difference is whether we queued first.
  const held = await awaitSandboxSlot(first.sandbox, { timeoutMs: 1000, pollMs: 10 });
  try {
    const startedAt = Date.now();
    const picked = await awaitVariantSlot(variants, { poolWaitMs: 0, timeoutMs: 5000, onProgress });
    assert.ok(Date.now() - startedAt < 2000, "the busy pool is not queued past the zero threshold");
    assert.equal(picked.pool, second.pool, "the free pool is taken instead of queuing");
    picked.release();
  } finally {
    held.release();
  }

  // A threshold longer than the release waits the busy pool out.
  const slow = await awaitSandboxSlot(first.sandbox, { timeoutMs: 1000, pollMs: 10 });
  setTimeout(() => slow.release(), 150);
  const waited = await awaitVariantSlot(variants, { poolWaitMs: 5000, timeoutMs: 30000, onProgress });
  assert.equal(waited.pool, first.pool, "the first by priority is waited for when it frees in time");
  assert.ok(waited.waitedMs >= 100, "the wait actually happened");
  waited.release();

  // Every pool busy: queue for the FIRST BY ORDER and say what for — a silent
  // queue reads as a hang.
  const holdA = await awaitSandboxSlot(first.sandbox, { timeoutMs: 1000, pollMs: 10 });
  const holdB = await awaitSandboxSlot(second.sandbox, { timeoutMs: 1000, pollMs: 10 });
  try {
    await assert.rejects(
      () => awaitVariantSlot(variants, { poolWaitMs: 0, timeoutMs: 150, onProgress, pollMs: 10 }),
      /allows 1 container/,
      "giving up is still the outcome when nothing frees"
    );
    assert.ok(
      progress.some(
        (message) => message.includes(`pool "${first.pool}"`) && message.includes("first by priority")
      ),
      `the queue is announced: ${JSON.stringify(progress)}`
    );
  } finally {
    holdA.release();
    holdB.release();
  }
});

test("the chosen model's thinking and tags win over the preset's", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { resolveRunSettings } = await import("../plugins/pi/scripts/lib/config.mjs");
  const config = normalizeConfigLayer(ownerFormConfig());
  config.presets.role.models = [`fast-${UNIQUE}`, `smart-${UNIQUE}`, `other-${UNIQUE}`];
  config.concurrencyPools[`alpha-${UNIQUE}`].models[`fast-${UNIQUE}`].thinking = "off";
  config.concurrencyPools[`alpha-${UNIQUE}`].models[`fast-${UNIQUE}`].tags = ["local"];
  config.concurrencyPools[`alpha-${UNIQUE}`].models[`smart-${UNIQUE}`].thinking = "low";
  config.presets.role.thinking = "high";
  config.presets.role.tags = ["role-tag"];

  const variants = buildVariants(config.presets.role, config).variants;
  assert.equal(variantById(variants, `fast-${UNIQUE}`).thinking, "off");
  assert.equal(variantById(variants, `smart-${UNIQUE}`).thinking, "low");

  // Through the settings layer: the preset's thinking is what resolves before a
  // model is picked; the slot-time pick replaces it with the model's own, but a
  // flag outranks both — hence the source is carried, not re-derived.
  const settings = resolveRunSettings(config, "delegate", { preset: "role" });
  assert.equal(settings.thinking, "high", "the preset's value stands until a model is chosen");
  assert.deepEqual(settings.tags, ["role-tag"], "the preset's tags resolve per layer");
  assert.equal(settings.thinkingFromFlag, false, "no flag, so the model may override");
  const flagged = resolveRunSettings(config, "delegate", {
    preset: "role",
    thinking: "medium"
  });
  assert.equal(flagged.thinkingFromFlag, true, "a flag outranks the model record");
});

test("the old <role>-<pool> names resolve through pool or model id; <role>-local is refused", async () => {
  const { resolveRunSettings } = await import("../plugins/pi/scripts/lib/config.mjs");
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const config = normalizeConfigLayer(ownerFormConfig());
  config.presets.role.systemPrompt = "reviewer";

  const byPool = resolveRunSettings(config, "delegate", { preset: `role-beta-${UNIQUE}` });
  assert.equal(byPool.presetName, "role", "the pool pin resolves onto the role preset");
  assert.equal(byPool.presetPool, `beta-${UNIQUE}`);
  assert.equal(byPool.requestedPresetName, `role-beta-${UNIQUE}`, "the request keeps the name that was asked for");

  // A tail naming a model id pins that model's pool.
  const byModel = resolveRunSettings(config, "delegate", { preset: `role-other-${UNIQUE}` });
  assert.equal(byModel.presetPool, `beta-${UNIQUE}`);

  const pinned = buildVariants(config.presets.role, config, { poolPin: `beta-${UNIQUE}` });
  assert.deepEqual(pinned.variants.map((variant) => variant.pool), [`beta-${UNIQUE}`]);

  // Pool aliases are gone (owner decision): the `*-local` spelling does not
  // resolve, and the refusal names what IS available rather than guessing.
  assert.throws(
    () => resolveRunSettings(config, "delegate", { preset: "role-local" }),
    (error) => {
      assert.match(error.message, /Unknown preset "role-local"/);
      assert.match(error.message, new RegExp(`Available presets: role`));
      return true;
    },
    "the *-local spelling must be refused with the available list"
  );
  assert.throws(
    () => resolveRunSettings(config, "delegate", { preset: "role-ghost" }),
    /Unknown preset/,
    "an unmatched tail is a refusal, not a silent fall-back to the first model"
  );
  // And the field itself does not come back: a pool with aliases is refused.
  assert.throws(
    () => normalizeConfigLayer({ concurrencyPools: [{ pool: `p-${UNIQUE}`, limit: 1, aliases: ["local"] }] }),
    /removed "aliases"/
  );
});

test("--model addresses a model by id or provider/name, or stays a literal override", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const config = normalizeConfigLayer(ownerFormConfig());
  config.presets.role.models = [`fast-${UNIQUE}`, `smart-${UNIQUE}`, `other-${UNIQUE}`];

  const byId = buildVariants(config.presets.role, config, { modelWanted: `smart-${UNIQUE}` });
  assert.deepEqual(byId.variants.map((variant) => variant.id), [`smart-${UNIQUE}`]);
  assert.equal(byId.modelOverride, null, "an addressed model needs no override");

  const byFullName = buildVariants(config.presets.role, config, { modelWanted: "prov2/other-model" });
  assert.deepEqual(byFullName.variants.map((variant) => variant.id), [`other-${UNIQUE}`]);

  const literal = buildVariants(config.presets.role, config, { modelWanted: "other/model" });
  assert.equal(literal.variants.length, 3, "an unknown model pins nothing");
  assert.equal(literal.modelOverride, "other/model", "it rides whichever candidate wins the slot race");
});

test("pia presets prints models with pools and the sandbox service", async () => {
  const { presetPlansFor } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { presetLines } = await import("../plugins/pi/scripts/lib/render.mjs");
  const config = normalizeConfigLayer(ownerFormConfig());
  const plans = presetPlansFor(config);
  assert.deepEqual(
    plans.role.models.map((model) => `${model.id} (${model.pool}, ${model.provider})`),
    [`fast-${UNIQUE} (alpha-${UNIQUE}, prov)`, `other-${UNIQUE} (beta-${UNIQUE}, prov2)`]
  );
  assert.equal(plans.role.sandbox, "agent");

  // A preset that cannot resolve degrades to no plan instead of muting others.
  const broken = normalizeConfigLayer(ownerFormConfig());
  broken.presets.broken = { id: "broken", models: ["no-such-id"], sandboxService: "agent" };
  const tolerant = presetPlansFor(broken);
  assert.equal(tolerant.broken, undefined);
  assert.ok(tolerant.role, "the healthy preset is still listed");

  const lines = presetLines({ role: { sandbox: "agent" } }, {}, {}, plans);
  assert.match(lines[0], new RegExp(`models \`fast-${UNIQUE}\` \\(alpha-${UNIQUE}, prov\\)`));
  assert.match(lines[0], /sandbox `agent`/);
});

test("the run path resolves a models preset end to end", async (t) => {
  const { sandboxPreflight } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const preflight = sandboxPreflight({ mode: "docker", image: "busybox:latest" });
  if (!preflight.ok) {
    t.skip(`нужен локальный docker с образом-заглушкой: ${preflight.errors[0]}`);
    return;
  }

  const { buildRunSettings } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const config = normalizeConfigLayer(ownerFormConfig());
  // Preflight refuses mounts whose host side does not exist (B85-12), so the
  // stub services mount real temporary directories instead of /srv/*.
  const mountDirs = [];
  for (const profile of Object.values(config.sandboxProfiles ?? {})) {
    profile.mounts = (profile.mounts ?? []).map((mount) => {
      const target = String(mount).split(":")[1];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-pools-mount-"));
      mountDirs.push(dir);
      return `${dir}:${target}:ro`;
    });
  }
  config.presets.role.systemPrompt = "reviewer";
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-pools-"));
  try {
    const settings = buildRunSettings({
      command: "delegate",
      flags: { preset: "role", "git-name": "t", "git-email": "t@t" },
      workspaceRoot,
      runRoot: workspaceRoot,
      config
    });
    assert.equal(settings.sandboxVariants.length, 2, "both pools became candidates");
    // buildRunSettings reshapes the stand-in (identity env, isolateCaches), so
    // compare the shape, not the object identity.
    assert.equal(settings.sandbox.poolName, settings.sandboxVariants[0].sandbox.poolName,
      "the first candidate stands in until slot time");
    assert.equal(settings.sandbox.profileName, "agent");
    assert.equal(settings.model, null, "the model comes from the candidate, picked at slot time");
    assert.equal(settings.poolWaitMs, 30000);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    for (const dir of mountDirs) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The slot-time pick used to rebuild `settings.sandbox` from `picked.sandbox`
// — the raw role sandbox — dropping everything buildRunSettings had developed:
// cache isolation, git proxy hosts, the run's own mounts and the git identity
// env. A pooled run then went out without any of it, silently.
test("the slot-time pick keeps the developed sandbox and moves only model-choice fields", async () => {
  const { applyPickedVariant } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const settings = {
    sandbox: {
      mode: "docker",
      image: "busybox:latest",
      provider: "stand-in",
      profileName: "agent",
      isolateCaches: true,
      gitProxyHosts: { "github.com": "127.0.0.1:0" },
      mounts: ["/need:/need:ro"],
      env: ["GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t"],
      poolName: `alpha-${UNIQUE}`,
      maxConcurrent: 1
    },
    thinking: "high",
    tags: ["role-tag"]
  };
  applyPickedVariant(settings, {
    provider: "prov",
    model: "prov/smart-model",
    thinking: "low",
    samplingParams: { max_tokens: 4096 },
    sandbox: { poolName: `beta-${UNIQUE}`, maxConcurrent: 2, heldSlot: { waitedMs: 5, release: () => {} } }
  });

  assert.equal(settings.sandbox.isolateCaches, true, "cache isolation survives the pick");
  assert.deepEqual(settings.sandbox.gitProxyHosts, { "github.com": "127.0.0.1:0" }, "git proxy hosts survive");
  assert.deepEqual(settings.sandbox.mounts, ["/need:/need:ro"], "declared mounts survive");
  assert.ok(
    settings.sandbox.env.includes("GIT_AUTHOR_NAME=t") && settings.sandbox.env.includes("GIT_AUTHOR_EMAIL=t@t"),
    "git identity env survives"
  );
  assert.equal(settings.sandbox.provider, "prov", "the winner's provider keys the credential proxy");
  assert.deepEqual(settings.sandbox.samplingParams, { max_tokens: 4096 });
  assert.equal(settings.sandbox.poolName, `beta-${UNIQUE}`, "the pool fields follow the winner");
  assert.equal(settings.sandbox.maxConcurrent, 2);
  assert.equal(settings.sandbox.heldSlot.waitedMs, 5, "the claimed slot travels in the sandbox");
  assert.equal(settings.model, "prov/smart-model");
  assert.equal(settings.provider, "prov");
  assert.equal(settings.thinking, "low", "the model record's thinking overrides the preset's");
  // Model records carry no tags anymore: the preset's list is the whole answer.
  assert.deepEqual(settings.tags, ["role-tag"]);
});

// Т-8, финальная клауза: выбор варианта обязан положить в settings provider,
// model, thinking и samplingParams ВЫБРАННОЙ модели — иначе прогон уезжает
// с thinking/потолком первой же записи, которую пропустили.
test("the slot pick fills settings with the CHOSEN model's provider, model, thinking and samplingParams", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { awaitSandboxSlot, awaitVariantSlot } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const { resolveRunSettings } = await import("../plugins/pi/scripts/lib/config.mjs");
  const { applyPickedVariant } = await import("../plugins/pi/scripts/pi-companion.mjs");

  const config = normalizeConfigLayer(ownerFormConfig({ limit: 1 }));
  config.presets.role.models = [`fast-${UNIQUE}`, `other-${UNIQUE}`];
  config.presets.role.thinking = "high";
  config.presets.role.tags = ["role-tag"];
  const alpha = config.concurrencyPools[`alpha-${UNIQUE}`].models;
  alpha[`fast-${UNIQUE}`] = {
    ...alpha[`fast-${UNIQUE}`],
    thinking: "off",
    samplingParams: { temperature: 1, max_tokens: 111 }
  };
  config.concurrencyPools[`beta-${UNIQUE}`].models[`other-${UNIQUE}`] = {
    ...config.concurrencyPools[`beta-${UNIQUE}`].models[`other-${UNIQUE}`],
    thinking: "low",
    samplingParams: { temperature: 0.5, max_tokens: 222 }
  };

  const settings = resolveRunSettings(config, "delegate", { preset: "role" });
  const { variants } = buildVariants(config.presets.role, config);
  settings.sandbox = variants[0].sandbox;

  // The first candidate's pool is busy: the pick must land on the second, and
  // every model-choice field must be the SECOND's — not the first's, not the
  // preset's.
  const held = await awaitSandboxSlot(variants[0].sandbox, { timeoutMs: 1000, pollMs: 10 });
  try {
    const picked = await awaitVariantSlot(variants, { poolWaitMs: 0, timeoutMs: 5000 });
    assert.equal(picked.id, `other-${UNIQUE}`, "the busy first candidate was skipped");
    applyPickedVariant(settings, picked);
    picked.release();
  } finally {
    held.release();
  }

  assert.equal(settings.provider, "prov2");
  assert.equal(settings.model, "prov2/other-model");
  assert.equal(settings.thinking, "low", "the chosen model's thinking, not the first's (off) or the preset's (high)");
  assert.deepEqual(settings.tags, ["role-tag"], "the preset's tags are the whole answer; model records carry none");
  assert.deepEqual(settings.sandbox.samplingParams, { temperature: 0.5, max_tokens: 222 }, "the chosen model's sampling params, not the first's");
});

// Теги записи модели сняты владельцем: единственный потребитель читал теги
// пресета, поэтому запись с тегами не должна прокинуть их ни в вариант,
// ни в settings — даже когда пресет своих тегов не называет.
test("a model record's tags do not reach the variant or settings", async () => {
  const { buildVariants, applyPickedVariant } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { awaitVariantSlot } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const { resolveRunSettings } = await import("../plugins/pi/scripts/lib/config.mjs");

  const config = normalizeConfigLayer(ownerFormConfig());
  config.concurrencyPools[`beta-${UNIQUE}`].models[`other-${UNIQUE}`].tags = [`model-only-${UNIQUE}`];
  config.presets.role.models = [`other-${UNIQUE}`];
  assert.equal(config.presets.role.tags, undefined, "the preset carries no tags of its own");

  const settings = resolveRunSettings(config, "delegate", { preset: "role" });
  const { variants } = buildVariants(config.presets.role, config);
  settings.sandbox = variants[0].sandbox;
  const picked = await awaitVariantSlot(variants, { poolWaitMs: 0, timeoutMs: 5000 });
  applyPickedVariant(settings, picked);
  picked.release();

  assert.deepEqual(settings.tags, [], "the model record's tags are not the answer anymore");
  assert.equal(
    variantById(buildVariants(config.presets.role, config).variants, `other-${UNIQUE}`).tags,
    undefined,
    "the variant itself carries no tags"
  );
});

// Т-1: нормализация массивов обязана стоять ДО слияния слоёв в реальном
// конвейере loadConfig, а не только в тесте, который зовёт её руками.
test("loadConfig normalizes owner-form arrays before merging: the user's pools survive a project layer", async (t) => {
  const { loadConfig } = await import("../plugins/pi/scripts/lib/config.mjs");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pools-home-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pools-ws-"));
  fs.mkdirSync(path.join(home, ".claude", "pi"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, ".claude", "pi"), { recursive: true });
  const realHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Raw user layer, owner form, TWO pools. Raw project layer, ONE pool.
  fs.writeFileSync(
    path.join(home, ".claude", "pi", "config.json"),
    JSON.stringify({
      concurrencyPools: [
        { pool: `user-a-${UNIQUE}`, limit: 3, models: [{ id: `ma-${UNIQUE}`, provider: "p", name: "m" }] },
        { pool: `user-b-${UNIQUE}`, limit: 4, models: [{ id: `mb-${UNIQUE}`, provider: "p", name: "m" }] }
      ],
      presets: [{ id: "role", models: [`ma-${UNIQUE}`], sandboxService: "svc" }],
      sandboxServices: [{ id: "svc", image: "img" }]
    })
  );
  fs.writeFileSync(
    path.join(workspaceRoot, ".claude", "pi", "config.json"),
    JSON.stringify({ concurrencyPools: [{ pool: `project-c-${UNIQUE}`, limit: 5 }] })
  );

  const { config } = loadConfig(workspaceRoot);
  assert.deepEqual(
    Object.keys(config.concurrencyPools).filter((name) => name.includes(UNIQUE)),
    [`user-a-${UNIQUE}`, `user-b-${UNIQUE}`, `project-c-${UNIQUE}`],
    "the project's single pool did not wipe the user's two"
  );
  assert.equal(config.presets.role.sandbox, "svc", "the user's preset survived whole");
});

// Отказ снятого поля должен срабатывать в реальном конвейере загрузки, на обоих
// слоях, и называть замену — иначе конфиг выглядит настроенным и не работает.
test("loadConfig refuses concurrencyGroup on a profile and on a preset, naming the replacement", async (t) => {
  const { loadConfig } = await import("../plugins/pi/scripts/lib/config.mjs");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pools-home-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pools-ws-"));
  fs.mkdirSync(path.join(home, ".claude", "pi"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, ".claude", "pi"), { recursive: true });
  const realHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  fs.writeFileSync(
    path.join(home, ".claude", "pi", "config.json"),
    JSON.stringify({ sandboxProfiles: { agent: { image: "img", concurrencyGroup: "zai" } } })
  );
  assert.throws(() => loadConfig(workspaceRoot), /Sandbox profile "agent" uses the removed "concurrencyGroup" field.*"concurrencyPools"/s);

  fs.writeFileSync(
    path.join(home, ".claude", "pi", "config.json"),
    JSON.stringify({ presets: [{ id: "role", concurrencyGroup: "zai" }] })
  );
  assert.throws(() => loadConfig(workspaceRoot), /Preset "role" uses the removed "concurrencyGroup" field.*"concurrencyPools"/s);
});

// Т-2: сервис и профиль с одним именем живут в одном пространстве — сервис
// старше; extend сервиса ссылается на запись старого блока профилей.
test("a sandboxServices entry wins a name collision with sandboxProfiles and extends into the old block", async () => {
  const { normalizeConfigLayer } = await import("../plugins/pi/scripts/lib/config.mjs");
  const { normalizeSandbox } = await import("../plugins/pi/scripts/lib/sandbox.mjs");

  const config = normalizeConfigLayer({
    sandboxProfiles: {
      shared: { image: "from-profiles", env: ["ONLY_PROFILES=1"] },
      legacy: { image: "legacy-img", mounts: ["/srv/legacy:/legacy:ro"] }
    },
    sandboxServices: [
      { id: "shared", image: "from-services", args: ["--cpus", "2"] },
      { id: "child", extend: "legacy", env: ["CHILD=1"] }
    ]
  });

  assert.equal(config.sandboxProfiles.shared.image, "from-services", "the service wins the collision");
  assert.equal(config.sandboxProfiles.shared.env, undefined, "the profile's env did not survive under the service's name");

  const child = normalizeSandbox("child", config.sandboxProfiles);
  assert.equal(child.image, "legacy-img", "extend reached a record of the old profiles block");
  assert.ok(child.mounts.includes("/srv/legacy:/legacy:ro"));
  assert.ok(child.env.includes("CHILD=1"));
});

// Приёмка «пример владельца читается И ПЕЧАТАЕТСЯ»: печать поверх дословного
// примера — строка с тремя моделями в порядке выбора и сервисом песочницы.
test("the owner's example prints: models in choice order and the sandbox service on the line", async () => {
  const { presetPlansFor } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { presetLines } = await import("../plugins/pi/scripts/lib/render.mjs");

  const config = normalizeConfigLayer(ownerExampleLiteral());
  const plans = presetPlansFor(config);
  const lines = presetLines(config.presets, {}, {}, plans);
  const line = lines.find((entry) => entry.includes("go-developer"));
  assert.ok(line, `the preset has a line: ${JSON.stringify(lines)}`);

  const modelsPart = line.match(/models (.*?)(?:, sandbox |$)/)?.[1] ?? "";
  const printed = [...modelsPart.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  assert.deepEqual(
    printed,
    ["zai-glm-5.3-flash", "deepseek-deepseek-v4-flash", "vllm-dev-Qwen3.8-27B"],
    `the three models print in choice order, got: ${JSON.stringify(printed)}`
  );
  assert.match(line, /sandbox `sandbox-agent`/);
  assert.ok(line.includes("(zai, ") && line.includes("(deepseek, ") && line.includes("(vllm, "), `each model prints with its pool: ${line}`);
});

// Т-14 на НОВОМ пути: расчёт дыр оснастки читает пресет новой формы и сервис
// из sandboxServices, а не только старый профиль.
test("equipment gaps are computed for a preset of the new form backed by a sandboxServices entry", async () => {
  const { presetPlansFor } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { presetLines } = await import("../plugins/pi/scripts/lib/render.mjs");
  const { allPresetCapabilities } = await import("../plugins/pi/scripts/lib/capabilities.mjs");

  const config = normalizeConfigLayer({
    concurrencyPools: [
      { pool: `p-${UNIQUE}`, limit: 1, models: [{ id: `m-${UNIQUE}`, provider: "prov", name: "mdl" }] }
    ],
    sandboxServices: [
      {
        id: "gapped",
        image: "img",
        skills: ["/pi-skills/git-commit"],
        mounts: ["/srv/elsewhere:/elsewhere:ro"]
      }
    ],
    presets: [{ id: "role", models: [`m-${UNIQUE}`], sandboxService: "gapped" }]
  });

  const caps = allPresetCapabilities(config);
  assert.deepEqual(caps.role.mountGaps, ["/pi-skills/git-commit"], "the gap is computed through the new path");
  const [line] = presetLines(config.presets, caps, {}, presetPlansFor(config));
  assert.match(line, /NOT MOUNTED: \/pi-skills\/git-commit/, `the line names the gap: ${line}`);
  assert.match(line, new RegExp(`models \`m-${UNIQUE}\` \\(p-${UNIQUE}, prov\\)`));
});

// Т-1: дубль id ПРЕСЕТА в массиве — отказ с именем (для пулов, сервисов и
// моделей отказ уже проверен).
test("a duplicate preset id in the array is refused with the name", () => {
  assert.throws(
    () => normalizeConfigLayer({ presets: [{ id: "dup" }, { id: "dup", model: "m" }] }),
    /Duplicate id "dup".*presets/,
    "the refusal names the duplicated preset id and the block"
  );
});

// Т-13: env и image сервиса из проектного слоя отбрасываются с предупреждением —
// env это вектор утечки секретов хоста в контейнер, image подменяет сам образ.
test("a project layer's sandboxServices lose env and image, with a warning naming each", async () => {
  const { sanitizeProjectLayer, BUILT_IN_CONFIG, mergeConfigLayer } = await import(
    "../plugins/pi/scripts/lib/config.mjs"
  );

  const warnings = [];
  const project = sanitizeProjectLayer(
    normalizeConfigLayer({
      sandboxServices: [{ id: "sneaky", image: "evil:latest", env: ["AWS_SECRET_ACCESS_KEY=x"], extensions: ["/w/ext.ts"] }]
    }),
    warnings
  );
  const merged = mergeConfigLayer(BUILT_IN_CONFIG, project);

  assert.equal(merged.sandboxProfiles.sneaky.env, undefined, "host env does not pass through the project layer");
  assert.equal(merged.sandboxProfiles.sneaky.image, undefined, "the project cannot swap the image");
  assert.equal(merged.sandboxProfiles.sneaky.extensions.length, 1, "an ordinary list field survives");
  assert.ok(warnings.some((line) => line.includes("sneaky.sandbox.env ignored")), JSON.stringify(warnings));
  assert.ok(warnings.some((line) => line.includes("sneaky.sandbox.image ignored")), JSON.stringify(warnings));
});

// Т-3: extensions и skills тоже складываются через extend — частичный список
// ребёнка не отменяет унаследованный, иначе его контейнер без правил базы.
test("extend carries extensions and skills to the child", async () => {
  const { normalizeConfigLayer } = await import("../plugins/pi/scripts/lib/config.mjs");
  const { normalizeSandbox } = await import("../plugins/pi/scripts/lib/sandbox.mjs");

  const config = normalizeConfigLayer({
    sandboxServices: [
      {
        id: "base",
        image: "img",
        extensions: ["/pi-agent/host-extensions/hooks/index.ts", "/pi-agent/host-extensions/lsp.ts"],
        skills: ["/pi-skills/vision"]
      },
      {
        id: "child",
        extend: "base",
        args: ["--cpus", "2"],
        extensions: ["/pi-agent/host-extensions/dind.ts"],
        skills: ["/pi-skills/git-commit"]
      }
    ]
  });

  const child = normalizeSandbox("child", config.sandboxProfiles);
  assert.deepEqual(child.extensions, [
    "/pi-agent/host-extensions/hooks/index.ts",
    "/pi-agent/host-extensions/lsp.ts",
    "/pi-agent/host-extensions/dind.ts"
  ], "the base's extensions survive beside the child's own");
  assert.deepEqual(child.skills, ["/pi-skills/vision", "/pi-skills/git-commit"]);
  assert.ok(child.args.includes("--cpus"), "the child's own fields stay");
});

// A pin whose pool holds none of the preset's models used to produce zero
// variants and fall through to pi's default model — no pool limit, no refusal.
test("a pool pin that matches nothing is a refusal naming the preset, pool and models", async () => {
  const { buildRunSettings } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const config = normalizeConfigLayer(ownerFormConfig());
  config.presets.alphaOnly = { id: "alphaOnly", models: [`fast-${UNIQUE}`, `smart-${UNIQUE}`], sandboxService: "agent" };
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-pins-"));
  const run = (flags) =>
    buildRunSettings({ command: "delegate", flags, workspaceRoot, runRoot: workspaceRoot, config });
  try {
    assert.throws(
      () => run({ preset: `alphaOnly-beta-${UNIQUE}` }),
      (error) => {
        assert.match(error.message, new RegExp(`"alphaOnly"`));
        assert.match(error.message, new RegExp(`beta-${UNIQUE}`));
        assert.match(error.message, new RegExp(`fast-${UNIQUE} \\(alpha-${UNIQUE}\\)`));
        return true;
      },
      "the refusal names the preset, the empty pool and what the preset does have"
    );

    // The same zero with a `--model` in play names the filter too.
    assert.throws(
      () => run({ preset: `alphaOnly-beta-${UNIQUE}`, model: `fast-${UNIQUE}` }),
      (error) => {
        assert.match(error.message, /has no models in pool/);
        assert.match(error.message, /matching --model/);
        return true;
      },
      "the refusal names the --model filter that rode along"
    );

    // Without a pin an unknown --model stays a literal override — unchanged.
    const literal = run({ preset: "alphaOnly", model: "other/model" });
    assert.equal(literal.sandboxVariants.length, 2, "no pin, so every candidate stays");
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
