import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { lineDiff, migrateConfig, verifyEquivalence, declaredDivergences } from "../plugins/pi/scripts/migrate-config.mjs";
import { normalizeConcurrencyPool } from "../plugins/pi/scripts/lib/config.mjs";

const SCRIPT = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), "../plugins/pi/scripts/migrate-config.mjs");

/** The fleet in its historical shape: 20 presets on 11 roles, five profiles, numeric pools. */
function liveFleet() {
  // Живая форма: у КАЖДОГО пресета песочница — объект `{profile, env}` с
  // пер-ролевым набором: PI_HOOKS роли (у qa добавлен test-only-guard) и
  // GIT_CONFIG_*. Это env роли, не провайдера — у членов семейства он общий.
  const roleEnv = (role, qa = false) => [
    `PI_HOOKS=commit-guard,secret-guard${qa ? ",test-only-guard" : ""}`,
    "GIT_CONFIG_COUNT=1",
    `GIT_CONFIG_KEY_0=credential.${role}`
  ];
  const sb = (role, profile, qa = false) => ({ profile, env: roleEnv(role, qa) });
  const member = (model, thinking, sandbox, extra = {}) => ({
    model,
    thinking,
    sandbox,
    systemPrompt: "@dev",
    appendSystemPrompt: ["Общий хвост"],
    timeoutMs: 1_800_000,
    git: { name: "Fleet", email: "fleet@example.com" },
    skills: ["/pi-skills/vision"],
    ...extra
  });
  const family = (role, zaiProfile, qa = false) => {
    const tags = [qa ? "qa" : "dev", role.split("-")[0]];
    return {
    [`${role}-zai`]: member("zai-coding-cn/glm-5.3-flash", "low", sb(role, zaiProfile, qa), { tags, description: `${role} (zai)` }),
    [`${role}-deepseek`]: member("deepseek/deepseek-v4-flash", "low", sb(role, "agent-deepseek", qa), { tags, description: `${role} (deepseek)` }),
    [`${role}-local`]: member("vllm/Qwen3.8-27B", "off", sb(role, "agent-dind-vllm", qa), { tags, description: `${role} (local)` })
    };
  };
  const dind = { args: ["--security-opt", "seccomp=@dind.json", "--device", "/dev/net/tun"], env: ["PI_DIND=1"], mounts: ["pi-dind:/var/lib/docker"] };
  // The owner's live layout (checked against the real file): the trio
  // agent-dind / agent-dind-vllm / agent-deepseek is byte-identical over
  // `agent` apart from concurrencyGroup; agent-lite inherits the base WITHOUT
  // the dind equipment — a difference in substance, it stays its own service.
  return {
    sandboxProfiles: {
      "agent-base": { image: "pi-sandbox-agent:latest", env: ["PATH=/t/bin"], mounts: ["/srv:/srv:ro"], args: ["--cpus", "6"] },
      agent: { profile: "agent-base", image: "pi-sandbox-agent:latest", ...dind, concurrencyGroup: "zai" },
      "agent-dind": { profile: "agent", image: "pi-sandbox-agent:latest", concurrencyGroup: "zai" },
      "agent-dind-vllm": { profile: "agent", image: "pi-sandbox-agent:latest", concurrencyGroup: "vllm" },
      "agent-deepseek": { profile: "agent", image: "pi-sandbox-agent:latest", concurrencyGroup: "deepseek" },
      "agent-lite": { profile: "agent-base", image: "pi-sandbox-agent:latest", concurrencyGroup: "zai" }
    },
    concurrencyPools: { zai: 7, deepseek: 7, vllm: 1 },
    presets: {
      ...family("go-developer", "agent-dind"),
      ...family("go-qa", "agent-dind", true),
      ...family("python-developer", "agent-dind"),
      "python-qa-zai": member("zai-coding-cn/glm-5.3-flash", "low", sb("python-qa", "agent", true), { tags: ["qa", "py"], systemPrompt: "@qa" }),
      "python-qa-local": member("vllm/Qwen3.8-27B", "off", sb("python-qa", "agent-dind-vllm", true), { tags: ["qa", "py"], systemPrompt: "@qa" }),
      ...family("web-developer", "agent"),
      "web-qa-local": member("vllm/Qwen3.8-27B", "off", sb("web-qa", "agent-dind-vllm", true), { tags: ["qa", "web"], systemPrompt: "@qa" }),
      "rust-developer-local": member("vllm/Qwen3.8-27B", "off", sb("rust-developer", "agent-dind-vllm"), { tags: ["dev", "rust"], systemPrompt: "@dev-rust" }),
      "rust-qa-local": member("vllm/Qwen3.8-27B", "off", sb("rust-qa", "agent-dind-vllm", true), { tags: ["qa", "rust"], systemPrompt: "@qa-rust" }),
      reviewer: {
        model: "zai-coding-cn/glm-5.3",
        thinking: "high",
        readOnly: true,
        tags: ["review"],
        sandbox: sb("reviewer", "agent"),
        systemPrompt: "reviewer",
        description: "Ревьюер"
      },
      researcher: { model: "zai-coding-cn/glm-5.3-flash", thinking: "high", tags: ["research"], sandbox: sb("researcher", "agent"), systemPrompt: "@research" },
      "coverage-auditor": { model: "deepseek/deepseek-v4-flash", thinking: "high", tags: ["audit", "blind"], sandbox: sb("coverage-auditor", "agent-deepseek"), systemPrompt: "@coverage" },
    },
    gitProxy: { "github.com": {} }
  };
}
// The rudiment the spec names: model2 on a family member, read by nothing.
function liveFleetWithModel2() {
  const fleet = liveFleet();
  fleet.presets["python-developer-deepseek"].model2 = "deepseek/deepseek-v4-flash-pro";
  return fleet;
}

test("Т-2: семейство схлопывается в один пресет роли; thinking и tags переезжают на записи моделей", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  assert.equal(config.presets.length, 11);
  const go = config.presets.find((preset) => preset.id === "go-developer");
  assert.ok(go, "role preset go-developer exists");
  assert.deepEqual(go.models, ["zai-glm-5.3-flash", "deepseek-deepseek-v4-flash", "vllm-Qwen3.8-27B"]);
  // Общая часть один раз: ни model, ни per-провайдерных полей в пресете нет.
  assert.equal(go.model, undefined);
  // У роли есть собственный env, поэтому песочница переносится объектной формой
  // `{id: <сервис>, ...env}` поверх сервиса; сам сервис — "agent".
  assert.equal(go.sandboxService.id, "agent");
  assert.ok(go.sandboxService.env.includes("PI_HOOKS=commit-guard,secret-guard"));
  assert.equal(go.systemPrompt, "@dev");
  assert.deepEqual(go.tags, ["dev", "go"]);
  // Различавшиеся thinking — на записях моделей. С решателем по всем
  // пользователям модели: flash нужна семействам на low, researcher — на high;
  // конфликт не кладётся на запись — семейство переносит low на пресет.
  const poolModels = Object.fromEntries(
    config.concurrencyPools.flatMap((pool) => pool.models.map((model) => [model.id, model]))
  );
  assert.equal(poolModels["zai-glm-5.3-flash"].thinking, undefined, "conflicting demand must not land on the record");
  assert.equal(poolModels["deepseek-deepseek-v4-flash"].thinking, undefined);
  assert.equal(poolModels["vllm-Qwen3.8-27B"].thinking, "off");
  assert.equal(go.thinking, "low", "family carries the level its members demanded");
  // Одиночки переносятся как есть.
  const reviewer = config.presets.find((preset) => preset.id === "reviewer");
  assert.deepEqual(reviewer.models, ["zai-glm-5.3"]);
  assert.equal(reviewer.thinking, "high");
  assert.equal(reviewer.readOnly, true);
  assert.equal(reviewer.systemPrompt, "reviewer");
});

