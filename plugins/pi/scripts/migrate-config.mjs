#!/usr/bin/env node
/**
 * Migration: the historical per-provider preset fleet (20 presets on 11 roles,
 * five sandbox profiles, `concurrencyPools` as bare slot numbers) into the
 * owner form — one preset per role with a `models` list, a model registry with
 * globally unique ids, sandbox services with `extend`, pools with
 * `limit`/`priority`.
 *
 * The script NEVER writes to its input. It reads the old config, builds the
 * new one, PROVES equivalence (T-6: for every old preset name the resolved
 * model, provider, thinking, prompts, tools, mounts, skills, env, timeout, git
 * identity and the sandbox contour must be identical), prints the new config
 * and a diff. Only `--out <file>` — a path distinct from the input — writes
 * anything, and only after equivalence holds. The owner applies the diff.
 *
 * Usage:
 *   node migrate-config.mjs <old-config.json> [--out <new-config.json>] [--no-diff]
 *
 * Exit codes: 0 — equivalent, diff shown; 1 — equivalence refused (the list
 * of mismatches is printed) or a structural error; 2 — usage error.
 */

import fs from "node:fs";
import path from "node:path";

import {
  concatAdditive,
  normalizeConfigLayer,
  resolvePresetReference,
  resolveRunSettings
} from "./lib/config.mjs";
import { normalizeSandbox } from "./lib/sandbox.mjs";
import { buildVariants } from "./pi-companion.mjs";

/** Provider suffixes a historical preset name could end with, mapped to pools. */
const POOL_ALIASES = { local: "vllm" };

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The provider half of a historical `provider/model` string, or null. */
function splitModel(model) {
  if (typeof model !== "string" || !model.includes("/")) {
    return null;
  }
  const at = model.indexOf("/");
  return { provider: model.slice(0, at), name: model.slice(at + 1) };
}

/**
 * Which pool a provider belongs to. Pool names are short and live inside the
 * provider string (`zai` ⊂ `zai-coding-cn`, `vllm` ⊂ `vllm`); longest match
 * wins so a hypothetical `zai2` pool would not be swallowed by `zai`.
 */
function poolOfProvider(provider, poolNames) {
  const matches = [...poolNames].filter((pool) => provider === pool || provider.includes(pool));
  if (!matches.length) {
    return null;
  }
  return matches.sort((a, b) => b.length - a.length)[0];
}

/** Global model id: `<pool>-<name>`, per the owner form. */
function modelId(pool, name) {
  return `${pool}-${name}`;
}

/**
 * Описание роли — самое частое описание семейства, а НЕ общий префикс символов.
 *
 * Префикс режет фразу по месту, где разошлись строки: у живого семейства два
 * члена описаны одинаково, а третий добавляет «— на локальной модели vLLM», и
 * общий префикс дал «…юнит-тесты, гейты,» — оборванное на запятой описание,
 * которое человек читает в списке пресетов. Берём описание большинства целиком;
 * различие членов видно из моделей роли, а не из огрызка фразы.
 */
function commonDescription(descriptions) {
  const texts = descriptions.filter((text) => typeof text === "string" && text.trim());
  if (!texts.length) {
    return undefined;
  }
  const ranked = [...new Set(texts)]
    .map((text) => [text, texts.filter((other) => other === text).length])
    .sort((a, b) => b[1] - a[1] || texts.indexOf(a[0]) - texts.indexOf(b[0]));
  return ranked[0][0].trim();
}

/**
 * Read the historical config into its normalized shape: presets, profiles
 * (`extend` already read as `profile`) and pools as objects.
 */
function loadOldConfig(raw) {
  const config = normalizeConfigLayer(raw);
  if (!isPlainObject(config.presets) || !Object.keys(config.presets).length) {
    throw new Error("No presets found in the config — nothing to migrate.");
  }
  return config;
}

/**
 * Group historical presets into roles.
 *
 * A preset whose name ends in `-<pool>` (or `-<alias>` — the fleet says
 * `*-local`, the pool is `vllm`) is a family member of `<role>`; the rest are
 * singles carried as they are. Returns `{ families: Map<role, Map<pool, {name,
 * preset}>>, singles: Map<name, preset> }`.
 */
function groupByRole(presets, pools) {
  const families = new Map();
  const singles = new Map();
  for (const [name, preset] of Object.entries(presets)) {
    let matched = null;
    for (const tail of [...Object.keys(pools), ...Object.keys(POOL_ALIASES)]) {
      if (name.endsWith(`-${tail}`)) {
        matched = { role: name.slice(0, -(tail.length + 1)), pool: POOL_ALIASES[tail] ?? tail };
        break;
      }
    }
    if (!matched || !matched.role) {
      singles.set(name, preset);
      continue;
    }
    if (!families.has(matched.role)) {
      families.set(matched.role, new Map());
    }
    const members = families.get(matched.role);
    if (members.has(matched.pool)) {
      throw new Error(`Two presets resolve to role "${matched.role}" pool "${matched.pool}": "${members.get(matched.pool).name}" and "${name}".`);
    }
    members.set(matched.pool, { name, preset });
  }
  return { families, singles };
}

/**
 * Build the model registry: one record per distinct `provider/name` the fleet
 * uses, sitting in the pool its provider belongs to.
 *
 * `thinking` and `tags` are filled in later by the families whose members
 * differed on them — that is the difference that would not survive collapsing
 * unless it moved onto the model record.
 */
