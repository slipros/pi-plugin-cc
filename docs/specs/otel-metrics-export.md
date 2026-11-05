# ТЗ: хостовый OTLP-экспорт метрик делегированных прогонов

Статус: постановка, к реализации. Ветка работ: от `compatible-pi`.

## 1. Проблема

В VictoriaMetrics лейбл `model` у `pi.token.usage` / `pi.cost.usage` за всё время имеет
единственное значение `glm-5.3`, хотя делегированные прогоны шли на `glm-5.3-flash`,
`deepseek-v4-flash` и локальном vllm `Qwen3.8-27B`.

Разбор (инспекция 2026-09-22) показал, что атрибуция в расширении
`@desek/pi-opentelemetry` 0.1.1 **исправна**: лейбл берётся из конкретного ответа
(`src/metrics.emitter.ts`, `recordMessageEnd`: `const model = assistant.model`), а pi
хранит модель на каждом сообщении (`@earendil-works/pi-ai`, `AssistantMessage.model`).
Единственное значение лейбла имеет три причины, все — на стороне этого репозитория:

1. **Песочница не отдаёт телеметрию.** `buildDockerRunArgs`
   (`plugins/pi/scripts/lib/sandbox.mjs:439`) пробрасывает env по allowlist, и
   `PI_OTEL_ENABLE` / `OTEL_*` в него не входят. Базовый профиль наоборот ставит
   `PI_OFFLINE=1, PI_SKIP_VERSION_CHECK=1, PI_TELEMETRY=0` (`sandbox.mjs:52`).
2. **Расширения телеметрии в контейнере нет.** `agentDir: "volume"` — хостовый
   `settings.json` с `packages` не монтируется, а `plugins/pi/sandbox/agent.Dockerfile`
   ставит глобально только `pi-lsp-adapter` и `pi-subagents`.
3. **Модель в контейнере замаскирована.** `credential-proxy.mjs:346-348`:
   `MASKED_PROVIDER = "sandbox"`, `MASKED_MODEL = "agent-model"`. Даже с проброшенным
   env расширение внутри контейнера проставило бы `model="agent-model"` на все прогоны.

Данные, подтверждающие масштаб (журнал `~/.local/share/pi-plugin/jobs.db`): с 16.09
(дата включения телеметрии на хосте) — 168 делегированных прогонов, из них 167 в
песочнице: `glm-5.3-flash` 93, `deepseek-v4-flash` 54, `glm-5.3` 19, `vllm/Qwen3.8-27B` 2.
Ни один из них в OTLP не попал.

## 2. Решение

Экспортировать метрики **с хоста, из companion**, по данным журнала, где модель и
провайдер настоящие. Маскировка, изоляция контейнера и allowlist env **не трогаются**:
Bearer-токен телеметрии в контейнер не уезжает, агент по-прежнему не знает, какая
модель ему отвечает.

```
companion (хост)
  job завершён → реальная модель, provider, usage, cost
        ▼
  lib/otel-export.mjs ──OTLP/HTTP JSON──▶ коллектор (тот же Bearer)
контейнер: без телеметрии, как сейчас
```

Транспорт — **OTLP/HTTP JSON** (`POST …/v1/metrics`), написанный на `node:` built-ins:
`package.json` этого репозитория не имеет и не должен иметь `dependencies`, поэтому
OTel SDK исключён.

### Что НЕ входит в объём

- Правки `@desek/pi-opentelemetry` — расширение работает корректно.
- Проброс `OTEL_*` в контейнер, установка расширения в образ, снятие маскировки модели.
- Трейсы и логи: только метрики `pi.token.usage` и `pi.cost.usage`.
- Метрики `pi.session.count`, `pi.lines_of_code.count`, `pi.code_edit_tool.decision`,
  `pi.commit.count`, `pi.pull_request.count`, `pi.active_time.total` — вне объёма
  (часть данных в журнале есть, но паритет по ним не требуется).
- Отдельный тип токенов `reasoning`: расширение его не эмитит, ряды должны совпасть.

## 3. Критерий приёмки

После прогона `pia delegate` на пресете с моделью, отличной от `glm-5.3`, в
VictoriaMetrics появляется ряд `pi.token.usage` с `model` этой модели, и суммы токенов
за период сходятся с журналом (`SELECT sum(input|output|cache_read|cache_write) FROM jobs`)
с точностью до незавершённых на момент запроса прогонов.

## 4. Требования