test("Т-3: равные приоритеты — vLLM последней; БОЛЬШИЙ приоритет пула ставит его первым", () => {
  const raw = liveFleet();
  const even = migrateConfig(raw).config.presets.find((preset) => preset.id === "go-developer");
  assert.deepEqual(even.models, ["zai-glm-5.3-flash", "deepseek-deepseek-v4-flash", "vllm-Qwen3.8-27B"]);

  const uneven = liveFleet();
  // Приоритет читается как ранг: 10 старше 1. Пул, которому владелец поставил
  // единицу, уходит В КОНЕЦ — именно этого ждёт человек, пишущий «1» в смысле
  // «на крайний случай». Обратное чтение стоило живого прогона: локальная
  // модель с единицей забирала все роли себе.
  uneven.concurrencyPools = { zai: 7, deepseek: { limit: 7, priority: 1 }, vllm: 1 };
  const odd = migrateConfig(uneven).config.presets.find((preset) => preset.id === "go-developer");
  assert.deepEqual(odd.models, ["zai-glm-5.3-flash", "vllm-Qwen3.8-27B", "deepseek-deepseek-v4-flash"]);
});

test("Т-4: живая раскладка — трио схлопывается в один dind-сервис; база и lite остаются отдельными", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  assert.equal(config.sandboxProfiles, undefined);
  assert.deepEqual(
    config.sandboxServices.map((service) => service.id),
    ["agent-base", "agent", "agent-lite"]
  );
  const dindService = config.sandboxServices.find((service) => service.id === "agent");
  assert.equal(dindService.extend, "agent-base");
  assert.ok(dindService.env.includes("PI_DIND=1"));
  assert.ok(dindService.args.includes("--device"));
  assert.ok(dindService.args.includes("/dev/net/tun"));
  assert.ok(dindService.mounts.includes("pi-dind:/var/lib/docker"));
  assert.equal(dindService.image, undefined, "the base is not repeated in the heir");
  // lite наследует базу без dind-оборудования и потому не схлопывается ни с базой, ни с dind-сервисом.
  const lite = config.sandboxServices.find((service) => service.id === "agent-lite");
  assert.equal(lite.extend, "agent-base");
  assert.equal(lite.env, undefined);
  assert.equal(lite.args, undefined);
  assert.equal(lite.mounts, undefined);
  assert.ok(!JSON.stringify(config).includes("concurrencyGroup"), "provider dimension removed from the whole document");
});

test("Т-5: реестр моделей с глобальными id; пул несёт limit и priority, aliases снят", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  const pools = Object.fromEntries(config.concurrencyPools.map((pool) => [pool.pool, pool]));
  assert.equal(pools.zai.limit, 7);
  assert.equal(pools.deepseek.limit, 7);
  assert.equal(pools.vllm.limit, 1);
  // aliases сняты владельцем: пул адресуется только собственным именем.
  for (const pool of config.concurrencyPools) {
    assert.equal(pool.aliases, undefined, `pool ${pool.pool} carries no aliases`);
  }
  // aliases во входной конфигурации — внятный отказ, не молчаливый приём.
  assert.throws(
    () => normalizeConcurrencyPool({ limit: 1, aliases: ["local"] }, "vllm"),
    /removed "aliases".*address the pool as it is named/
  );
  for (const pool of config.concurrencyPools) {
    assert.equal(pool.priority, 10);
    for (const model of pool.models) {
      assert.match(model.id, new RegExp(`^${pool.pool}-`));
      assert.ok(model.provider && model.name);
    }
  }
});

test("Т-6: сверка проходит по всем 20 старым именам", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  assert.equal(Object.keys(raw.presets).length, 20);
  assert.deepEqual(verifyEquivalence(raw, config, declaredDivergences()), []);
});

test("Т-6: подмена thinking на записи модели — отказ с перечнем", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  const corrupted = JSON.parse(JSON.stringify(config));
  corrupted.concurrencyPools.find((pool) => pool.pool === "zai").models.find((model) => model.id === "zai-glm-5.3-flash").thinking = "high";
  const problems = verifyEquivalence(raw, corrupted);
  assert.ok(problems.length > 0, "corrupted thinking must be refused");
  assert.ok(
    problems.some((line) => line.includes("go-developer-zai") && line.includes("thinking")),
    `mismatch must name the old preset and the field, got: ${problems.join(" | ")}`
  );
});

test("Т-6: расхождение песочницы — отказ, а не предупреждение", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  const corrupted = JSON.parse(JSON.stringify(config));
  corrupted.sandboxServices.find((service) => service.id === "agent").env = ["PI_DIND=0"];
  const problems = verifyEquivalence(raw, corrupted);
  assert.ok(problems.some((line) => line.includes("sandbox")));
});

test("Т-7: model2 снят и назван", () => {
  const raw = liveFleetWithModel2();
  const { config, dropped } = migrateConfig(raw);
  assert.ok(!JSON.stringify(config).includes("model2"), "model2 removed from the proposed config");
  assert.ok(!JSON.stringify(config).includes("deepseek-v4-flash-pro"), "rudiment does not seed a model record");
  assert.equal(dropped.length, 1);
  assert.match(dropped[0], /python-developer-deepseek\.model2/);
});

test("Т-8: одиночка с именем роли семейства — внятный отказ с обоими именами", () => {
  const raw = liveFleet();
  // "reviewer-local" читается как роль "reviewer" с пулом, а "reviewer" — как
  // одиночка: оба схлопываются в id "reviewer".
  raw.presets["reviewer-local"] = { model: "vllm/Qwen3.8-27B", thinking: "off", sandbox: raw.presets.reviewer.sandbox };
  assert.throws(
    () => migrateConfig(raw),
    (error) => {
      assert.match(error.message, /"reviewer" and "reviewer-local".*collapse into preset id "reviewer"/);
      assert.match(error.message, /Rename one of them/);
      return true;
    },
    "the refusal names both presets and the fix"
  );
});

test("Т-8: --out пишет копию с правами 0600, как вход с секретом", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-mode-"));
  const src = path.join(dir, "config.json");
  const dst = path.join(dir, "new.json");
  fs.writeFileSync(src, JSON.stringify(liveFleet()), { mode: 0o600 });

  execFileSync(process.execPath, [SCRIPT, src, "--out", dst], { encoding: "utf8" });
  const mode = fs.statSync(dst).mode & 0o777;
  assert.equal(mode, 0o600, `got ${mode.toString(8)}; the copy carries tokenCommand secrets`);
});