function buildPools(config, poolOrder) {
  const presets = { ...config.presets };
  const used = new Map(); // `${provider}/${name}` → {provider, name, pools:Set}
  for (const preset of Object.values(presets)) {
    // `model2` is deliberately absent: it is a rudiment nothing reads, and a
    // rudiment must not seed a registry record (T-7).
    for (const model of [preset.model]) {
      const split = splitModel(model);
      if (!split) {
        continue;
      }
      const key = `${split.provider}/${split.name}`;
      if (!used.has(key)) {
        used.set(key, { ...split, pools: new Set() });
      }
    }
  }
  for (const entry of used.values()) {
    for (const pool of poolOrder) {
      if (poolOfProvider(entry.provider, [pool]) === pool) {
        entry.pools.add(pool);
      }
    }
    if (!entry.pools.size) {
      throw new Error(`Model "${entry.provider}/${entry.name}" matches none of the configured pools.`);
    }
    // Двусмысленный провайдер делает пул модели неопределённым: реестр расселил
    // бы запись в оба пула (две записи с разными id), а сверка эквивалентности
    // не смогла бы сказать, куда переехали слоты старого имени. Отказ в одну
    // сторону лучше двух молчаливых разных ответов.
    if (entry.pools.size > 1) {
      throw new Error(
        `Model "${entry.provider}/${entry.name}" matches more than one pool (${[...entry.pools].sort().join(", ")}). ` +
          "Rename the provider or the pool so every model belongs to exactly one."
      );
    }
  }

  const poolsOut = poolOrder.map((pool) => {
    const old = isPlainObject(config.concurrencyPools?.[pool]) ? config.concurrencyPools[pool] : { limit: config.concurrencyPools?.[pool] };
    const limit = Number(old?.limit);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`Pool "${pool}" has no usable slot limit; the new form requires one.`);
    }
    const models = [...used.values()]
      .filter((entry) => entry.pools.has(pool))
      .map((entry) => ({ id: modelId(pool, entry.name), provider: entry.provider, name: entry.name }));
    return {
      pool,
      limit,
      // The owner's example keeps every pool at the same priority and orders
      // candidates by the preset's model list; the number stays configurable.
      priority: Number.isFinite(Number(old?.priority)) ? Number(old.priority) : 10,
      models
    };
  });
  return { poolsOut, used };
}

/**
 * Resolve each historical profile to its full content (inheritance folded in),
 * minus the provider dimension — `concurrencyGroup` and the per-profile
 * concurrency limit derived from it. Both are carried by the pool of the model
 * a preset resolves to in the new form (epic D-07: slots come from the pool,
 * the service describes only the container), so they must never take part in
 * the collapse decision nor survive into the output.
 */
const POOL_PORTABLE_FIELDS = ["concurrencyGroup", "maxConcurrent"];

function resolvedProfiles(config) {
  const resolved = new Map();
  for (const [name, profile] of Object.entries(config.sandboxProfiles ?? {})) {
    const full = normalizeSandbox(name, config.sandboxProfiles ?? {});
    // Старый рантайм чтит собственный лимит профиля именно БЕЗ группы
    // (applyConcurrencyPool: нет группы — песочница как есть). В новой форме
    // слоты всегда приходят из пула и перекрывают сервисный лимит, поэтому
    // перенести такой кап некуда — молча снять его значит сменить слотовый
    // учёт без ведома владельца.
    if (full.maxConcurrent !== undefined && full.concurrencyGroup === undefined) {
      throw new Error(
        `Sandbox profile "${name}" sets maxConcurrent (= ${JSON.stringify(full.maxConcurrent)}) without a concurrencyGroup. ` +
          "The new form takes slots from the model's pool, so this standalone cap would be lost — " +
          "drop the cap or give the profile a group by hand."
      );
    }
    for (const field of POOL_PORTABLE_FIELDS) {
      delete full[field];
    }
    delete full.profileName;
    resolved.set(name, full);
  }
  return resolved;
}

/**
 * Collapse the profiles into the minimal service set.
 *
 * Profiles with identical resolved content share one service; a service whose
 * content is a superset of the base's is written as `extend: base` plus the
 * delta, otherwise standalone (additive `extend` cannot express a smaller
 * list). The base is the profile other profiles inherit from, named `-base`
 * by convention; its own name is kept.
 *
 * The base never absorbs another profile, even a content-equal one: the base
 * service is the extend root, and a profile the owner declared separately
 * (`agent-lite` — `agent-base` without the dind equipment) names a service
 * they expect to see in the output. Content-equal non-base profiles still
 * share one service; that is what folds the per-provider trio (`agent-dind`,
 * `agent-dind-vllm`, `agent-deepseek` — byte-identical over `agent` apart
 * from `concurrencyGroup`) into the single dind service.
 */
function buildServices(config) {
  const resolved = resolvedProfiles(config);
  const names = [...resolved.keys()];
  if (!names.length) {
    return { services: [], serviceOf: new Map() };
  }
  const baseName = names.find((name) => name.endsWith("-base")) ?? names[0];
  const base = resolved.get(baseName);

  const groups = new Map(); // JSON of resolved content → representative name
  for (const [name, content] of resolved) {
    if (name === baseName) {
      continue;
    }
    const key = JSON.stringify(content);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(name);
  }

  const services = [];
  const serviceOf = new Map();
  // The base is written as the owner wrote it, not as the defaults-filled
  // resolved blob: `normalizeSandbox` folds SANDBOX_DEFAULTS in, and the owner
  // form should name only what the fleet itself chose.
  {
    const { profile, concurrencyGroup, maxConcurrent, ...own } = isPlainObject(config.sandboxProfiles?.[baseName])
      ? config.sandboxProfiles[baseName]
      : { ...base };
    services.push({ id: baseName, ...own });
    serviceOf.set(baseName, baseName);
  }
  for (const [, members] of groups) {
    // Shortest member name reads best as a service id (`agent`, not `agent-dind-vllm`).
    const canonical = [...members].sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0];
    const content = resolved.get(canonical);
    const delta = {};
    for (const [key, value] of Object.entries(content)) {
      if (key === "profile") {
        continue;
      }
      if (Array.isArray(value)) {
        const inherited = Array.isArray(base[key]) ? base[key] : [];
        const extra = value.filter((entry) => !inherited.some((item) => deepEqual(item, entry)));
        if (extra.length) {
          delta[key] = extra;
        }
        continue;
      }
      if (!deepEqual(base[key], value)) {
        delta[key] = value;
      }
    }
    const subsumed = Object.entries(base).every(([key, value]) =>
      Array.isArray(value) ? true : deepEqual(content[key] ?? value, value)
    );
    services.push(subsumed ? { id: canonical, extend: baseName, ...delta } : { id: canonical, ...content });
    for (const member of members) {
      serviceOf.set(member, canonical);
    }
  }
  return { services, serviceOf };
}