### R1. Конфигурация — стандартные `OTEL_*`, по умолчанию no-op

Резолв в `lib/otel-export.mjs`, чистая функция (тестируется без сети):

| Что | Откуда | Поведение |
| --- | --- | --- |
| Включение | `PI_OTEL_ENABLE` | Экспорт работает только при truthy (`1`/`true`). Пусто или `0` → полный no-op: ни одного сетевого вызова, ни одного чтения БД ради телеметрии. Probe Alloy, как в расширении, **не делаем**. |
| Endpoint | `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` → используется как есть (полный URL с путём) | |
| | иначе `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/metrics` | только если протокол http-семейства |
| Протокол | `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` → `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` и пустое значение (дефолт OTel — `http/protobuf`, но мы шлём JSON) → работаем; `grpc` без явного metrics-endpoint → экспорт выключен с однократным предупреждением |
| Заголовки | `OTEL_EXPORTER_OTLP_METRICS_HEADERS` → `OTEL_EXPORTER_OTLP_HEADERS` | формат `k=v,k=v`; значения — секреты, см. R8 |
| `service.name` | `OTEL_SERVICE_NAME`, иначе `pi-coding-agent` | дефолт обязан совпадать с расширением (`config.env.ts:138`), иначе ряды разъедутся по ресурсу |
| Ресурсные атрибуты | `OTEL_RESOURCE_ATTRIBUTES` (`k=v,k=v`) | плюс наши, см. R3 |

Важно: текущее окружение владельца задаёт `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` и
`OTEL_EXPORTER_OTLP_ENDPOINT=http://192.168.1.52:30317`. Пока не задан HTTP-endpoint,
экспортёр обязан молча оставаться выключенным (кроме строки в `setup`, см. R7) — это
ожидаемое состояние, а не ошибка. См. открытый вопрос O1.

### R2. Источник данных — таблица `jobs`, значения кумулятивные

Источник — **`jobs`**, не `requests`: `requests` пишет только credential-proxy, а он не
поднимается, когда у провайдера нет записи в `auth.json` (`credential-proxy.mjs:604` —
`if (!endpoint || !credential) return null`), из-за чего локальный vllm в `requests`
отсутствует целиком (проверено: 151 job `vllm/Qwen3.8-27B`, 0 строк в `requests`).
`jobs` покрывает все прогоны и хранит финальный usage.

Маппинг на схему расширения (`metrics.emitter.ts`, `recordMessageEnd`):

| Метрика | Лейблы | Значение |
| --- | --- | --- |
| `pi.token.usage` | `model`, `type=input` | `jobs.input` |
| `pi.token.usage` | `model`, `type=output` | `jobs.output` |
| `pi.token.usage` | `model`, `type=cacheRead` | `jobs.cache_read` |
| `pi.token.usage` | `model`, `type=cacheCreation` | `jobs.cache_write` |
| `pi.cost.usage` | `model` | `jobs.cost` |

`jobs.model` хранится как `<provider>/<model>` (`zai-coding-cn/glm-5.3-flash`). В лейбл
`model` кладётся **часть после слэша** — ровно то, что эмитит расширение из
`AssistantMessage.model`; провайдер идёт отдельным лейблом `provider` (у хостовых рядов
расширения его нет — это осознанное расширение схемы, `sum by(model)` продолжает
сходиться).

**Temporality — cumulative** (`aggregationTemporality: 2`, `isMonotonic: true`). Значение
точки считается запросом-агрегатом по всему журналу:

```sql
SELECT sum(input), sum(output), sum(cache_read), sum(cache_write), sum(cost)
FROM jobs WHERE model = ?
```

Так ряд монотонен независимо от перезапусков, параллельных прогонов и потерянных
отправок, а `rate()` в Grafana считается штатно. Строки `jobs` не удаляются —
`pruneJournalTextIfDue` (`db.mjs:918`) чистит только тексты и таблицу `requests`, — так
что кумулятив не проседает.

`start_time_unix_nano` — единая на БД константа: ключ `otel_start_time` в таблице `meta`,
проставляется при первом экспорте и дальше только читается.

Нулевые значения не отправляются (`value > 0`), как и в расширении: у vllm `cost = 0`,
ряд `pi.cost.usage` для него не создаётся.

Экспорт делается при **любом** терминальном статусе прогона (`completed`, `failed`,
`cancelled`): токены потрачены в любом случае — у отменённого прогона в журнале
встречается `input = 1 103 822`.

