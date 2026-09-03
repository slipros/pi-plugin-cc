/**
 * lsp-diagnostics-nudge — PostToolUse Write|Edit.
 *
 * Напоминает прогнать `lsp_diagnostics` по файлу, который только что правили,
 * если после последней диагностики его меняли. Смысл — ловить сломанные типы
 * сразу после правки, не дожидаясь сборки: pi-lsp поднимает сервер только на
 * вызов тула, сам он ничего не публикует.
 *
 * Символьного поиска (definition/references) у pi-lsp нет, поэтому здесь нет и
 * аналога claude-хука lsp-first-guard: заворачивать grep в LSP нечем.
 *
 * Напоминание печатается один раз на файл — до следующего вызова
 * `lsp_diagnostics`, который сбрасывает счётчик по всем файлам.
 *
 * Управление: LSP_DIAGNOSTICS_NUDGE=0 — выключить.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "./utils";

// Только расширения, по которым lsp_diagnostics реально что-то возвращает.
//
// Ограничения pi-lsp-adapter, из-за которых список такой короткий:
//   - таблица расширение → filetype зашита в коде (registry/builtin.ts) и конфигом
//     не расширяется, поэтому .vue/.mjs/.cjs/.mts/.cts/.pyi он не видит вовсе;
//   - диагностики он собирает только push-уведомлениями (publishDiagnostics), а tsgo
//     отдаёт их исключительно по pull-запросу textDocument/diagnostic — значит по
//     .ts/.tsx/.js/.jsx ответ всегда пустой, и напоминать бессмысленно (проверять
//     типы в TS — компилятором, не через LSP).
const SUPPORTED = [".go", ".rs", ".py"];

// rust-analyzer публикует диагностику после cargo check, а adapter ждёт всего 350 мс
// (diagnosticsWaitMs зашит в код), поэтому первый вызов на холодном сервере отдаёт пусто.
const SLOW_FIRST_CALL = [".rs"];

export default function (pi: ExtensionAPI) {
	// Файлы, изменённые после последней диагностики: повторно о них не напоминаем.
	const dirty = new Set<string>();

	pi.on("tool_result", async (event) => {
		if (process.env.LSP_DIAGNOSTICS_NUDGE === "0") return undefined;

		// Агент проверился — дальше правки снова достойны напоминания.
		if (event.toolName === "lsp_diagnostics") {
			dirty.clear();
			return undefined;
		}

		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

		const path = (event.input as { path?: string }).path ?? "";
		if (!SUPPORTED.some((ext) => path.endsWith(ext))) return undefined;
		if (dirty.has(path)) return undefined;
		dirty.add(path);

		const retry = SLOW_FIRST_CALL.some((ext) => path.endsWith(ext))
			? " Пустой ответ с первого раза не значит «чисто»: сервер ещё считает — подожди несколько секунд и вызови повторно."
			: "";
		const hint = `Файл ${basename(path)} изменён, а диагностика по нему не запускалась. Прогони lsp_diagnostics с filePath="${path}" — сервер увидит ошибки типов и импортов до сборки.${retry} Чистый LSP не заменяет линтер, тесты и сборку проекта: их всё равно прогоняй перед сдачей.`;

		return { content: [...(event.content ?? []), { type: "text" as const, text: "\n\n" + hint }] };
	});
}