/**
 * Fold a family into one role preset.
 *
 * Fields all members share carry over once; `thinking` and `tags` that
 * differed go onto the model records; `description` folds to the common
 * prefix. Returns `{ preset, modelOverrides: Map<modelKey, {thinking?, tags?}>
 * }`.
 */
/**
 * Имя профиля песочницы, на который ссылается пресет.
 *
 * Старая форма допускает и строку (`"sandbox": "agent-dind"`), и объект
 * (`"sandbox": {"profile": "agent-dind", "env": [...]}`), и живая конфигурация
 * пользуется ИМЕННО объектной: в ней же лежат пер-ролевые PI_HOOKS. Прежний
 * `String(preset.sandbox)` на объекте давал "[object Object]", карта сервисов
 * возвращала undefined, и миграция отказывала на каждой роли живого конфига —
 * при том что на фикстуре со строковыми ссылками проходила.
 */
/**
 * Осознанно снятые различия: печатаются громко и не валят сверку.
 *
 * Отказ — правильная реакция на различие, которого не должно быть; но упираться
 * в ОДНУ строку живой конфигурации значит блокировать миграцию целиком. Такое
 * различие снимается, называется в предъявляемом диффе и регистрируется здесь,
 * чтобы сверка не принимала его ни за ошибку, ни за «всё совпало». Молчания нет
 * ни в одном из двух направлений.
 */
const DECLARED = [];

/**
 * Git-настройки переносятся ОДИН РАЗ в сервис agent-base, полным набором —
 * у роли их быть не должно (см. carrySandbox): протокол позиционный, слияние
 * по имени переменной, второй источник дал бы затёртый COUNT и KEY_0.
 */
const GIT_ENV_ENTRY_RE = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)=/;
const GIT_BASE_SERVICE = "agent-base";
const GIT_BASE_ENV = [
  "GIT_CONFIG_COUNT=2",
  "GIT_CONFIG_KEY_0=core.hooksPath",
  "GIT_CONFIG_VALUE_0=/pi-githooks",
  "GIT_CONFIG_KEY_1=commit.gpgsign",
  "GIT_CONFIG_VALUE_1=false"
];

/** Копия объявленных расхождений: тест обязан проверять, что различие НАЗВАНО. */
export function declaredDivergences() {
  return DECLARED.map((entry) => ({ ...entry }));
}

function profileNameOf(sandbox) {
  if (typeof sandbox === "string") {
    return sandbox;
  }
  if (isPlainObject(sandbox) && typeof sandbox.profile === "string") {
    return sandbox.profile;
  }
  return null;
}

/**
 * Собственные поля песочницы пресета поверх профиля (`env` с пер-ролевыми
 * PI_HOOKS и GIT_CONFIG_*). Это ИМУЩЕСТВО РОЛИ, а не сервиса: сервис описывает
 * контейнер, набор хуков — роль, поэтому переносить его нужно на пресет, а не
 * вливать в общий sandboxService.
 */
function sandboxExtrasOf(sandbox) {
  if (!isPlainObject(sandbox)) {
    return null;
  }
  const { profile, ...rest } = sandbox;
  return Object.keys(rest).length ? rest : null;
}

/**
 * Перенос ссылки на песочницу в новую форму: ссылка всегда каноничная
 * `sandboxService`; собственные поля роли (env с PI_HOOKS) требуют объектной
 * формы `{id: <сервис>, ...env}` — только так `normalizeSandbox` соберёт тот
 * же контур, что был у старого имени.
 *
 * Git-настройки (GIT_CONFIG_COUNT/KEY_N/VALUE_N) из env роли УБИРАЮТСЯ: это
 * позиционный протокол, слияние идёт по имени переменной, и роль со своими
 * записями рядом с сервисом затёрла бы COUNT и KEY_0 — обрезанная git-конфига.
 * Полный набор (hooksPath + gpgsign) живёт в ОДНОМ месте — сервисе agent-base
 * (см. migrateConfig), а у роли остаётся только её PI_HOOKS.
 */
function carrySandbox(preset, serviceOf, label) {
  const service = serviceOf.get(profileNameOf(preset.sandbox) ?? "");
  if (!service) {
    throw new Error(`${label}: sandbox profile "${JSON.stringify(preset.sandbox)}" is not defined.`);
  }
  const extras = sandboxExtrasOf(preset.sandbox);
  if (extras?.env) {
    const env = extras.env.filter((entry) => !GIT_ENV_ENTRY_RE.test(String(entry)));
    if (env.length) {
      extras.env = env;
    } else {
      delete extras.env;
    }
    if (!Object.keys(extras).length) {
      return { sandboxService: service };
    }
  }
  return { sandboxService: extras ? { id: service, ...extras } : service };
}