### R3. Форма запроса

`POST <endpoint>` c `Content-Type: application/json` и заголовками из R1.
Тело — `ExportMetricsServiceRequest` в OTLP/JSON:

```json
{"resourceMetrics":[{
  "resource":{"attributes":[
    {"key":"service.name","value":{"stringValue":"pi-coding-agent"}},
    {"key":"pi.runner","value":{"stringValue":"companion"}}
  ]},
  "scopeMetrics":[{
    "scope":{"name":"pi-plugin-cc"},
    "metrics":[{
      "name":"pi.token.usage","unit":"tokens",
      "description":"Number of tokens used",
      "sum":{"aggregationTemporality":2,"isMonotonic":true,"dataPoints":[{
        "attributes":[
          {"key":"model","value":{"stringValue":"glm-5.3-flash"}},
          {"key":"type","value":{"stringValue":"input"}},
          {"key":"provider","value":{"stringValue":"zai-coding-cn"}}],
        "startTimeUnixNano":"1757000000000000000",
        "timeUnixNano":"1758572897000000000",
        "asInt":"1699946793"}]}}]}]}]}
```

Обязательные детали формата, которые легко потерять:

- `int64` в OTLP/JSON кодируется **строкой** (`asInt`, `startTimeUnixNano`,
  `timeUnixNano`), `double` — числом (`asDouble` для `pi.cost.usage`).
- `unit`/`description` повторяют расширение: `tokens` / «Number of tokens used»,
  `USD` / «Cost of the pi session in USD».
- `scope.name` — собственный (`pi-plugin-cc`), а не `pi-pi-opentelemetry`: источники
  должны различаться в коллекторе.
- `pi.runner=companion` — ресурсный атрибут, отличающий эти ряды от хостовых.

### R4. Точка интеграции

`plugins/pi/scripts/lib/jobs.mjs` — там, где прогон финализируется и уже вызывается
`recordJobSafely` (строки 449 и 485). Экспорт вызывается после записи строки в журнал,
чтобы агрегат R2 уже включал этот прогон.

Новый модуль `plugins/pi/scripts/lib/otel-export.mjs` с плоским API:

- `resolveOtelConfig(env = process.env)` → `null | {endpoint, headers, resource}`;
- `buildMetricsPayload({model, provider, totals, startTimeNs, nowNs, resource})` → объект тела;
- `exportJobMetrics(job, {env, db, fetchImpl})` → `Promise<void>`, fail-safe.

Фоновые (`--background`) прогоны исполняются тем же скриптом в отсоединённом процессе,
поэтому отдельной обработки не требуют.

### R5. Один источник на прогон

Не-песочный делегированный прогон (`sandbox: null`) запускает pi на хосте, и дочерний
процесс наследует `PI_OTEL_ENABLE` вместе с остальным окружением — расширение в нём
сработает и метрики удвоятся. Поэтому companion обязан выставлять дочернему процессу
`PI_OTEL_ENABLE=0`.

Обе точки спавна берут окружение одинаково (`env = process.env`: `lib/pi.mjs:830`,
`lib/rpc.mjs:130`; сам `spawn` — `pi.mjs:919`, `rpc.mjs:199`), поэтому подавление
делается одной общей функцией и применяется в обоих движках. На песочные прогоны это
не влияет: туда env и так не попадает.

### R6. Отказоустойчивость

Телеметрия не имеет права влиять на прогон:

- весь путь обёрнут так, что любое исключение проглатывается (образец — `failSafe` в
  расширении и `recordJobSafely` в `db.mjs`);
- таймаут запроса — 2 c через `AbortSignal`, ретраев нет: ряд кумулятивный, следующий
  прогон догонит пропуск;
- недоступный коллектор не печатает ничего в поток прогона;
- отправка не удерживает процесс: сокет не должен мешать `pia` завершиться (см.
  `server.unref()` в `credential-proxy.mjs` как образец дисциплины).

### R7. Диагностика

`commandSetup` (`pi-companion.mjs:1243`) получает блок `telemetry`: включено/выключено,
резолвнутый endpoint, причина выключения (`PI_OTEL_ENABLE не задан`, `протокол grpc, а
metrics-endpoint не задан`). Это единственное место, где состояние экспортёра видно.

### R8. Секреты