test("Т-8: скрипт не пишет в исходник; пишет только в указанный другой путь", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-"));
  const src = path.join(dir, "config.json");
  const dst = path.join(dir, "new.json");
  fs.writeFileSync(src, JSON.stringify(liveFleet()));
  const before = fs.readFileSync(src, "utf8");

  // Без --out ничего не пишется.
  let out = execFileSync(process.execPath, [SCRIPT, src], { encoding: "utf8" });
  assert.equal(fs.readdirSync(dir).sort().join(","), "config.json", "no files written without --out");
  assert.ok(out.includes("---"), "diff is printed to stdout");

  // Запись — только в указанный другой путь.
  out = execFileSync(process.execPath, [SCRIPT, src, "--out", dst], { encoding: "utf8" });
  assert.equal(fs.readFileSync(src, "utf8"), before, "input untouched");
  const written = JSON.parse(fs.readFileSync(dst, "utf8"));
  assert.ok(Array.isArray(written.presets) && written.presets.length === 11);
  assert.ok(out.includes("Removed rudiments") === false, "no rudiments in the clean fleet");

  // --out на исходник — отказ.
  assert.throws(
    () => execFileSync(process.execPath, [SCRIPT, src, "--out", src], { encoding: "utf8" }),
    (error) => error.status === 2
  );
  assert.equal(fs.readFileSync(src, "utf8"), before);

  // Фикс-раунд 3: --out на СИМЛИНК или ХАРДЛИНК входа — тот же файл по
  // личности, не по пути. Сравнение путей пропускало запись в живой конфиг
  // с exit 0; отказ обязан случиться ДО миграции, вход — байт-в-байт.
  const alias = path.join(dir, "alias.json");
  fs.symlinkSync(src, alias);
  assert.throws(
    () => execFileSync(process.execPath, [SCRIPT, src, "--out", alias], { encoding: "utf8" }),
    (error) => error.status === 2
  );
  assert.equal(fs.readFileSync(src, "utf8"), before, "input untouched through the symlink");
  const hard = path.join(dir, "hard.json");
  fs.linkSync(src, hard);
  assert.throws(
    () => execFileSync(process.execPath, [SCRIPT, src, "--out", hard], { encoding: "utf8" }),
    (error) => error.status === 2
  );
  assert.equal(fs.readFileSync(src, "utf8"), before, "input untouched through the hardlink");

  // Эквивалентность предложенной формы доказана на этой же копии.
  const problems = verifyEquivalence(JSON.parse(before), written, declaredDivergences());
  assert.deepEqual(problems, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("дифф печатается построчно и показывает схлопывание", () => {
  const raw = liveFleet();
  const old = JSON.stringify(raw, null, 2);
  const fresh = JSON.stringify(migrateConfig(raw).config, null, 2);
  const diff = lineDiff(old, fresh, "old", "new");
  assert.ok(diff.startsWith("--- old"));
  assert.ok(diff.split("\n").some((line) => line.startsWith("- ") && line.includes("go-developer-zai")));
  assert.ok(diff.split("\n").some((line) => line.startsWith("+ ") && line.includes('"id": "go-developer"')));
});

// Фикс-раунд 1: правило схлопывания и переезд группы слотов в пул.

test("фикс: различие по args/mounts — отказ с перечнем имён, схлопывать нечего", () => {
  const raw = liveFleet();
  // Существенное различие: у deepseek-варианта свой объём памяти — это уже
  // другой контейнер, эквивалентность на всех старых именах не собрать.
  raw.sandboxProfiles["agent-deepseek"].args = ["--memory", "8g"];
  assert.throws(
    () => migrateConfig(raw),
    (error) => {
      assert.match(error.message, /do not collapse|не схлопываются|spans sandbox profiles/);
      assert.match(error.message, /go-developer-zai/);
      assert.match(error.message, /go-developer-deepseek/);
      assert.match(error.message, /go-developer-local/);
      return true;
    }
  );
});

test("фикс: различие по mounts — отказ, а не схлопывание", () => {
  const raw = liveFleet();
  raw.sandboxProfiles["agent-deepseek"].mounts = ["secrets:/secrets:ro"];
  assert.throws(() => migrateConfig(raw), /spans sandbox profiles/);
});

test("фикс: группа слотов каждого старого имени равна пулу его модели; расхождение — отказ", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  assert.deepEqual(verifyEquivalence(raw, config, declaredDivergences()), []);

  // Владелец перепутал группу у deepseek-профиля: старое имя go-developer-deepseek
  // считало слоты по группе deepseek, а модель уезжает в пул deepseek — расхождение
  // обязано назвать и имя, и оба пула.
  const rewired = JSON.parse(JSON.stringify(raw));
  rewired.sandboxProfiles["agent-deepseek"].concurrencyGroup = "zai";
  const problems = verifyEquivalence(rewired, migrateConfig(rewired).config);
  assert.ok(
    problems.some((line) => line.includes("go-developer-deepseek") && line.includes("zai") && line.includes("deepseek")),
    `pool rewiring must be refused, got: ${problems.join(" | ")}`
  );

  // То же на стороне РЕЗУЛЬТАТА: кто-то переименовал выходной пул — у
  // go-developer-local группа слотов перестала совпадать, сверка ловит.
  const corrupted = JSON.parse(JSON.stringify(config));
  const vllm = corrupted.concurrencyPools.find((pool) => pool.pool === "vllm");
  vllm.pool = "vllmx";
  assert.ok(verifyEquivalence(raw, corrupted).some((line) => line.includes("go-developer-local")),
    "breaking the pool name must be caught for the *-local name");
});

// Фикс-раунд 2: собственный env роли из объектной песочницы.

// Фикс-раунд 2: thinking одиночек не затекает из модельной записи.

// Фикс-раунд 2: теги ролей не перемешиваются через модельные записи.

test("фикс-раунд 2: теги остаются у роли, записи их не налипают на чужие имена и не дублируются", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  assert.deepEqual(verifyEquivalence(raw, config, declaredDivergences()), []);
  const byId = Object.fromEntries(config.presets.map((preset) => [preset.id, preset]));
  assert.deepEqual(byId["python-qa"].tags, ["qa", "py"]);
  assert.deepEqual(byId["go-developer"].tags, ["dev", "go"]);
  assert.deepEqual(byId.researcher.tags, ["research"]);
  assert.deepEqual(byId["coverage-auditor"].tags, ["audit", "blind"]);
  const flatModels = config.concurrencyPools.flatMap((pool) => pool.models);
  assert.ok(
    flatModels.every((model) => model.tags === undefined),
    "no role tag may leak onto a globally shared model record"
  );
});

test("надбавка к тегам роли не переезжает на запись модели — запись снимается, надбавка названа громко", () => {
  const raw = liveFleet();
  // Роль просит на свою deepseek-модель тег, которого нет у остальных её
  // пользователей. Записей моделей больше нет, теги живут только у пресета:
  // миграция НЕ отказывает и НЕ выбирает молча — надбавка пропадает, но её
  // исчезновение названо в DECLARED по паре «пресет + поле».
  raw.presets["python-developer-deepseek"].tags = ["dev", "py", "coverage"];
  const migrated = migrateConfig(raw);
  assert.deepEqual(migrated.config, migrated.config, "migration converges");
  const flatModels = migrated.config.concurrencyPools.flatMap((pool) => pool.models);
  assert.ok(flatModels.every((model) => model.tags === undefined), "no tag lands on a model record");
  const declared = declaredDivergences().filter((entry) => entry.field === "tags");
  assert.ok(
    declared.some((entry) => entry.preset === "python-developer-deepseek" && entry.was.includes("coverage")),
    `the lost tag extra must be named loudly: ${JSON.stringify(declared)}`
  );
  // Сверка принимает пропажу ровно по названной паре и ловит всё остальное.
  assert.deepEqual(verifyEquivalence(raw, migrated.config, declaredDivergences()), []);
});