function buildFamily(role, members, priorities, serviceOf) {
  const entries = [...members.values()];
  const names = entries.map((member) => member.name);
  const presets = entries.map((member) => member.preset);

  const services = new Set(entries.map((member) => serviceOf.get(profileNameOf(member.preset.sandbox) ?? "")));
  if (services.size > 1 || [...services][0] === undefined) {
    throw new Error(
      `Role "${role}" spans sandbox profiles that do not collapse into one service (${names.join(", ")}). ` +
        "Equivalence could not hold for every old name; the profiles must be reconciled by hand."
    );
  }

  // Собственный env роли у всех членов семейства общий (это env РОЛИ, а не
  // провайдера); расхождение — признак того, что схлопывать нельзя. Сравниваются
  // добавки УЖЕ без git-записей: они снимаются с ролей в любом случае (уходят в
  // agent-base), и различие только в них схлопыванию не мешает — в живой
  // конфигурации именно так различался web-developer-local.
  const stripGit = (extras) => {
    if (!extras?.env) {
      return extras;
    }
    const env = extras.env.filter((entry) => !GIT_ENV_ENTRY_RE.test(String(entry)));
    const rest = { ...extras, env };
    if (!env.length) {
      delete rest.env;
    }
    return rest;
  };
  const extrasList = entries.map((member) => stripGit(sandboxExtrasOf(member.preset.sandbox)) ?? {});
  // Различие собственного env внутри семейства встречается в живой конфигурации
  // ОДИН раз (у одного члена лишний core.hooksPath, которого нет у братьев), и
  // отказ на этом месте блокирует миграцию целиком. Берём вариант большинства, а
  // снятое различие объявляем громко: дифф предъявляется владельцу, решение его.
  let sharedIndex = 0;
  if (extrasList.some((extras) => !deepEqual(extras, extrasList[0]))) {
    const ranked = extrasList
      .map((extras, index) => [index, extrasList.filter((other) => deepEqual(other, extras)).length])
      .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    sharedIndex = ranked[0][0];
    entries.forEach((member, index) => {
      if (deepEqual(extrasList[index], extrasList[sharedIndex])) {
        return;
      }
      DECLARED.push({
        preset: member.name,
        field: "sandbox",
        reason: `роль "${role}" схлопывается в один пресет, а собственный env членов семейства различался`,
        was: extrasList[index].env ?? extrasList[index],
        now: extrasList[sharedIndex].env ?? extrasList[sharedIndex]
      });
    });
  }
  const sharedExtras = Object.keys(extrasList[sharedIndex]).length ? extrasList[sharedIndex] : null;

  const sameForAll = (key) => presets.every((preset) => deepEqual(preset[key], presets[0][key]));
  const common = {};
  for (const key of Object.keys(presets[0])) {
    // thinking не переносится «просто общим»: он разрешается глобально по всем
    // пользователям модели (см. solveModelThinking) — иначе уровень одиночки
    // затекает в модельную запись, построенную по чужому семейству.
    if (key === "model" || key === "model2" || key === "sandbox" || key === "description" || key === "concurrencyGroup" || key === "thinking") {
      continue;
    }
    if (sameForAll(key)) {
      common[key] = presets[0][key];
    }
  }

  const modelOverrides = new Map();
  // Общая часть тегов роли — пересечение членов; она остаётся на пресете —
  // единственном месте, где теги ещё живут. Различие члена сверх пересечения
  // раньше переезжало на запись модели (solveModelTags); записи моделей сняты
  // владельцем вместе с ними, поэтому надбавка пропадает — и обязана быть
  // НАЗВАНА громко, а не стерта молча.
  const tagLists = presets.map((preset) => (Array.isArray(preset.tags) ? preset.tags : []));
  const tagsCommon = tagLists[0].filter((tag) => tagLists.every((list) => list.includes(tag)));
  if (tagsCommon.length) {
    common.tags = tagsCommon;
  }
  entries.forEach((member, index) => {
    const extra = tagLists[index].filter((tag) => !tagsCommon.includes(tag));
    if (extra.length) {
      DECLARED.push({
        preset: member.name,
        field: "tags",
        reason: `метка ${JSON.stringify(extra)} жила на записи модели — записи моделей сняты владельцем, теги остались только у пресета`,
        was: tagLists[index],
        now: tagsCommon
      });
    }
  });

  // Требование роли к уровню thinking модели: у неоднообразного семейства —
  // жёсткое (иначе различие членов не переживёт схлопывания), у однообразного
  // — мягкое (уровень уже сидит на пресете, запись может его лишь повторять).
  const uniformThinking = sameForAll("thinking") ? presets[0].thinking : undefined;
  const thinkingDemands = new Map(
    entries.map((member) => {
      const split = splitModel(member.preset.model);
      return [`${split.provider}/${split.name}`, { hard: uniformThinking === undefined, value: member.preset.thinking, name: member.name }];
    })
  );

  // Preference order: the pool's priority, BIGGER first (10 beats 1); equal
  // priorities keep the listing the owner's example asks for — local vLLM last.
  const poolRank = new Map(
    [...priorities.keys()].sort((a, b) => Number(a === "vllm") - Number(b === "vllm")).map((pool, index) => [pool, index])
  );
  const ordered = [...members.entries()].sort(
    (a, b) => (priorities.get(b[0]) ?? 0) - (priorities.get(a[0]) ?? 0) || (poolRank.get(a[0]) ?? 0) - (poolRank.get(b[0]) ?? 0)
  );

  const preset = {
    id: role,
    models: ordered.map(([pool, member]) => modelId(pool, splitModel(member.preset.model).name)),
    ...carrySandbox(entries[0].preset, serviceOf, `Role "${role}"`),
    ...common
  };
  if (presets.some((preset) => preset.description !== undefined)) {
    const description = commonDescription(presets.map((preset) => preset.description ?? ""));
    if (description) {
      preset.description = description;
    }
  }
  return { preset, names, role, uniformThinking, thinkingDemands };
}