`OTEL_EXPORTER_OTLP_HEADERS` содержит `Authorization: Bearer …`. Заголовки не логируются,
не попадают в `setup --json`, не пишутся в журнал. В `setup` показывается только факт
наличия заголовков (`headers: 1`). Совпадает с дисциплиной `redactArgs` в `lib/pi.mjs`.

## 5. Тесты

`npm test` — единственный гейт. Новый файл `tests/otel-export.test.mjs`:

1. `resolveOtelConfig` возвращает `null` без `PI_OTEL_ENABLE`; без endpoint; при
   `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` без metrics-endpoint.
2. `resolveOtelConfig` собирает URL из `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/metrics`,
   не задваивая слэш; `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` выигрывает.
3. Парсинг `k=v,k=v` заголовков и ресурсных атрибутов, включая значения со знаком `=`.
4. `buildMetricsPayload`: `asInt` — строка, `asDouble` — число, temporality `2`,
   `isMonotonic: true`, лейблы `model`/`type`/`provider`, `model` без префикса провайдера.
5. Нулевые тоталы не порождают точек; `cost = 0` не порождает `pi.cost.usage`.
6. Кумулятив: два прогона одной модели в journal (изоляция через `PI_PLUGIN_DB`, как в
   `tests/db.test.mjs`) → второй экспорт несёт сумму обоих; `startTimeUnixNano` совпадает
   в обоих вызовах.
7. Сквозной: локальный `node:http`-сервер вместо коллектора (образец —
   `tests/credential-proxy.test.mjs`), проверяется путь, `Content-Type`, заголовок
   авторизации и тело; затем сервер, отвечающий 500 и не отвечающий вовсе — прогон
   завершается штатно, исключений нет.
8. R5: окружение, собранное для дочернего pi, содержит `PI_OTEL_ENABLE=0` при
   унаследованном `PI_OTEL_ENABLE=1`.

Ни один тест не ходит в сеть и не тратит токены.

## 6. Документация

- `docs/metrics.md` — раздел о том, что журнал умеет отдавать наружу: имена метрик,
  лейблы, cumulative, почему источник хостовый (маскировка модели в песочнице).
- `docs/config.md`, раздел «Environment variables» — переменные из R1.
- `docs/sandbox.md`, таблица «What the container gets», строка Environment — явная
  оговорка, что телеметрия в контейнер не пробрасывается намеренно и почему.
- `CLAUDE.md` — если появляется новый модуль в `lib/`, упомянуть его в разборе `lib/`.

## 7. Риски и решения

| Риск | Решение |
| --- | --- |
| Bearer-токен телеметрии утёк бы агенту | Снят по построению: экспорт только на хосте |
| Агент узнал бы свою модель | Снят: маскировка не трогается |
| Двойной учёт на не-песочных прогонах | R5 |
| Delta-ряды коллектор не сконвертирует | Снят: шлём cumulative (R2) |
| Кумулятив просядет при чистке журнала | Строки `jobs` не удаляются (`db.mjs:918` чистит тексты и `requests`) |
| Лейбл `provider` расходится с хостовыми рядами | Осознанно: `sum by(model)` сходится, провайдер добавляет различимость |

## 8. Открытые вопросы

- **O1 (блокирует включение, не реализацию).** Принимает ли коллектор на 192.168.1.52
  OTLP/HTTP и на каком порту (в `~/.profile` задан только gRPC `30317`)? Нужен
  `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` вида `http://192.168.1.52:<порт>/v1/metrics`
  и подтверждение, что тот же Bearer там принимается. Код пишется и тестируется без
  этого ответа; без него экспортёр остаётся выключенным по R1.
- **O2.** Usage вложенных субагентов внутри делегированного прогона: `pi-subagents`
  запускает отдельный процесс pi в том же контейнере, и его токены попадают в `jobs`
  только в той мере, в какой их видит родительский прогон. Проверить на первом же
  прогоне с субагентами, сверив `jobs` с `requests` того же `job_id` (там, где
  credential-proxy поднят). Если расхождение значимо — отдельная задача.

## 9. Ручная проверка после реализации

1. `pia setup` — блок `telemetry` показывает `enabled` и резолвнутый endpoint.
2. `pia delegate --preset python-developer …` на модели, отличной от `glm-5.3`.
3. В VictoriaMetrics: `pi_token_usage{model="glm-5.3-flash"}` существует и растёт.
4. `sum by (model) (pi_token_usage{type="input"})` сходится с
   `SELECT model, sum(input) FROM jobs GROUP BY model` из журнала.