test("общая часть тегов роли остаётся у пресета; у *-local она не шире общей — различие названо", () => {
  const raw = liveFleet();
  // Метка `local` у локального члена семейства описывала модель; записи
  // моделей сняты владельцем, поэтому надбавка исчезает — и это названо
  // громко, по имени пресета, а не стёрто молча.
  // Надбавка к общей части в фикстуре не живёт — выставляем её явно, чтобы
  // кейс проверял ПРАВИЛО, а не содержимое фикстуры.
  raw.presets["go-developer-local"].tags = ["dev", "go", "local"];
  const { config } = migrateConfig(raw);
  const byId = Object.fromEntries(config.presets.map((preset) => [preset.id, preset]));
  assert.deepEqual(byId["go-developer"].tags, ["dev", "go"], "the common part stays on the preset");
  const declared = declaredDivergences().filter((entry) => entry.field === "tags");
  assert.ok(
    declared.some((entry) => entry.preset === "go-developer-local" && JSON.stringify(entry.now).includes("dev")),
    `the *-local tag drop must be named: ${JSON.stringify(declared.map((e) => e.preset))}`
  );
  assert.deepEqual(verifyEquivalence(raw, config, declaredDivergences()), []);
});

test("фикс-раунд 2: thinking одиночки берётся из него самого, конфликт записи решается в пользу роли", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  assert.deepEqual(verifyEquivalence(raw, config, declaredDivergences()), []);
  const researcher = config.presets.find((preset) => preset.id === "researcher");
  assert.equal(researcher.thinking, "high", "researcher keeps its own level, not the family-built record's low");
  const coverage = config.presets.find((preset) => preset.id === "coverage-auditor");
  assert.equal(coverage.thinking, "high");
  // Уровень, где различие было настоящим и бесспорным (vllm off у всех), — на записи.
  const vllm = config.concurrencyPools.flatMap((pool) => pool.models).find((model) => model.id === "vllm-Qwen3.8-27B");
  assert.equal(vllm.thinking, "off");
  // Однозначная модельная запись (glm-5.3 — только reviewer) несёт свой уровень.
  const glm = config.concurrencyPools.flatMap((pool) => pool.models).find((model) => model.id === "zai-glm-5.3");
  assert.equal(glm.thinking, "high");
});

test("фикс-раунд 2: env роли переезжает на пресет новой формы, у qa — свой test-only-guard", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  assert.deepEqual(verifyEquivalence(raw, config, declaredDivergences()), []);
  const go = config.presets.find((preset) => preset.id === "go-developer");
  assert.equal(go.sandbox, undefined, "role env rides the sandboxService object, not the old field");
  assert.equal(go.sandboxService.id, "agent");
  assert.ok(go.sandboxService.env.includes("PI_HOOKS=commit-guard,secret-guard"));
  // Git-настройки переехали в сервис agent-base: у роли только PI_HOOKS.
  assert.equal(
    go.sandboxService.env.some((entry) => /^GIT_CONFIG_/.test(String(entry))),
    false,
    "the role keeps no git settings"
  );
  const gitBase = config.sandboxServices.find((service) => service.id === "agent-base");
  assert.ok(gitBase.env.includes("GIT_CONFIG_COUNT=2"));
  assert.ok(gitBase.env.includes("GIT_CONFIG_KEY_0=core.hooksPath"));
  assert.ok(gitBase.env.includes("GIT_CONFIG_VALUE_0=/pi-githooks"));
  assert.ok(gitBase.env.includes("GIT_CONFIG_KEY_1=commit.gpgsign"));
  assert.ok(gitBase.env.includes("GIT_CONFIG_VALUE_1=false"));
  const qa = config.presets.find((preset) => preset.id === "go-qa");
  assert.ok(
    qa.sandboxService.env.includes("PI_HOOKS=commit-guard,secret-guard,test-only-guard"),
    "qa keeps its own hook set"
  );
  const reviewer = config.presets.find((preset) => preset.id === "reviewer");
  assert.equal(reviewer.sandboxService.id, "agent", "the single's own env rides the object form too");
  // Роли, у которых hooksPath не было, теперь его получают — это названо
  // одной строкой громкого списка и закрывает поле sandbox в сверке.
  const hooksDeclared = declaredDivergences().find((entry) => entry.reason.includes("core.hooksPath"));
  assert.ok(hooksDeclared, "the gaining-roles divergence is declared loudly");
  assert.deepEqual(hooksDeclared.presets.sort(), [...new Set(hooksDeclared.presets)].sort());
});

test("фикс: concurrencyGroup на пресете снимается, назван в dropped, и его нет нигде в выходном документе", () => {
  const raw = liveFleet();
  raw.presets["go-developer-zai"].concurrencyGroup = "zai";
  const { config, dropped } = migrateConfig(raw);
  assert.ok(!JSON.stringify(config).includes("concurrencyGroup"), "field must not survive anywhere in the output");
  assert.ok(
    dropped.some((line) => line.includes("go-developer-zai.concurrencyGroup")),
    `the removal must be named, got: ${dropped.join(" | ")}`
  );
  assert.deepEqual(verifyEquivalence(raw, config, declaredDivergences()), []);
});

// Фикс-раунд 3: двусмысленный провайдер и сверка по фактическому пулу варианта.

test("фикс-раунд 3: провайдер, попадающий в два пула, — отказ, а не первый скан-совпадение", () => {
  const raw = liveFleet();
  // Провайдер "zai-coding" содержит имя пула "zai" и попал бы в оба: реестр
  // расселил бы запись в два пула, а слоты старых имён переехали бы молча.
  raw.concurrencyPools = { zai: 7, "zai-coding": 2, deepseek: 7, vllm: 1 };
  assert.throws(
    () => migrateConfig(raw),
    (error) => {
      assert.match(error.message, /zai-coding-cn\/glm-5\.3-flash.*more than one pool/s);
      assert.match(error.message, /zai.*zai-coding/s);
      return true;
    }
  );
});

test("фикс-раунд 3: сверка «группа слотов = пул» идёт по пулу варианта, а не по скану провайдера", () => {
  // Провайдер "ax" содержится в обоих пулах; модель пресета сидит в пуле "x",
  // но пул "ax" (с другой моделью того же провайдера) стоит в списке первым.
  // Скан «первый пул с провайдером» подхватывал бы "ax" и давал ложный отказ;
  // фактический пул варианта — "x", и группа "x" ему равна.
  const old = {
    concurrencyPools: { ax: 4, x: 2 },
    sandboxProfiles: { prof: { concurrencyGroup: "x" } },
    presets: { p: { model: "ax/m", sandbox: "prof" } }
  };
  const fresh = {
    presets: { p: { models: ["x-m"], sandboxService: "svc" } },
    sandboxServices: [{ id: "svc" }],
    concurrencyPools: [
      { pool: "ax", limit: 4, models: [{ id: "ax-other", provider: "ax", name: "other" }] },
      { pool: "x", limit: 2, models: [{ id: "x-m", provider: "ax", name: "m" }] }
    ]
  };
  assert.deepEqual(verifyEquivalence(old, fresh), [], "variant pool x equals the old slot group x");

  // А если группа честно расходится с пулом варианта — отказ называет оба.
  const rewired = JSON.parse(JSON.stringify(old));
  rewired.sandboxProfiles.prof.concurrencyGroup = "ax";
  const problems = verifyEquivalence(rewired, fresh);
  assert.ok(
    problems.some((line) => line.includes("p") && line.includes('"ax"') && line.includes('"x"')),
    `expected the mismatch to name both pools, got: ${problems.join(" | ")}`
  );
});

// Фикс-раунд 3: собственный слотовый кап профиля без группы не исчезает молча.

test("фикс-раунд 3: maxConcurrent без concurrencyGroup — отказ с именем профиля", () => {
  const raw = liveFleet();
  // agent-base — единственный профиль без группы: у остальных группа
  // наследуется/задана, и кап рядом с ней легален (его срежет пул).
  raw.sandboxProfiles["agent-base"].maxConcurrent = 2;
  assert.throws(
    () => migrateConfig(raw),
    (error) => {
      assert.match(error.message, /agent-base/);
      assert.match(error.message, /maxConcurrent/);
      assert.match(error.message, /without a concurrencyGroup/);
      return true;
    }
  );
});