/**
 * Разрешает thinking модельных записей по требованиям ВСЕХ пользователей
 * модели — членов семейств и одиночек. Запись одна на модель, а её thinking
 * переопределяет пресетный, поэтому уровень с записи, построенной по одному
 * семейству, затекал в одиночку с другим уровнем (researcher high получал low
 * от flash-записи). Правило: запись получает уровень только когда все
 * пользователи согласны; при конфликте запись остаётся чистой — семейство
 * переносит свой уровень на пресет, одиночка сохраняет собственный.
 */
function solveModelThinking(familyPlans, singles) {
  const demands = new Map();
  const add = (key, demand) => {
    if (!demands.has(key)) {
      demands.set(key, []);
    }
    demands.get(key).push(demand);
  };
  for (const plan of familyPlans) {
    for (const [key, demand] of plan.thinkingDemands) {
      add(key, { ...demand, role: plan.role });
    }
  }
  for (const [name, preset] of singles) {
    const split = splitModel(preset.model);
    if (!split) {
      continue;
    }
    add(`${split.provider}/${split.name}`, { hard: false, value: preset.thinking, name, role: name });
  }

  const resolved = new Map();
  const familyFallbacks = new Map();
  for (const [key, list] of demands) {
    const hardValues = new Set(list.filter((demand) => demand.hard).map((demand) => demand.value));
    if (hardValues.size > 1) {
      const named = list.filter((demand) => demand.hard).map((demand) => `${demand.name} (${demand.value})`).join(", ");
      throw new Error(
        `Model "${key}" is demanded at different thinking levels by ${named} — ` +
          "one model record cannot carry both; reconcile the roles by hand."
      );
    }
    let value;
    if (hardValues.size === 1) {
      const [v] = hardValues;
      value = list.every((demand) => demand.value === v) ? v : undefined;
    } else {
      const soft = list.map((demand) => demand.value);
      value = soft.every((level) => level === soft[0]) ? soft[0] : undefined;
    }
    resolved.set(key, value);
    if (value === undefined) {
      for (const demand of list) {
        if (!demand.hard) {
          continue;
        }
        if (!familyFallbacks.has(demand.role)) {
          familyFallbacks.set(demand.role, new Set());
        }
        familyFallbacks.get(demand.role).add(demand.value);
      }
    }
  }

  for (const plan of familyPlans) {
    if (plan.uniformThinking !== undefined) {
      plan.preset.thinking = plan.uniformThinking;
      continue;
    }
    const required = familyFallbacks.get(plan.role);
    if (!required) {
      continue;
    }
    if (required.size > 1) {
      throw new Error(
        `Role "${plan.role}" members need different preset thinking (${[...required].join(", ")}) ` +
          "after conflicting model records were kept clean — the role cannot collapse."
      );
    }
    plan.preset.thinking = [...required][0];
  }
  return resolved;
}

/**
 * Apply the globally solved thinking levels to the registry records. Tags are
 * not among the overrides: model records no longer carry any (owner decision),
 * tags live on the preset alone.
 */
function applyModelOverrides(pools, thinkingById) {
  for (const pool of pools) {
    for (const model of pool.models) {
      const key = `${model.provider}/${model.name}`;
      const thinking = thinkingById.get(key);
      if (thinking !== undefined) {
        model.thinking = thinking;
      }
    }
  }
}

/** Carry a single (non-family) preset over, translated to the owner form. */
function carrySingle(name, preset, serviceOf, poolNames) {
  const carried = { id: name };
  const split = splitModel(preset.model);
  if (split) {
    const pool = poolOfProvider(split.provider, poolNames);
    if (!pool) {
      throw new Error(`Single preset "${name}": model "${preset.model}" matches no pool.`);
    }
    carried.models = [modelId(pool, split.name)];
  }
  if (preset.sandbox !== undefined) {
    Object.assign(carried, carrySandbox(preset, serviceOf, `Single preset "${name}"`));
  }
  for (const [key, value] of Object.entries(preset)) {
    if (key === "model" || key === "sandbox" || key === "concurrencyGroup") {
      continue;
    }
    carried[key] = value;
  }
  return carried;
}

/**
 * Collect the paths of every `concurrencyGroup` left in a document. The field
 * is the provider dimension the pool takes over (epic D-07), so the migrated
 * output must not carry it anywhere — services, pools or presets alike.
 */
function findConcurrencyGroups(value, pathSoFar, found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findConcurrencyGroups(entry, `${pathSoFar}[${index}]`, found));
  } else if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "concurrencyGroup") {
        found.push(`${pathSoFar}.${key}`);
      }
      findConcurrencyGroups(entry, `${pathSoFar}.${key}`, found);
    }
  }
  return found;
}

/**
 * Migrate the old config into the owner form. Returns
 * `{ config, dropped, serviceOf }`; `config` is the plain JSON-serializable
 * object with the three blocks as arrays.
 */
