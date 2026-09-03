/**
 * complexity-nudge — PostToolUse Write|Edit.
 *
 * Мягкий сигнал о сложности только что изменённого файла: cognitive complexity
 * для Go (gocognit), ветвление и объём для остальных языков (lizard).
 *
 * Говорит только о функциях, которые агент создал или ухудшил: точка отсчёта —
 * та же функция в HEAD. Замер на истории gid-data-golang-eval: 8 замечаний на
 * 138 изменённых Go-файлов (без сравнения с HEAD сработала бы половина файлов).
 *
 * Ничего не блокирует — текст просто дописывается к результату правки. Сложность
 * не ошибка: у неё нет порога, ниже которого код верен, а выше неверен, поэтому
 * гейт здесь врал бы. Смысл в моменте: замечание приходит, пока правка горячая,
 * а не в конце работы, когда переделывать дорого.
 *
 * Считалки и пороги — в общем ядре с claude-хуком complexity-nudge.sh
 * (~/.local/lib/complexity-nudge/report.py). Ядро вынесено из обоих каталогов
 * хуков намеренно: разъехавшиеся пороги означали бы, что один и тот же код
 * оценивается по-разному в зависимости от того, какой агент его писал.
 *
 * Дедупликация живёт в ядре и привязана к процессу: про одну и ту же функцию
 * напоминаем один раз, пока её сложность не выросла.
 *
 * Управление: COMPLEXITY_NUDGE=0 — выключить; пороги — COMPLEXITY_NUDGE_GO_COGNIT,
 * _CCN, _TOKENS; COMPLEXITY_NUDGE_DELTA=0 — судить по абсолютному порогу, без
 * сравнения с HEAD; COMPLEXITY_NUDGE_BASE_REF — иная точка отсчёта (origin/main
 * в долгой ветке); COMPLEXITY_NUDGE_BIN — путь к ядру (нужен песочнице, где
 * домашний каталог хоста не смонтирован).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { joinPath } from "./utils";

const CORE =
	process.env.COMPLEXITY_NUDGE_BIN ?? `${process.env.HOME}/.local/lib/complexity-nudge/report.py`;

// Расширения проверяем здесь, а не в ядре, чтобы не платить стартом python
// за каждую правку README или yaml — правок такого рода в сессии большинство.
const SUPPORTED = [
	".go", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue",
	".py", ".rs", ".java", ".kt", ".cs", ".php", ".rb", ".swift",
	".scala", ".lua", ".zig", ".sol",
	".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".m",
];

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		if (process.env.COMPLEXITY_NUDGE === "0") return undefined;
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

		const path = (event.input as { path?: string }).path ?? "";
		if (!SUPPORTED.some((ext) => path.endsWith(ext))) return undefined;

		const abs = path.startsWith("/") ? path : joinPath(ctx.cwd, path);

		let stdout = "";
		try {
			const res = await pi.exec("python3", [CORE, abs, `--session=pi-${process.pid}`], {
				timeout: 15_000,
			});
			stdout = res.stdout ?? "";
		} catch {
			return undefined; // считалки не установлены или упали — правку это не касается
		}

		const text = stdout.trim();
		if (!text) return undefined;

		return { content: [...(event.content ?? []), { type: "text" as const, text: "\n\n" + text }] };
	});
}