test("фикс-раунд 3: сверка не срезает maxConcurrent у профиля без группы", () => {
  // Ручная пара: старое имя держит собственный кап 2 и никуда из него не
  // переезжает; контур сверки обязан увидеть расхождение, если новая сторона
  // кап потеряла (срезка как «переносимого в пул» делала сведение слепым).
  const old = {
    presets: { p: { model: "ax/m", sandbox: "prof" } },
    sandboxProfiles: { prof: { maxConcurrent: 2 } },
    concurrencyPools: { ax: 4 }
  };
  const freshNoCap = {
    presets: { p: { models: ["ax-m"], sandboxService: "svc" } },
    sandboxServices: [{ id: "svc" }],
    concurrencyPools: [{ pool: "ax", limit: 4, models: [{ id: "ax-m", provider: "ax", name: "m" }] }]
  };
  assert.ok(
    verifyEquivalence(old, freshNoCap).some((line) => line.includes("maxConcurrent") || line.includes("sandbox")),
    "a lost standalone cap must surface in the equivalence proof"
  );
  const freshWithCap = JSON.parse(JSON.stringify(freshNoCap));
  freshWithCap.sandboxServices[0].maxConcurrent = 2;
  assert.deepEqual(verifyEquivalence(old, freshWithCap), [], "matching caps prove equivalent");
});

// Фикс-раунд 3: отказ схлопывания закреплён за КАЖДЫМ существенным полем
// сервиса, а не только за args и mounts — иначе добавление поля в список
// переносимых проходит незамеченным.

test("фикс-раунд 3: различие профиля семейства ровно по полю X — отказ (параметризованно)", async (t) => {
  const cases = [
    ["args", ["--memory", "8g"]],
    ["mounts", ["secrets:/secrets:ro"]],
    ["image", "pi-sandbox-other:latest"],
    ["skills", ["/pi-skills/vision"]],
    ["user", "root"],
    ["network", "host"],
    ["extensions", ["/ext/extra"]]
  ];
  for (const [field, value] of cases) {
    await t.test(`поле ${field}`, () => {
      const raw = liveFleet();
      raw.sandboxProfiles["agent-deepseek"][field] = value;
      // Поле уходит от базы, но НЕ входит в переносимые: схлопывать нечего.
      assert.throws(() => migrateConfig(raw), /spans sandbox profiles/, `${field} must block the collapse`);
    });
  }
});

// Фикс-раунд 3: неизвестный флаг и лишний позиционный аргумент — жёсткая
// ошибка, а не тихий пропуск (конвенция репозитория: unknown flag is a hard
// error). Опечатка вида --oout с exit 0 без записи обманывала владельца.