export function migrateConfig(raw) {
  const config = loadOldConfig(raw);
  const poolNames = Object.keys(config.concurrencyPools ?? {});
  const poolOrder = [...poolNames].sort((a, b) => (a === "vllm" ? 1 : 0) - (b === "vllm" ? 1 : 0));

  const { families, singles } = groupByRole(config.presets, config.concurrencyPools ?? {});
  // A single named exactly like a family's role collides with the family's
  // collapsed id: presets "dev" and "dev-vllm" would both emit id "dev" and
  // die later in the normalizer with a raw `Duplicate id "dev"` that names
  // neither source. Refuse here, naming both names and the way out.
  for (const [role, members] of families) {
    if (singles.has(role)) {
      const familyNames = [...members.values()].map((member) => `"${member.name}"`).join(", ");
      throw new Error(
        `Presets "${role}" and ${familyNames} would all collapse into preset id "${role}": ` +
          `"${role}" is read as a standalone preset, while the others read as the role "${role}" pinned to a pool. ` +
          "Rename one of them."
      );
    }
  }
  const { services, serviceOf } = buildServices(config);
  // Git-настройки действуют для ВСЕХ ролей и живут в одном месте — в базе,
  // которую все сервисы наследуют. /pi-githooks в этом сервисе уже смонтирован.
  const gitBase = services.find((service) => service.id === GIT_BASE_SERVICE);
  if (!gitBase) {
    throw new Error(
      `Service "${GIT_BASE_SERVICE}" is not defined: the shared git settings ` +
        "(core.hooksPath, commit.gpgsign) have nowhere to live, and a per-role copy would collide on GIT_CONFIG_COUNT."
    );
  }
  gitBase.env = [
    ...(gitBase.env ?? []).filter((entry) => !GIT_ENV_ENTRY_RE.test(String(entry))),
    ...GIT_BASE_ENV
  ];
  // Роли, у которых core.hooksPath не было, теперь его ПОЛУЧАЮТ — это
  // изменение поведения, владелец его принял осознанно. Объявляется ОДНОЙ
  // строкой громкого списка, а в сверке эквивалентности закрывает поле sandbox
  // ровно затронутых старых имён, не ослабляя сравнение для остальных.
  const roleIdOf = new Map();
  for (const [role, members] of families) {
    for (const member of members.values()) {
      roleIdOf.set(member.name, role);
    }
  }
  for (const name of singles.keys()) {
    roleIdOf.set(name, name);
  }
  const hadHooks = (name) =>
    (config.presets[name]?.sandbox?.env ?? []).some((entry) =>
      /^GIT_CONFIG_KEY_\d+=core\.hooksPath$/.test(String(entry))
    );
  const gainingHooks = [...roleIdOf.keys()].filter((name) => !hadHooks(name));
  if (gainingHooks.length) {
    const roles = [...new Set(gainingHooks.map((name) => roleIdOf.get(name)))];
    DECLARED.push({
      preset: `роли: ${roles.join(", ")}`,
      field: "sandbox",
      reason: "core.hooksPath=/pi-githooks перенесён в сервис agent-base и теперь действует для всех ролей — у перечисленных его не было; поведение меняется осознанно",
      presets: gainingHooks
    });
  }
  const { poolsOut } = buildPools(config, poolOrder);
  const priorities = new Map(poolsOut.map((pool) => [pool.pool, pool.priority]));

  const dropped = [];
  // Named, not silently dropped: the field is read by nothing today, but the
  // owner has to see it disappear from their fleet's config (T-7).
  for (const [name, preset] of Object.entries(config.presets)) {
    if (preset.model2 !== undefined) {
      dropped.push(`presets.${name}.model2 (= ${JSON.stringify(preset.model2)}) — не читается ничем, снят`);
    }
    if (preset.concurrencyGroup !== undefined) {
      dropped.push(
        `presets.${name}.concurrencyGroup (= ${JSON.stringify(preset.concurrencyGroup)}) — ушёл в пул выбранной модели`
      );
    }
  }
  const presetsOut = [];
  const familyPlans = [];
  for (const [role, members] of families) {
    const plan = buildFamily(role, members, priorities, serviceOf);
    familyPlans.push(plan);
  }
  const thinkingById = solveModelThinking(familyPlans, singles);
  for (const plan of familyPlans) {
    presetsOut.push(plan.preset);
  }
  applyModelOverrides(poolsOut, thinkingById);

  for (const [name, preset] of singles) {
    presetsOut.push(carrySingle(name, preset, serviceOf, poolNames));
  }

  const newConfig = { ...raw };
  delete newConfig.concurrencyPools;
  delete newConfig.sandboxProfiles;
  delete newConfig.presets;
  newConfig.sandboxServices = services;
  newConfig.concurrencyPools = poolsOut;
  newConfig.presets = presetsOut;

  // Hard invariant of the target form: slots come from the pool of the chosen
  // model, so the provider dimension has no business anywhere in the output.
  // A leak here would silently resurrect per-profile slot accounting next to
  // the pool's.
  const leaks = findConcurrencyGroups(newConfig, "config");
  if (leaks.length) {
    throw new Error(
      `Internal error: the migrated config still carries concurrencyGroup at ${leaks.join(", ")}. ` +
        "Slots belong to the model pool in the new form."
    );
  }

  return { config: newConfig, dropped, serviceOf };
}

/**
 * Equivalence proof (T-6). For every historical preset name, resolve it in the
 * NEW config (the tail names the pool itself; `*-local` does not resolve
 * anymore — its pin is derived from the old preset's own model) and compare
 * what a run would actually get against the old config's answer.
 *
 * Returns a list of mismatch descriptions; empty means equivalent.
 */
