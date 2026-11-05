import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { openDatabase, recordJob } from "../plugins/pi/scripts/lib/db.mjs";
import { runTrackedJob } from "../plugins/pi/scripts/lib/jobs.mjs";

const COMPANION = fileURLToPath(new URL("../plugins/pi/scripts/pi-companion.mjs", import.meta.url));
import {
  buildMetricsPayload,
  describeOtelTelemetry,
  exportJobMetrics,
  parseKeyValueList,
  resolveOtelConfig,
  splitModelId,
  withoutOtel
} from "../plugins/pi/scripts/lib/otel-export.mjs";

function temporaryDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-otel-"));
  return { handle: openDatabase(path.join(dir, "jobs.db")), dir };
}

/** A stand-in collector that records what it received. */
async function startCollector({ statusCode = 200, hang = false } = {}) {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        url: request.url,
        contentType: request.headers["content-type"],
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8")
      });
      if (hang) return;
      response.writeHead(statusCode);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}/v1/metrics`,
    close: () =>
      new Promise((resolve) => {
        // A hanging handler would otherwise keep the socket (and the test process) alive.
        server.closeAllConnections();
        server.close(resolve);
      })
  };
}

function job(overrides = {}) {
  return {
    id: "delegate-1",
    kind: "delegate",
    model: "zai-coding-cn/glm-5.3-flash",
    status: "completed",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    usage: { input: 100, output: 20, cost: 0.5 },
    ...overrides
  };
}

const ENABLED = {
  PI_OTEL_ENABLE: "1",
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector:30318/v1/metrics",
  OTEL_EXPORTER_OTLP_METRICS_HEADERS: "Authorization=Bearer t0k3n,X-Scope-OrgID=acme=corp"
};

test("resolveOtelConfig: выключен без PI_OTEL_ENABLE, без endpoint и при grpc без metrics-endpoint", () => {
  assert.equal(resolveOtelConfig({}), null);
  assert.equal(resolveOtelConfig({ PI_OTEL_ENABLE: "0" }), null);
  assert.equal(resolveOtelConfig({ PI_OTEL_ENABLE: "1" }), null, "endpoint не задан вовсе");
  // Текущее окружение владельца: grpc + gRPC-endpoint — exporter обязан молчать.
  assert.equal(
    resolveOtelConfig({ PI_OTEL_ENABLE: "1", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:30317" }),
    null
  );
  // Явный metrics-endpoint спасает даже при grpc-протоколе базового сигнала.
  assert.ok(
    resolveOtelConfig({
      PI_OTEL_ENABLE: "true",
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:30317",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector:30318/v1/metrics"
    })
  );
});

test("resolveOtelConfig: собирает URL из базового endpoint, METRICS_ENDPOINT выигрывает", () => {
  const fromBase = resolveOtelConfig({ PI_OTEL_ENABLE: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/" });
  assert.equal(fromBase.endpoint, "http://collector:4318/v1/metrics", "хвостовой слэш не задваивается");
  const metrics = resolveOtelConfig({
    PI_OTEL_ENABLE: "1",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://elsewhere:9/v1/metrics"
  });
  assert.equal(metrics.endpoint, "http://elsewhere:9/v1/metrics");
});

test("resolveOtelConfig: разбор k=v,k=v, значения со знаком =, resource-атрибуты и service.name", () => {
  assert.deepEqual(parseKeyValueList("a=1,b=x=y"), { a: "1", b: "x=y" });
  const config = resolveOtelConfig({
    ...ENABLED,
    OTEL_SERVICE_NAME: "my-pi",
    OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=prod,team=otel=v2"
  });
  assert.equal(config.headers.Authorization, "Bearer t0k3n");
  assert.equal(config.headers["X-Scope-OrgID"], "acme=corp");
  assert.equal(config.resource["service.name"], "my-pi");
  assert.equal(config.resource["pi.runner"], "companion");
  assert.equal(config.resource["deployment.environment"], "prod");
  assert.equal(config.resource.team, "otel=v2");
  // Дефолт service.name обязан совпадать с расширением.
  assert.equal(resolveOtelConfig({ ...ENABLED }).resource["service.name"], "pi-coding-agent");
});

test("buildMetricsPayload: форма OTLP/JSON — asInt строкой, asDouble числом, temporality 2, лейблы", () => {
  const payload = buildMetricsPayload({
    model: "glm-5.3-flash",
    provider: "zai-coding-cn",
    totals: { input: 1699946793, output: 4210, cacheRead: 0, cacheWrite: 7, cost: 0.25 },
    startTimeNs: 1757000000000000000n,
    nowNs: 1758572897000000000n,
    resource: { "service.name": "pi-coding-agent", "pi.runner": "companion" }
  });
  const [resourceMetrics] = payload.resourceMetrics;
  assert.deepEqual(
    resourceMetrics.resource.attributes.map((a) => [a.key, a.value.stringValue]),
    [["service.name", "pi-coding-agent"], ["pi.runner", "companion"]]
  );
  assert.equal(resourceMetrics.scopeMetrics[0].scope.name, "pi-plugin-cc");
  const [token, cost] = resourceMetrics.scopeMetrics[0].metrics;
  assert.equal(token.name, "pi.token.usage");
  assert.equal(token.unit, "tokens");
  assert.equal(token.description, "Number of tokens used");
  assert.equal(token.sum.aggregationTemporality, 2);
  assert.equal(token.sum.isMonotonic, true);
  assert.equal(token.sum.dataPoints.length, 3, "нулевой cacheRead не порождает точку");
  const input = token.sum.dataPoints[0];
  assert.equal(input.asInt, "1699946793", "int64 кодируется строкой");
  assert.equal(typeof input.asInt, "string");
  assert.equal(input.startTimeUnixNano, "1757000000000000000");
  assert.equal(input.timeUnixNano, "1758572897000000000");
  assert.deepEqual(
    input.attributes.map((a) => [a.key, a.value.stringValue]),
    [["model", "glm-5.3-flash"], ["provider", "zai-coding-cn"], ["type", "input"]]
  );
  assert.equal(cost.name, "pi.cost.usage");
  assert.equal(cost.unit, "USD");
  assert.equal(cost.description, "Cost of the pi session in USD");
  assert.equal(typeof cost.sum.dataPoints[0].asDouble, "number");
  assert.equal(cost.sum.dataPoints[0].asDouble, 0.25);
});

test("buildMetricsPayload: нулевые тоталы и cost=0 рядов не порождают", () => {
  assert.equal(
    buildMetricsPayload({
      model: "m", provider: "p",
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      startTimeNs: 1n, nowNs: 2n, resource: {}
    }),
    null,
    "cost=0 не порождает pi.cost.usage"
  );
  const costOnly = buildMetricsPayload({
    model: "m", provider: "p",
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
    startTimeNs: 1n, nowNs: 2n, resource: {}
  });
  assert.deepEqual(
    costOnly.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name),
    ["pi.cost.usage"]
  );
});

test("resolveOtelConfig: http/json протокол и fallback METRICS_PROTOCOL → базовый PROTOCOL (R1)", () => {
  const base = resolveOtelConfig({
    PI_OTEL_ENABLE: "1",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318"
  });
  assert.ok(base, "http/json по базовому PROTOCOL включает экспортёр");
  assert.equal(base.endpoint, "http://collector:4318/v1/metrics");
  const metrics = resolveOtelConfig({
    PI_OTEL_ENABLE: "1",
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318"
  });
  assert.ok(metrics, "METRICS_PROTOCOL доступен и когда базовый PROTOCOL не задан");
});

test("сквозной: ряды cacheRead и cacheCreation доходят до тела (R2, §3)", async () => {
  const { handle, dir } = temporaryDatabase();
  try {
    recordJob(handle, job({ id: "cache-1", usage: { input: 100, output: 10, cacheRead: 300, cacheWrite: 40, cost: 0.05 } }));
    const capture = await exportAndCapture(handle, "cache-1");
    const points = JSON.parse(capture.body).resourceMetrics[0].scopeMetrics[0].metrics
      .find((m) => m.name === "pi.token.usage").sum.dataPoints;
    const byType = Object.fromEntries(points.map((p) => [
      p.attributes.find((a) => a.key === "type").value.stringValue,
      p.asInt
    ]));
    assert.equal(byType.cacheRead, "300", "cache_read журнала должен доехать до точки type=cacheRead");
    assert.equal(byType.cacheCreation, "40", "cache_write журнала должен доехать до точки type=cacheCreation");
    assert.equal(Object.keys(byType).length, 4, "все четыре ряда токенов присутствуют");
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("splitModelId: model без префикса провайдера, провайдер отдельным лейблом", () => {
  assert.deepEqual(splitModelId("zai-coding-cn/glm-5.3-flash"), { model: "glm-5.3-flash", provider: "zai-coding-cn" });
  assert.deepEqual(splitModelId("vllm/Qwen3.8-27B"), { model: "Qwen3.8-27B", provider: "vllm" });
  assert.deepEqual(splitModelId("bare-model"), { model: "bare-model", provider: "" });
});

test("кумулятив: два прогона одной модели — второй экспорт несёт сумму, startTime общий", async () => {
  const { handle, dir } = temporaryDatabase();
  try {
    recordJob(handle, job({ id: "a", usage: { input: 100, output: 10, cost: 0.01 } }));
    const first = await exportAndCapture(handle, "a");
    recordJob(handle, job({ id: "b", usage: { input: 50, output: 5, cost: 0.02 } }));
    const second = await exportAndCapture(handle, "b");
    const pointsOf = (capture, type) =>
      JSON.parse(capture.body).resourceMetrics[0].scopeMetrics[0].metrics
        .find((m) => m.name === "pi.token.usage")
        .sum.dataPoints.find((p) => p.attributes.some((a) => a.key === "type" && a.value.stringValue === type));
    assert.equal(pointsOf(second, "input").asInt, "150", "агрегат по всему журналу, а не по одному прогону");
    assert.equal(pointsOf(second, "output").asInt, "15");
    assert.equal(
      pointsOf(first, "input").startTimeUnixNano,
      pointsOf(second, "input").startTimeUnixNano,
      "startTime единый на БД"
    );
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function exportAndCapture(handle, jobId, env = ENABLED) {
  const captures = [];
  await exportJobMetrics(
    { id: jobId, model: job().model },
    {
      env,
      db: handle,
      // Заглушка вместо сети: даже URL из ENABLED не должен резолвиться по-настоящему.
      fetchImpl: async (url, options) => {
        captures.push({ url, body: options.body, headers: options.headers });
        return { ok: true, status: 200 };
      }
    }
  );
  return captures[0];
}

test("сквозной: локальный коллектор получает путь, Content-Type, авторизацию и тело; 500 и тишина не роняют прогон", async () => {
  const { handle, dir } = temporaryDatabase();
  try {
    recordJob(handle, job({}));
    const collector = await startCollector();
    await exportJobMetrics(job({}), { env: { ...ENABLED, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: collector.url }, db: handle });
    const seen = collector.seen[0];
    assert.equal(seen.url.endsWith("/v1/metrics"), true);
    assert.equal(seen.contentType, "application/json");
    assert.equal(seen.authorization, "Bearer t0k3n");
    const payload = JSON.parse(seen.body);
    assert.equal(payload.resourceMetrics[0].scopeMetrics[0].metrics[0].name, "pi.token.usage");
    await collector.close();

    // 500 от коллектора: экспорт молча переживается, без ретраев и без
    // печати в поток прогона — недоступный коллектор не виден пользователю.
    const failing = await startCollector({ statusCode: 500 });
    const output = [];
    const originalWrite = { out: process.stdout.write, err: process.stderr.write };
    process.stdout.write = (chunk) => (output.push(String(chunk)), true);
    process.stderr.write = (chunk) => (output.push(String(chunk)), true);
    try {
      await exportJobMetrics(job({ id: "x2" }), { env: { ...ENABLED, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: failing.url }, db: handle });
    } finally {
      process.stdout.write = originalWrite.out;
      process.stderr.write = originalWrite.err;
    }
    assert.equal(failing.seen.length, 1, "один запрос, ретраев нет (R6)");
    assert.equal(output.join(""), "", "500-сценарий ничего не печатает (R6)");
    await failing.close();

    // Коллектор, не отвечающий вовсе: AbortSignal рвёт запрос, исключений нет.
    const hanging = await startCollector({ hang: true });
    try {
      const started = Date.now();
      await Promise.race([
        exportJobMetrics(job({ id: "x3" }), {
          env: { ...ENABLED, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: hanging.url },
          db: handle,
          timeoutMs: 100
        }),
        // Реальный fetch к висящему серверу иначе держит тест минутами: отказ
        // таймаута должен краснеть за секунды, а не висеть.
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("exportJobMetrics не оборвался по AbortSignal за 5 с")), 5_000).unref()
        )
      ]);
      assert.ok(Date.now() - started < 5_000, "экспорт не висит вечно");
    } finally {
      await hanging.close();
    }
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("без PI_OTEL_ENABLE экспортёра нет: ни fetch, ни чтения БД", async () => {
  let fetched = 0;
  await exportJobMetrics(job({}), {
    env: {},
    fetchImpl: async () => {
      fetched += 1;
      return { ok: true };
    }
  });
  assert.equal(fetched, 0, "no-op не делает сетевых вызовов");
  // Журнал, который не открывается: PI_PLUGIN_DB лежит под обычным ФАЙЛОМ,
  // где mkdirSync обязан упасть (ENOTDIR) — экспорт тихо пропускается, как и
  // весь CLI через recordJobSafely.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-otel-noop-"));
  fs.writeFileSync(path.join(scratch, "blocker"), "not a directory");
  const previous = process.env.PI_PLUGIN_DB;
  process.env.PI_PLUGIN_DB = path.join(scratch, "blocker", "jobs.db");
  try {
    await exportJobMetrics(job({}), {
      env: { PI_OTEL_ENABLE: "1", OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:1/v1/metrics" },
      fetchImpl: async () => {
        fetched += 1;
        return { ok: true };
      },
      timeoutMs: 50
    });
  } finally {
    if (previous === undefined) delete process.env.PI_PLUGIN_DB;
    else process.env.PI_PLUGIN_DB = previous;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  assert.equal(fetched, 0, "неоткрывшийся журнал выключает экспорт");
});

/** Переменные экспортёра из окружения разработчика: тест обязан их не видеть. */
function isOtelKey(key) {
  return key.startsWith("PI_OTEL_") || key.startsWith("OTEL_EXPORTER");
}

/**
 * Свой журнал на каждый прогон: exportJobMetrics и recordJobSafely читают process.env.
 * Унаследованные PI_OTEL_* вычищаются: PI_OTEL_EXPORTER_OTLP_ENDPOINT выигрывает у
 * OTEL_EXPORTER_OTLP_METRICS_ENDPOINT теста, и с настроенным шеллом экспорт уходил
 * на настоящий коллектор разработчика, а тестовый ждал впустую.
 */
function withProcessJournal(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-otel-tracked-"));
  const previous = { PI_PLUGIN_DB: process.env.PI_PLUGIN_DB, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: undefined };
  for (const key of Object.keys(process.env)) {
    if (!isOtelKey(key)) continue;
    previous[key] = process.env[key];
    delete process.env[key];
  }
  process.env.PI_PLUGIN_DB = path.join(dir, "jobs.db");
  return run(dir).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

/** runTrackedJob уводит fetch в никуда; ждём его завершения опросом коллектора. */
async function waitForSeen(collector, count = 1, timeoutMs = 5_000) {
  const started = Date.now();
  while (collector.seen.length < count) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`коллектор не получил ${count} запрос(ов) за ${timeoutMs} мс`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Минимальный execution, по форме совпадающий с тем, что возвращают движки. */
function execution(overrides = {}) {
  return {
    exitStatus: 0,
    text: "готово",
    model: job().model,
    usage: { input: 120, output: 30, cost: 0.2 },
    errors: [],
    turns: 1,
    ...overrides
  };
}

test("финализация: fetch после recordJobSafely, для completed, failed и cancelled (R3)", async () => {
  await withProcessJournal(async (dir) => {
    const cases = [
      ["completed", { runner: () => execution() }],
      ["failed", { runner: () => { throw new Error("модель упала"); } }],
      ["cancelled", { runner: () => execution({ aborted: true, exitStatus: 1, text: null, usage: { input: 5, output: 0, cost: 0 } }) }]
    ];
    for (const [status, overrides] of cases) {
      const collector = await startCollector();
      process.env.PI_OTEL_ENABLE = "1";
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = collector.url;
      const workspaceRoot = fs.mkdtempSync(path.join(dir, `ws-${status}-`));
      const running = {
        id: `tracked-${status}`,
        kind: "delegate",
        workspaceRoot,
        logFile: path.join(workspaceRoot, "job.log"),
        model: job().model,
        prompt: "задача"
      };
      try {
        if (status === "failed") {
          await assert.rejects(() => runTrackedJob(running, overrides.runner), /модель упала/);
        } else {
          await runTrackedJob(running, overrides.runner);
        }
        await waitForSeen(collector);
        const payload = JSON.parse(collector.seen[0].body);
        const tokenMetric = payload.resourceMetrics[0].scopeMetrics[0].metrics.find((m) => m.name === "pi.token.usage");
        assert.ok(tokenMetric, `${status}: метрика токенов экспортирована`);
        // Кумулятив уже включает этот прогон: запись в журнале случилась до fetch.
        const input = tokenMetric.sum.dataPoints.find((p) =>
          p.attributes.some((a) => a.key === "type" && a.value.stringValue === "input")
        );
        // Журнал один на весь цикл, поэтому кумулятив растёт от кейса к кейсу:
        // failed пишет в журнал без usage (0 токенов), cancelled — свои 5.
        const expected = status === "cancelled" ? 125 : 120;
        assert.equal(input.asInt, String(expected), `${status}: usage прогона уже в агрегате`);
        assert.equal(collector.seen.length, 1, `${status}: ровно один экспорт`);
      } finally {
        await collector.close();
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
      }
    }
  });
});

function runSetup(extraEnv) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-otel-setup-"));
  const base = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, PI_PLUGIN_DB: path.join(dataDir, "jobs.db") };
  for (const key of Object.keys(base)) {
    if (isOtelKey(key)) delete base[key];
  }
  return {
    dataDir,
    result: spawnSync(process.execPath, [COMPANION, "setup", "--json"], {
      encoding: "utf8",
      cwd: dataDir,
      env: { ...base, ...extraEnv },
      timeout: 60_000
    })
  };
}

function setupTelemetry(extraEnv) {
  const { dataDir, result } = runSetup(extraEnv);
  try {
    assert.equal(result.status, 0, `setup завершился: ${result.stderr}`);
    const start = result.stdout.indexOf("{");
    const payload = JSON.parse(result.stdout.slice(start));
    return payload.telemetry;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("setup --json: telemetry видна в обоих состояниях (R7)", () => {
  const enabled = setupTelemetry({
    PI_OTEL_ENABLE: "1",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:4318/v1/metrics"
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.endpoint, "http://127.0.0.1:4318/v1/metrics");

  const off = setupTelemetry({});
  assert.equal(off.enabled, false);
  assert.match(off.reason, /PI_OTEL_ENABLE не задан/);

  const grpc = setupTelemetry({
    PI_OTEL_ENABLE: "1",
    OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4317"
  });
  assert.equal(grpc.enabled, false);
  assert.match(grpc.reason, /grpc/);
  assert.match(grpc.reason, /PI_OTEL_EXPORTER_OTLP_ENDPOINT/);
});

test("setup --json: значение заголовков не попадает в вывод (R8)", () => {
  const { dataDir, result } = runSetup({
    PI_OTEL_ENABLE: "1",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:4318/v1/metrics",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer s3cr3t-token"
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout + result.stderr;
    assert.ok(!output.includes("Bearer"), "значение заголовка утекло в вывод setup");
    assert.ok(!output.includes("s3cr3t-token"), "токен утекло в вывод setup");
    const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
    assert.equal(payload.telemetry.headers, 1, "выводится только факт наличия заголовков");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("R5: окружение дочернего pi глушит унаследованный PI_OTEL_ENABLE", () => {
  assert.deepEqual(withoutOtel({ PI_OTEL_ENABLE: "1", HOME: "/h" }), { PI_OTEL_ENABLE: "0", HOME: "/h" });
  assert.deepEqual(withoutOtel({ PI_OTEL_ENABLE: "true" }).PI_OTEL_ENABLE, "0");
  // Переменной не было — окружение не перекраивается.
  const untouched = { HOME: "/h" };
  assert.equal(withoutOtel(untouched), untouched);
});

test("resolveOtelConfig: PI_OTEL_EXPORTER_OTLP_ENDPOINT выигрывает у стандартных OTEL_*", () => {
  const config = resolveOtelConfig({
    PI_OTEL_ENABLE: "1",
    PI_OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/v1/metrics",
    PI_OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer pi-token",
    OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4317",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://elsewhere:9/v1/metrics",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer otel-token"
  });
  assert.equal(config.source, "pi");
  assert.equal(config.endpoint, "http://collector:4318/v1/metrics", "PI_-endpoint используется как есть, протокол не проверяется");
  assert.equal(config.headers.Authorization, "Bearer pi-token");
});

test("resolveOtelConfig: без PI_-переменных прежнее поведение по OTEL_* (обратная совместимость)", () => {
  const config = resolveOtelConfig({ ...ENABLED, OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" });
  assert.equal(config.source, "otel");
  assert.equal(config.endpoint, "http://collector:30318/v1/metrics");
  assert.equal(config.headers.Authorization, "Bearer t0k3n");
});

test("resolveOtelConfig: заголовки следуют источнику endpoint — PI_ без заголовков падает на стандартные, а не молчит", () => {
  const fallback = resolveOtelConfig({
    PI_OTEL_ENABLE: "1",
    PI_OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/v1/metrics",
    OTEL_EXPORTER_OTLP_METRICS_HEADERS: "Authorization=Bearer otel-metrics-token"
  });
  assert.equal(fallback.headers.Authorization, "Bearer otel-metrics-token");
  const baseFallback = resolveOtelConfig({
    PI_OTEL_ENABLE: "1",
    PI_OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/v1/metrics",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer otel-base-token"
  });
  assert.equal(baseFallback.headers.Authorization, "Bearer otel-base-token");
  // Источник otel не видит PI_-заголовков: смешивание источников запрещено.
  const otelOnly = resolveOtelConfig({
    PI_OTEL_ENABLE: "1",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    PI_OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer pi-token"
  });
  assert.deepEqual(otelOnly.headers, {});
});

test("describeOtelTelemetry: источник конфигурации и подсказка при выключенном экспорте", () => {
  const pi = describeOtelTelemetry({
    PI_OTEL_ENABLE: "1",
    PI_OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/v1/metrics",
    PI_OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer s3cr3t"
  });
  assert.equal(pi.source, "pi");
  assert.equal(pi.enabled, true);
  assert.ok(!JSON.stringify(pi).includes("s3cr3t"), "значение заголовка не попадает в describe");
  assert.equal(pi.headers, 1);

  const otel = describeOtelTelemetry({ ...ENABLED });
  assert.equal(otel.source, "otel");

  const hinted = describeOtelTelemetry({ PI_OTEL_ENABLE: "1" });
  assert.equal(hinted.enabled, false);
  assert.match(hinted.reason, /PI_OTEL_EXPORTER_OTLP_ENDPOINT/);
  assert.match(hinted.reason, /Claude Code/);
});
