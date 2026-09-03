/**
 * go-cache-guard — PreToolUse Bash.
 *
 * Запрещает сносить кеши Go: `go clean -modcache|-cache|-fuzzcache` и прямое
 * удаление каталогов кеша (`rm -rf $(go env GOMODCACHE)`, ~/go/pkg/mod,
 * /host-gomod).
 *
 * Зачем. В песочнице модули приходят двумя путями: хостовый download-кеш
 * смонтирован read-only как file-прокси (его снести нельзя — ФС не даст), а
 * распакованные модули лежат в volume, который переживает прогоны. Снос
 * второго данные не теряет, но стоит минут пересборки на каждом следующем
 * прогоне, а агент тянется к `go clean -modcache` как к универсальному
 * средству от любой ошибки сборки — где настоящая причина обычно в go.mod или
 * в GOFLAGS. Плюс страховка на случай, если кеш когда-нибудь смонтируют rw.
 *
 * Управление: GO_CACHE_GUARD=0 — выключить.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandSegments, segmentHead } from "./utils";

const DESTRUCTIVE_CLEAN_FLAGS = ["-modcache", "-cache", "-fuzzcache", "-testcache"];

/** Пути кеша, удаление которых бьёт по всем последующим прогонам. */
const PROTECTED = [
  "/host-gomod",
  "/home/pi/go/pkg/mod",
  "/home/pi/.cache",
  "go/pkg/mod",
  "GOMODCACHE",
  "GOCACHE"
];

function goCleanReason(tokens: string[]): string | null {
  // `go` — строго команда сегмента: поиск по всем словам давал блок на тексте
  // (`echo "go clean -modcache" >> notes.md`).
  const head = segmentHead(tokens);
  if (!head || head.head !== "go" || tokens[head.index + 1] !== "clean") {
    return null;
  }
  const flag = tokens.slice(head.index + 2).find((token) => DESTRUCTIVE_CLEAN_FLAGS.includes(token));
  if (!flag) {
    return null;
  }
  return (
    `\`go clean ${flag}\` сносит кеш, общий для всех прогонов песочницы: он живёт в volume, ` +
    "и восстановление стоит минут на каждой следующей сборке.\n\n" +
    "Обычно это лечение не той болезни. Что делать вместо:\n" +
    "· «unknown revision» / «missing go.sum entry» — `go mod tidy` или `go mod download`, кеш тут ни при чём;\n" +
    "· подозрение на битый модуль — назови его точечно: `go clean -modcache <module>` кешем целиком не рискует;\n" +
    "· не сходится версия — посмотри `go env GOFLAGS GOPROXY` и `go list -m all`.\n\n" +
    "Кеш действительно испорчен и другого пути нет — скажи об этом в отчёте, чистку сделает человек."
  );
}

export function removeCacheReason(tokens: string[]): string | null {
  const head = segmentHead(tokens);
  if (!head) {
    return null;
  }
  // `find <кеш> -delete` / `-exec rm` удаляет ровно то же, что `rm -r`, минуя
  // проверку головы сегмента.
  if (head.head === "find") {
    const deletes = tokens.some((t) => t === "-delete" || t === "-exec" || t === "-execdir");
    const root = tokens.slice(head.index + 1).find((t) => !t.startsWith("-") && PROTECTED.some((p) => t.includes(p)));
    if (!deletes || !root) {
      return null;
    }
    return (
      `\`find ${root} …\` удаляет кеш модулей, которым пользуются все прогоны — это то же, что rm -r.\n\n` +
      "Если сборка не идёт — причина в go.mod, GOFLAGS или GOPROXY, посмотри их (`go env`), а не сноси кеш."
    );
  }
  if (head.head !== "rm") {
    return null;
  }
  // Длинная форма и `-R` — тот же рекурсивный снос: `rm --recursive <кеш>` правило обходило.
  const recursive = tokens.some((token) => /^-[a-zA-Z]*[rR]/.test(token) || token === "--recursive");
  if (!recursive) {
    return null;
  }
  const target = tokens.slice(1).find((token) => !token.startsWith("-") && PROTECTED.some((p) => token.includes(p)));
  if (!target) {
    return null;
  }
  return (
    `\`rm -r ${target}\` удаляет кеш модулей, которым пользуются все прогоны.\n\n` +
    "Хостовый кеш смонтирован read-only и всё равно не удалится, а кеш контейнера " +
    "восстанавливается только повторной загрузкой. Если сборка не идёт — причина в go.mod, " +
    "GOFLAGS или GOPROXY, посмотри их (`go env`), а не сноси кеш."
  );
}

export function goCacheReason(command: string): string | null {
  if (process.env.GO_CACHE_GUARD === "0") {
    // Снятый гейт без следа неотличим от соблюдённого правила.
    console.error("[go-cache-guard] гейт снят через GO_CACHE_GUARD=0 — правило НЕ проверялось");
    return null;
  }
  // Сегменты с развёрнутыми обёртками: маскировка литералов прятала
  // `eval "rm -rf …/pkg/mod"` целиком, а `sh -c` приходилось выковыривать
  // отдельной регуляркой.
  for (const tokens of commandSegments(command)) {
    const reason = goCleanReason(tokens) ?? removeCacheReason(tokens);
    if (reason) return reason;
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return undefined;
    const command = (event.input as { command?: string }).command ?? "";
    if (!command) return undefined;
    const reason = goCacheReason(command);
    if (reason) return { block: true, reason };
    return undefined;
  });
}