export function verifyEquivalence(oldRaw, newRaw, declared = []) {
  const old = normalizeConfigLayer(oldRaw);
  const fresh = normalizeConfigLayer(JSON.parse(JSON.stringify(newRaw)));
  const problems = [];
  // Объявленное расхождение не ошибка и не совпадение: его печатает отдельный
  // громкий список, поэтому здесь оно молча пропускается ровно по своей паре
  // «пресет + поле», а не по пресету целиком. Одна запись может объявлять
  // сразу несколько старых имён (поле `presets`) — например, общую для всех
  // ролей передачу git-настроек сервису.
  const accepted = new Set();
  for (const entry of declared) {
    for (const preset of entry.presets ?? [entry.preset]) {
      accepted.add(`${preset}|${entry.field}`);
    }
  }

  for (const name of Object.keys(old.presets ?? {})) {
    let reference = resolvePresetReference(fresh, name);
    if (!reference) {
      // `*-local` больше не разрешается: aliases пула сняты владельцем. Сверка
      // всё равно обязана доказать, что контур роли переехал: пин берём не из
      // хвоста имени, а из собственной модели старого пресета.
      const oldPreset = old.presets[name] ?? {};
      const split = splitModel(oldPreset.model);
      const base = Object.keys(fresh.presets ?? {}).find((id) => name.startsWith(`${id}-`));
      const pin =
        split &&
        Object.values(fresh.concurrencyPools ?? {}).find((pool) =>
          Object.values(pool.models ?? {}).some((model) => model.provider === split.provider)
        );
      if (base && pin) {
        reference = { preset: fresh.presets[base], presetName: base, requestedName: name, poolPin: pin.pool };
      }
    }
    if (!reference) {
      problems.push(`${name}: имя больше не разрешается в новой конфигурации (ни пресет, ни пул).`);
      continue;
    }
    const oldSettings = resolveRunSettings(old, "delegate", { preset: name });
    // The new settings resolve under the NAME THE NEW CONFIG ANSWERS TO, not
    // the requested one: `*-local` no longer resolves by design, and the pin
    // (fallback above) already carries the old name's pool choice.
    const newSettings = resolveRunSettings(fresh, "delegate", { preset: reference.presetName });
    const { variants } = buildVariants(reference.preset, fresh, { poolPin: reference.poolPin });
    if (!variants.length) {
      problems.push(`${name}: пресет "${reference.presetName}" не содержит моделей.`);
      continue;
    }
    const variant = variants[0];

    const check = (field, oldValue, newValue) => {
      if (accepted.has(`${name}|${field}`)) {
        return;
      }
      if (!deepEqual(oldValue, newValue)) {
        problems.push(
          `${name}: ${field} расходится — старая ${JSON.stringify(oldValue)}, новая ${JSON.stringify(newValue)}.`
        );
      }
    };

    check("model", oldSettings.model, variant.model);
    // The historical preset carries `provider/model` as one string and the
    // provider is read off its prefix at run time; the new form resolves the
    // same pair from the model record.
    const oldProvider = splitModel(old.presets[name]?.model)?.provider ?? oldSettings.provider;
    check("provider", oldProvider, variant.provider);
    check(
      "thinking",
      oldSettings.thinking,
      variant.thinking ?? newSettings.thinking
    );
    const tagsOf = (value) => [...(Array.isArray(value) ? value : [])].sort();
    // Model records carry no tags anymore, so the preset's list is the whole
    // answer; a role whose old tags exceeded the collapsed preset's common
    // part shows up as a DECLARED divergence, not as a silent drop.
    check("tags", tagsOf(oldSettings.tags), tagsOf(newSettings.tags));
    for (const field of [
      "systemPrompt",
      "appendSystemPrompt",
      "tools",
      "excludeTools",
      "readOnly",
      "extensions",
      "skills",
      "mounts",
      "git",
      "budget",
      "engine",
      "timeoutMs"
    ]) {
      check(field, oldSettings[field], newSettings[field]);
    }
    if (!deepEqual(old.presets[name]?.env ?? null, fresh.presets?.[reference.presetName]?.env ?? null)) {
      check("env", old.presets[name]?.env ?? null, fresh.presets?.[reference.presetName]?.env ?? null);
    }

    const contour = (config, sandbox) => {
      if (sandbox == null) {
        return null;
      }
      const full = normalizeSandbox(sandbox, config.sandboxProfiles ?? {});
      // maxConcurrent срезается только вместе с группой: у профиля без группы
      // собственный лимит — то, что старый рантайм реально чтит, и сверка
      // обязана видеть его расхождение, а не слепо стирать.
      const grouped = full.concurrencyGroup != null;
      delete full.concurrencyGroup;
      if (grouped) {
        delete full.maxConcurrent;
      }
      // env сравнивается как множество name=value: порядок переменных семантики
      // не несёт, а после переноса git-записей в agent-base он и не может
      // совпасть байт-в-байт — набор обязан, порядок нет.
      if (Array.isArray(full.env)) {
        full.env = [...full.env].sort();
      }
      delete full.profileName;
      return full;
    };
    check("sandbox", contour(old, oldSettings.sandbox), contour(fresh, newSettings.sandbox));

    // The provider dimension moved from the profile to the pool: whatever slot
    // group the old name drew through its sandbox profile must now equal the
    // pool of the model it resolves to. Pool aliases are gone; the pool is
    // addressed only by its own name.
    const oldSandbox = old.presets[name]?.sandbox;
    const oldSandboxProfile = profileNameOf(oldSandbox);
    if (oldSandboxProfile && old.sandboxProfiles?.[oldSandboxProfile]) {
      const group = normalizeSandbox(oldSandboxProfile, old.sandboxProfiles ?? {}).concurrencyGroup;
      if (group != null) {
        // Фактический пул варианта уже вычислен buildVariants из реестра;
        // прежний скан «первый пул, где есть провайдер» давал ложный пропуск и
        // ложный отказ, когда провайдер мог бы попасться в двух пулах.
        const pool = Object.values(fresh.concurrencyPools ?? {}).find((entry) => entry.pool === variant.pool);
        if (!pool) {
          problems.push(`${name}: модель "${variant.model}" не входит ни в один пул новой конфигурации.`);
        } else if (pool.pool !== group) {
          problems.push(
            `${name}: группа слотов "${group}" профиля "${oldSandbox}" не совпадает с пулом "${pool.pool}" модели "${variant.model}".`
          );
        }
      }
    }
  }
  return problems;
}