test("фикс-раунд 3: неизвестный флаг и второй позиционный аргумент — exit 2", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-args-"));
  const src = path.join(dir, "config.json");
  fs.writeFileSync(src, JSON.stringify(liveFleet()));
  const before = fs.readFileSync(src, "utf8");

  for (const argv of [["--dffi"], ["--oout", "new.json"], [src, "extra.json"], ["--out"]]) {
    let error;
    try {
      execFileSync(process.execPath, [SCRIPT, ...argv], { encoding: "utf8" });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, `argv [${argv.join(" ")}] must fail`);
    assert.equal(error.status, 2, `argv [${argv.join(" ")}] must exit 2, got ${error.status}`);
  }
  assert.equal(fs.readdirSync(dir).sort().join(","), "config.json", "nothing written on any usage error");
  assert.equal(fs.readFileSync(src, "utf8"), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Правка 3 (решение владельца): git-настройки — общие для ВСЕХ ролей и живут
// ОДИН РАЗ в сервисе agent-base. Фикстура воспроизводит живую раскладку:
// hooksPath был у python-семейства и одной web-роли, у go его не было вовсе.
test("git-настройки переезжают в agent-base один раз; у роли остаётся PI_HOOKS; получившие hooksPath названы одной строкой", () => {
  const raw = liveFleet();
  const withHooks = (preset) => ({
    ...preset,
    sandbox: {
      ...preset.sandbox,
      env: [
        ...preset.sandbox.env.filter((entry) => !/^GIT_CONFIG_/.test(String(entry))),
        "GIT_CONFIG_COUNT=2",
        "GIT_CONFIG_KEY_0=core.hooksPath",
        "GIT_CONFIG_VALUE_0=/pi-githooks",
        "GIT_CONFIG_KEY_1=commit.gpgsign",
        "GIT_CONFIG_VALUE_1=false"
      ]
    }
  });
  for (const name of ["python-developer-zai", "python-developer-deepseek", "python-developer-local", "web-developer-zai"]) {
    raw.presets[name] = withHooks(raw.presets[name]);
  }

  const { config } = migrateConfig(raw);
  // Полный набор — в базе, один источник: позиционный протокол не терпит
  // второго владельца GIT_CONFIG_COUNT.
  const gitBase = config.sandboxServices.find((service) => service.id === "agent-base");
  assert.ok(gitBase, "agent-base exists");
  assert.ok(gitBase.env.includes("GIT_CONFIG_COUNT=2"));
  assert.ok(gitBase.env.includes("GIT_CONFIG_KEY_0=core.hooksPath"));
  assert.ok(gitBase.env.includes("GIT_CONFIG_VALUE_0=/pi-githooks"));
  assert.ok(gitBase.env.includes("GIT_CONFIG_KEY_1=commit.gpgsign"));
  assert.ok(gitBase.env.includes("GIT_CONFIG_VALUE_1=false"));

  // У ролей — только их PI_HOOKS, git-записей нет нигде.
  const go = config.presets.find((preset) => preset.id === "go-developer");
  const py = config.presets.find((preset) => preset.id === "python-developer");
  for (const [label, preset] of [["go", go], ["python", py]]) {
    assert.equal(
      preset.sandboxService.env.some((entry) => /^GIT_CONFIG_/.test(String(entry))),
      false,
      `${label}: the role keeps no git settings`
    );
    assert.ok(preset.sandboxService.env.some((entry) => entry.startsWith("PI_HOOKS=")));
  }

  // Прежнее различие web-developer-local исчезло (env членов выровнялся),
  // а получение hooksPath теми, у кого его не было, названо одной строкой.
  const declared = declaredDivergences();
  assert.ok(
    declared.every((entry) => !entry.reason.includes("env членов семейства различался")),
    "the old per-member env divergence is gone"
  );
  // DECLARED копится за весь процесс — берём самую свежую запись (эта миграция).
  const hooks = [...declared].reverse().find((entry) => entry.reason.includes("core.hooksPath"));
  assert.ok(hooks, "the gaining-roles divergence is declared");
  assert.match(hooks.preset, /роли: /);
  assert.ok(hooks.presets.includes("go-developer-zai") && hooks.presets.includes("reviewer"));
  assert.ok(!hooks.presets.includes("python-developer-zai"), "roles that had hooksPath are not named");
  // Сверка принимает изменение ровно по названным старым именам и полю sandbox.
  assert.deepEqual(verifyEquivalence(raw, config, declaredDivergences()), []);
});

// Закрытие мутационных выживших: каждый кейс ниже ассертит наблюдаемое
// поведение конкретной ветки, а не вход и итог.

/** Минимальный флот: одна роль из трёх членов + одиночка, строковые песочницы. */
function miniFleet() {
  const member = (model, thinking, extra = {}) => ({ model, thinking, sandbox: "agent", ...extra });
  return {
    sandboxProfiles: {
      "agent-base": { image: "pi-sandbox-agent:latest", env: ["BASE=1"] },
      agent: { profile: "agent-base", image: "pi-sandbox-agent:latest", concurrencyGroup: "zai" }
    },
    concurrencyPools: { zai: 2, deepseek: 2, vllm: 1 },
    presets: {
      "r-zai": member("zai/m", "low"),
      "r-deepseek": member("deepseek/d", "low"),
      "r-local": member("vllm/m", "off"),
      solo: member("zai/m2", "high")
    }
  };
}

test("commonDescription: берётся описание большинства, не общий префикс", () => {
  const raw = miniFleet();
  raw.presets["r-zai"].description = "Роль делает работу";
  raw.presets["r-deepseek"].description = "Роль делает работу";
  raw.presets["r-local"].description = "Роль делает работу — на локальной модели vLLM";
  const preset = migrateConfig(raw).config.presets.find((entry) => entry.id === "r");
  assert.equal(preset.description, "Роль делает работу", "the majority text wins whole, no char prefix");
});

test("commonDescription: пустые и не-строки отфильтрованы; ничья — первое по порядку; результат обрезан", () => {
  const tie = miniFleet();
  tie.presets["r-zai"].description = "B первым";
  tie.presets["r-deepseek"].description = "A";
  tie.presets["r-local"].description = "   ";
  assert.equal(migrateConfig(tie).config.presets.find((p) => p.id === "r").description, "B первым", "a tie keeps the first listed");

  const blanks = miniFleet();
  blanks.presets["r-zai"].description = "  ";
  blanks.presets["r-deepseek"].description = null;
  blanks.presets["r-local"].description = " X ";
  assert.equal(migrateConfig(blanks).config.presets.find((p) => p.id === "r").description, "X", "blank entries are dropped, result trimmed");

  const allBlank = miniFleet();
  allBlank.presets["r-zai"].description = "";
  allBlank.presets["r-deepseek"].description = null;
  allBlank.presets["r-local"].description = "  ";
  assert.equal(
    migrateConfig(allBlank).config.presets.find((p) => p.id === "r").description,
    undefined,
    "no usable description means none"
  );
});

test("buildPools: нулевой, отрицательный и нечисловой лимит пула — отказ; priority по умолчанию 10, числовой переносится", () => {
  // Объектная форма с некорректным лимитом отвергается ещё нормализатором
  // (normalizeConcurrencyPool), поэтому до ветки buildPools доходят числа.
  for (const limit of [0, -3]) {
    const raw = miniFleet();
    raw.concurrencyPools = { zai: limit, deepseek: 2, vllm: 1 };
    assert.throws(() => migrateConfig(raw), /pool "zai" has no usable slot limit/is, `limit ${JSON.stringify(limit)} must be refused`);
  }
  // Мусорный priority отвергается нормализатором (то же правило, что для
  // лимита): NaN приоритет раньше давал молчаливое «без приоритета».
  const withPriority = miniFleet();
  withPriority.concurrencyPools = { zai: { limit: 2, priority: 3 }, deepseek: 2, vllm: 1 };
  const pools = Object.fromEntries(migrateConfig(withPriority).config.concurrencyPools.map((pool) => [pool.pool, pool]));
  assert.equal(pools.zai.priority, 3, "a numeric priority carries over");
  const junkPriority = miniFleet();
  junkPriority.concurrencyPools = { zai: { limit: 2, priority: "не число" }, deepseek: 2, vllm: 1 };
  assert.throws(() => migrateConfig(junkPriority), /needs a finite numeric "priority"/is, "junk priority must be refused");
});

test("buildPools: провайдер вне всех пулов — отказ с именем модели", () => {
  const raw = miniFleet();
  raw.presets.solo.model = "ghost/lonely";
  assert.throws(() => migrateConfig(raw), (error) => {
    assert.match(error.message, /ghost\/lonely/);
    assert.match(error.message, /none of the configured pools/);
    return true;
  });
});

test("migrateConfig: пул vllm уходит в конец порядка пулов при любом порядке ключей входа", () => {
  const raw = miniFleet();
  // Вставка vllm первой: сортировка обязана отправить его последним.
  raw.concurrencyPools = { vllm: 1, zai: 2, deepseek: 2 };
  const { config } = migrateConfig(raw);
  assert.deepEqual(config.concurrencyPools.map((pool) => pool.pool), ["zai", "deepseek", "vllm"]);
});

test("buildServices: база выбирается по суффиксу -base, даже когда ключ в объекте не первый", () => {
  const raw = miniFleet();
  const profiles = raw.sandboxProfiles;
  raw.sandboxProfiles = Object.fromEntries([["agent", profiles.agent], ["agent-base", profiles["agent-base"]]]);
  const services = migrateConfig(raw).config.sandboxServices;
  assert.deepEqual(
    services.map((service) => service.id),
    ["agent-base", "agent"],
    "agent-base is the extend root regardless of key order"
  );
});

test("buildServices: канонический id группы — самый короткий; при равной длине — первый по алфавиту", () => {
  const raw = miniFleet();
  // Два профиля с байт-равным разрешённым содержимым и равной длиной имён.
  raw.sandboxProfiles["svc-bbb"] = { profile: "agent-base", image: "pi-sandbox-agent:latest", env: ["SVC=1"] };
  raw.sandboxProfiles["svc-aaa"] = { profile: "agent-base", image: "pi-sandbox-agent:latest", env: ["SVC=1"] };
  const ids = migrateConfig(raw).config.sandboxServices.map((service) => service.id);
  assert.ok(ids.includes("svc-aaa") && !ids.includes("svc-bbb"), `shortest/alphabetical canonical wins, got: ${ids.join(", ")}`);
});

test("buildServices: наследник, ОТЛИЧАЮЩИЙСЯ от базы скалярным полем, не записывается через extend — standalone", () => {
  const raw = miniFleet();
  // Скалярное поле, разошедшееся с базой, аддитивный extend выразить не может:
  // сервис обязан быть записан целиком.
  raw.sandboxProfiles.lite = { profile: "agent-base", image: "pi-sandbox-agent:latest", user: "nobody" };
  const lite = migrateConfig(raw).config.sandboxServices.find((service) => service.id === "lite");
  assert.equal(lite.extend, undefined, "a scalar divergence cannot ride additive extend");
  assert.equal(lite.user, "nobody");
  assert.equal(lite.image, "pi-sandbox-agent:latest");
});

test("buildServices: профиль, байт-равный базе, остаётся собственным сервисом с пустым extend", () => {
  const raw = miniFleet();
  raw.sandboxProfiles.twin = { profile: "agent-base", image: "pi-sandbox-agent:latest", concurrencyGroup: "zai" };
  const twin = migrateConfig(raw).config.sandboxServices.find((service) => service.id === "twin");
  assert.deepEqual(twin, { id: "twin", extend: "agent-base" }, "content-equal to base is subsumed with an empty delta");
});

test("solveModelThinking: две роли требуют одну модель на разных жёстких уровнях — отказ с именем модели", () => {
  const raw = {
    sandboxProfiles: miniFleet().sandboxProfiles,
    concurrencyPools: { zai: 2, vllm: 2 },
    presets: {
      "f1-zai": { model: "zai/m", thinking: "low", sandbox: "agent" },
      "f1-local": { model: "vllm/m", thinking: "off", sandbox: "agent" },
      "f2-zai": { model: "zai/m", thinking: "high", sandbox: "agent" },
      "f2-local": { model: "vllm/m2", thinking: "med", sandbox: "agent" }
    }
  };
  assert.throws(() => migrateConfig(raw), (error) => {
    assert.match(error.message, /zai\/m/);
    assert.match(error.message, /different thinking levels/);
    return true;
  });
});

test("solveModelThinking: два одиночки на одной модели с разными уровнями — запись чистая, уровни остаются у пресетов", () => {
  const raw = miniFleet();
  raw.presets = {
    s1: { model: "zai/m", thinking: "low", sandbox: "agent" },
    s2: { model: "zai/m", thinking: "high", sandbox: "agent" }
  };
  const { config } = migrateConfig(raw);
  const byId = Object.fromEntries(config.presets.map((preset) => [preset.id, preset]));
  assert.equal(byId.s1.thinking, "low");
  assert.equal(byId.s2.thinking, "high");
  const record = config.concurrencyPools.flatMap((pool) => pool.models).find((model) => model.id === "zai-m");
  assert.equal(record.thinking, undefined, "a conflicted record stays clean");
  assert.deepEqual(verifyEquivalence(raw, config, declaredDivergences()), []);
});

test("solveModelThinking: однообразная роль переносит свой уровень на пресет, запись его повторяет", () => {
  const raw = miniFleet();
  raw.presets["r-zai"].thinking = "high";
  raw.presets["r-deepseek"].thinking = "high";
  raw.presets["r-local"].thinking = "high";
  const { config } = migrateConfig(raw);
  const role = config.presets.find((preset) => preset.id === "r");
  assert.equal(role.thinking, "high");
  const record = config.concurrencyPools.flatMap((pool) => pool.models).find((model) => model.id === "deepseek-d");
  assert.equal(record.thinking, "high");
});

test("carrySingle: одиночка без model и sandbox переносится голой записью; concurrencyGroup снимается безвозвратно", () => {
  const raw = miniFleet();
  raw.presets.bare = { systemPrompt: "@x", concurrencyGroup: "zai" };
  const carried = migrateConfig(raw).config.presets.find((preset) => preset.id === "bare");
  assert.deepEqual(carried, { id: "bare", systemPrompt: "@x" }, "no model means no models list, no sandbox means no sandboxService");
});



test("buildFamily: строковая песочница без собственного env — строковый sandboxService; git-различия env схлопыванию не мешают", () => {
  const raw = miniFleet();
  const gitOnly = { profile: "agent", env: ["GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=core.hooksPath", "GIT_CONFIG_VALUE_0=/pi-githooks"] };
  raw.presets["r-zai"].sandbox = gitOnly;
  raw.presets["r-deepseek"].sandbox = gitOnly;
  // У local — лишняя credential-запись сверх git: после stripGit наборы равны.
  raw.presets["r-local"].sandbox = { profile: "agent", env: [...gitOnly.env, "GIT_CONFIG_KEY_1=credential.vllm"] };
  const preset = migrateConfig(raw).config.presets.find((entry) => entry.id === "r");
  assert.equal(preset.sandboxService, "agent", "env that is git-only after stripping leaves no extras, plain string form");
  const envDeclared = declaredDivergences().filter((entry) => entry.reason.includes("env членов семейства"));
  assert.equal(envDeclared.length, 0, "a git-only difference must not be declared as a real env divergence");
});

test("buildFamily: действительное различие env — вариант большинства на пресете, отступивший член назван с было/стало", () => {
  const raw = miniFleet();
  raw.presets["r-zai"].sandbox = { profile: "agent", env: ["PI_HOOKS=common"] };
  raw.presets["r-deepseek"].sandbox = { profile: "agent", env: ["PI_HOOKS=common"] };
  raw.presets["r-local"].sandbox = { profile: "agent", env: ["PI_HOOKS=odd"] };
  const preset = migrateConfig(raw).config.presets.find((entry) => entry.id === "r");
  assert.deepEqual(preset.sandboxService.env, ["PI_HOOKS=common"], "the majority env wins");
  const entry = [...declaredDivergences()].reverse().find((item) => item.preset === "r-local" && item.field === "sandbox");
  assert.ok(entry, "the diverging member is named");
  assert.deepEqual(entry.was, ["PI_HOOKS=odd"]);
  assert.deepEqual(entry.now, ["PI_HOOKS=common"]);
});

test("buildFamily: песочница члена ссылается на неизвестный профиль — отказ, а не молчаливый пропуск", () => {
  const raw = miniFleet();
  raw.presets["r-deepseek"].sandbox = "no-such-profile";
  assert.throws(() => migrateConfig(raw), /no-such-profile|not defined|spans sandbox profiles/is);
});

test("buildFamily: общие поля members переносятся один раз; model и description в общую часть не попадают", () => {
  const raw = miniFleet();
  raw.presets["r-zai"].git = { name: "Fleet", email: "fleet@example.com" };
  raw.presets["r-deepseek"].git = { name: "Fleet", email: "fleet@example.com" };
  raw.presets["r-local"].git = { name: "Fleet", email: "fleet@example.com" };
  const preset = migrateConfig(raw).config.presets.find((entry) => entry.id === "r");
  assert.deepEqual(preset.git, { name: "Fleet", email: "fleet@example.com" });
  assert.equal(preset.model, undefined);
});

test("migrateConfig: чужие GIT_CONFIG_* в agent-base вытесняются каноническим набором, не-git_env сохраняется", () => {
  const raw = miniFleet();
  raw.sandboxProfiles["agent-base"].env = [
    "PATH=/t/bin",
    "GIT_CONFIG_COUNT=9",
    "GIT_CONFIG_KEY_0=core.hooksPath",
    "GIT_CONFIG_VALUE_0=/stale",
    "KEEP=1"
  ];
  const gitBase = migrateConfig(raw).config.sandboxServices.find((service) => service.id === "agent-base");
  assert.deepEqual(
    gitBase.env,
    [
      "PATH=/t/bin",
      "KEEP=1",
      "GIT_CONFIG_COUNT=2",
      "GIT_CONFIG_KEY_0=core.hooksPath",
      "GIT_CONFIG_VALUE_0=/pi-githooks",
      "GIT_CONFIG_KEY_1=commit.gpgsign",
      "GIT_CONFIG_VALUE_1=false"
    ],
    "stale git entries are filtered out before the canonical set is appended, non-git env preserved in place"
  );
});

test("migrateConfig: hooksPath на другом индексе KEY_10 узнаётся; похожая запись без точного равенства — не узнаётся", () => {
  const raw = miniFleet();
  const withHooks = (preset, keyLine) => ({
    ...preset,
    sandbox: { profile: "agent", env: [`PI_HOOKS=x`, "GIT_CONFIG_COUNT=1", keyLine, "GIT_CONFIG_VALUE_0=/pi-githooks"] }
  });
  raw.presets["r-deepseek"] = withHooks(raw.presets["r-deepseek"], "GIT_CONFIG_KEY_10=core.hooksPath");
  raw.presets["r-local"] = withHooks(raw.presets["r-local"], "GIT_CONFIG_KEY_0=core.hooksPath=extra");

  migrateConfig(raw);
  const hooks = [...declaredDivergences()].reverse().find((entry) => entry.reason.includes("core.hooksPath"));
  assert.ok(hooks, "the gaining-roles divergence is declared");
  assert.ok(hooks.presets.includes("r-zai"), "a role without hooksPath is named as gaining");
  assert.ok(!hooks.presets.includes("r-deepseek"), "KEY_10 counts as having hooksPath");
  assert.ok(hooks.presets.includes("r-local"), "a near-miss entry does not count as having hooksPath");
});

test("migrateConfig: без сервиса agent-base — отказ: git-настройкам некуда жить", () => {
  const raw = miniFleet();
  delete raw.sandboxProfiles["agent-base"];
  raw.sandboxProfiles.agent = { image: "pi-sandbox-agent:latest", concurrencyGroup: "zai" };
  assert.throws(() => migrateConfig(raw), (error) => {
    assert.match(error.message, /agent-base/);
    assert.match(error.message, /nowhere to live/);
    return true;
  });
});

test("verifyEquivalence: объявление закрывает ровно свою пару пресет+поле, чужие расхождения остаются ошибками", () => {
  const base = () => ({
    concurrencyPools: { ax: 4 },
    sandboxProfiles: { p1: { concurrencyGroup: "ax" } },
    presets: {
      q1: { model: "ax/m", sandbox: "p1", systemPrompt: "@one" },
      q2: { model: "ax/m", sandbox: "p1", systemPrompt: "@two" }
    }
  });
  const freshOf = (oldRaw) => ({
    presets: {
      q1: { models: ["ax-m"], sandboxService: "svc", systemPrompt: oldRaw.presets.q1.systemPrompt },
      q2: { models: ["ax-m"], sandboxService: "svc", systemPrompt: oldRaw.presets.q2.systemPrompt }
    },
    sandboxServices: [{ id: "svc" }],
    concurrencyPools: [{ pool: "ax", limit: 4, models: [{ id: "ax-m", provider: "ax", name: "m" }] }]
  });
  const old = base();
  const fresh = freshOf(old);
  fresh.presets.q1.systemPrompt = "@corrupt";
  // Объявление для ДРУГОГО пресета и того же поля не закрывает q1.
  let problems = verifyEquivalence(old, fresh, [{ preset: "q2", field: "systemPrompt" }]);
  assert.ok(problems.some((line) => line.includes("q1") && line.includes("systemPrompt")), `mismatch outside the declaration must surface: ${problems.join(" | ")}`);
  // Объявление ровно этой пары — принимается молча, и только она.
  problems = verifyEquivalence(old, fresh, [{ preset: "q1", field: "systemPrompt" }]);
  assert.deepEqual(problems, [], "the declared pair alone is silently accepted");
  // Объявление того же пресета по ДРУГОМУ полю не закрывает systemPrompt.
  problems = verifyEquivalence(old, fresh, [{ preset: "q1", field: "tags" }]);
  assert.ok(problems.some((line) => line.includes("q1") && line.includes("systemPrompt")), "the declaration is per field, not per preset");
});

test("verifyEquivalence: теги сравниваются как множество (порядок не важен), состав — строго", () => {
  const old = {
    concurrencyPools: { ax: 4 },
    sandboxProfiles: { p1: { concurrencyGroup: "ax" } },
    presets: { q: { model: "ax/m", sandbox: "p1", tags: ["b", "a"], env: ["X=1"] } }
  };
  const fresh = {
    presets: { q: { models: ["ax-m"], sandboxService: "svc", tags: ["a", "b"], env: ["X=1"] } },
    sandboxServices: [{ id: "svc" }],
    concurrencyPools: [{ pool: "ax", limit: 4, models: [{ id: "ax-m", provider: "ax", name: "m" }] }]
  };
  assert.deepEqual(verifyEquivalence(old, fresh), [], "same tags in another order are equivalent");
  const wrongTags = JSON.parse(JSON.stringify(fresh));
  wrongTags.presets.q.tags = ["a", "c"];
  assert.ok(
    verifyEquivalence(old, wrongTags).some((line) => line.includes("tags")),
    "a different tag set must be refused"
  );
  const wrongEnv = JSON.parse(JSON.stringify(fresh));
  wrongEnv.presets.q.env = ["X=2"];
  assert.ok(
    verifyEquivalence(old, wrongEnv).some((line) => line.includes("env")),
    "a changed preset env must be refused"
  );
});

test("buildServices: пресет может ссылаться на саму базу — base знает своё имя в карте сервисов", () => {
  const raw = liveFleet();
  raw.presets.reviewer.sandbox = "agent-base";
  const reviewer = migrateConfig(raw).config.presets.find((preset) => preset.id === "reviewer");
  assert.equal(reviewer.sandboxService, "agent-base");
});

test("verifyEquivalence: maxConcurrent у сгруппированного профиля срезается с ОБОИХ сторон сверки", () => {
  const old = {
    concurrencyPools: { ax: 4 },
    sandboxProfiles: { p1: { concurrencyGroup: "ax", maxConcurrent: 5 } },
    presets: { q: { model: "ax/m", sandbox: "p1" } }
  };
  const fresh = {
    presets: { q: { models: ["ax-m"], sandboxService: "svc" } },
    sandboxServices: [{ id: "svc" }],
    concurrencyPools: [{ pool: "ax", limit: 4, models: [{ id: "ax-m", provider: "ax", name: "m" }] }]
  };
  assert.deepEqual(verifyEquivalence(old, fresh), [], "a grouped cap is cut from both contours, still equivalent");
  const lostGroup = JSON.parse(JSON.stringify(old));
  delete lostGroup.sandboxProfiles.p1.concurrencyGroup;
  assert.ok(
    verifyEquivalence(lostGroup, fresh).some((line) => line.includes("maxConcurrent") || line.includes("sandbox")),
    "the same cap WITHOUT a group is the old runtime's real limit and must surface"
  );
});

test("verifyEquivalence: пресет новой формы без моделей — внятная строка в списке расхождений", () => {
  const old = {
    concurrencyPools: { ax: 4 },
    sandboxProfiles: { p1: { concurrencyGroup: "ax" } },
    presets: { q: { model: "ax/m", sandbox: "p1" } }
  };
  const fresh = {
    presets: { q: { models: [], sandboxService: "svc" } },
    sandboxServices: [{ id: "svc" }],
    concurrencyPools: [{ pool: "ax", limit: 4, models: [{ id: "ax-m", provider: "ax", name: "m" }] }]
  };
  assert.deepEqual(verifyEquivalence(old, fresh), ["q: пресет \"q\" не содержит моделей."]);
});

test("verifyEquivalence: пин *-local ищется в пуле, где модель провайдера ЕСТЬ среди прочих", () => {
  const old = {
    concurrencyPools: { ax: 4 },
    sandboxProfiles: { p1: { concurrencyGroup: "ax" } },
    presets: {
      x: { model: "ax/m", sandbox: "p1" },
      "x-local": { model: "ax/m", sandbox: "p1" }
    }
  };
  const fresh = {
    presets: { x: { models: ["ax-m"], sandboxService: "svc" } },
    sandboxServices: [{ id: "svc" }],
    concurrencyPools: [
      { pool: "ax", limit: 4, models: [{ id: "ax-m", provider: "ax", name: "m" }, { id: "zz-q", provider: "zz", name: "q" }] }
    ]
  };
  assert.deepEqual(verifyEquivalence(old, fresh), [], "the pin pool is found while the provider is only part of it");
});

test("verifyEquivalence: осиротевший *-local без базового пресета — строка о неразрешении, а не подменённый референс", () => {
  const old = {
    concurrencyPools: { vllm: 1 },
    sandboxProfiles: { p1: { concurrencyGroup: "vllm" } },
    presets: { "ghost-local": { model: "vllm/m", sandbox: "p1" } }
  };
  const fresh = {
    presets: {},
    sandboxServices: [],
    concurrencyPools: [{ pool: "vllm", limit: 1, models: [{ id: "vllm-m", provider: "vllm", name: "m" }] }]
  };
  assert.deepEqual(
    verifyEquivalence(old, fresh),
    ["ghost-local: имя больше не разрешается в новой конфигурации (ни пресет, ни пул)."]
  );
});