/** Minimal line diff (LCS) between two strings, unified-style. */
export function lineDiff(before, after, labelBefore = "old", labelAfter = "new") {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines = [`--- ${labelBefore}`, `+++ ${labelAfter}`];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push(`- ${a[i]}`);
      i += 1;
    } else {
      lines.push(`+ ${b[j]}`);
      j += 1;
    }
  }
  while (i < n) {
    lines.push(`- ${a[i]}`);
    i += 1;
  }
  while (j < m) {
    lines.push(`+ ${b[j]}`);
    j += 1;
  }
  return lines.join("\n");
}

function usage() {
  return "usage: migrate-config.mjs <old-config.json> [--out <new-config.json>] [--no-diff]\n";
}

/**
 * Личность файла, а не путь: `--out`, указанный на симлинк или хардлинк входа,
 * разрешается в ТОТ ЖЕ inode, и сравнение `path.resolve` пропустило бы запись
 * в живой конфиг. Для существующего файла — пара dev+ino (`fs.statSync`
 * следует симлинкам, так что alias любого вида сходится на вход); для ещё не
 * существующего `--out` — realpath его каталога плюс имя.
 */
function fileIdentity(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    try {
      return { dir: fs.realpathSync(path.dirname(filePath)), base: path.basename(filePath) };
    } catch {
      return { unresolved: path.resolve(filePath) };
    }
  }
}

function sameFile(a, b) {
  if (a.dev !== undefined && b.dev !== undefined) {
    return a.dev === b.dev && a.ino === b.ino;
  }
  if (a.dir !== undefined && b.dir !== undefined) {
    return a.dir === b.dir && a.base === b.base;
  }
  return false;
}

function refusesOutputOverInput(inputPath, outPath) {
  return sameFile(fileIdentity(inputPath), fileIdentity(outPath));
}

export async function main(argv) {
  // Жёсткий разбор: неизвестный флаг или лишний позиционный аргумент — ошибка,
  // а не тихий пропуск (`--dffi` или `a.json b.json` с exit 0 создавали у
  // владельца ложную уверенность, что миграция сделана).
  const KNOWN_FLAGS = new Set(["--out", "--no-diff"]);
  let noDiff = false;
  let outPath = null;
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (KNOWN_FLAGS.has(token)) {
      if (token === "--no-diff") {
        noDiff = true;
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        process.stderr.write("--out needs a file path.\n");
        return 2;
      }
      outPath = value;
      index++;
      continue;
    }
    if (token.startsWith("--")) {
      process.stderr.write(`Unknown flag "${token}". Known flags: --out <file>, --no-diff.\n`);
      return 2;
    }
    positional.push(token);
  }
  if (positional.length > 1) {
    process.stderr.write(`Unexpected extra argument "${positional[1]}". The script takes exactly one input file.\n`);
    return 2;
  }
  const inputPath = positional[0];
  if (!inputPath) {
    process.stderr.write(usage());
    return 2;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  } catch (error) {
    process.stderr.write(`Cannot read ${inputPath}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (outPath && refusesOutputOverInput(inputPath, outPath)) {
    process.stderr.write(
      `Refusing to write ${outPath}: the migration never overwrites its input. Name a different file.\n`
    );
    return 2;
  }

  let migrated;
  try {
    migrated = migrateConfig(raw);
  } catch (error) {
    process.stderr.write(`Migration refused: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const problems = verifyEquivalence(raw, migrated.config, DECLARED);
  if (problems.length) {
    process.stderr.write(
      `Equivalence FAILED for ${problems.length} check(s); nothing was written:\n` +
        problems.map((line) => `  - ${line}`).join("\n") +
        "\n"
    );
    return 1;
  }

  if (DECLARED.length) {
    process.stdout.write(
      "ВНИМАНИЕ — осознанно снятые различия (решение за владельцем):\n" +
        DECLARED.map((entry) =>
          entry.was === undefined && entry.now === undefined
            ? `  - ${entry.preset}: ${entry.reason}`
            : `  - ${entry.preset}: ${entry.reason}\n` +
              `      было: ${JSON.stringify(entry.was)}\n` +
              `      стало: ${JSON.stringify(entry.now)}`
        ).join("\n") +
        "\n\n"
    );
  }

  const oldText = JSON.stringify(raw, null, 2) + "\n";
  const newText = JSON.stringify(migrated.config, null, 2) + "\n";

  if (outPath) {
    if (refusesOutputOverInput(inputPath, outPath)) {
      process.stderr.write("Refusing to write over the input.\n");
      return 2;
    }
    // The config carries `tokenCommand` with a secret: the copy never gets
    // wider than the owner-only file it came from, even when the input itself
    // was sloppier than 0600.
    fs.writeFileSync(outPath, newText, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`New configuration written to ${outPath}\n\n`);
  }
  if (migrated.dropped.length) {
    process.stdout.write(
      `Removed rudiments:\n${migrated.dropped.map((line) => `  - ${line}`).join("\n")}\n\n`
    );
  }
  if (!noDiff) {
    process.stdout.write(lineDiff(oldText, newText, `${inputPath} (old)`, outPath ?? "<new config>") + "\n");
  } else {
    process.stdout.write(newText);
  }
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
