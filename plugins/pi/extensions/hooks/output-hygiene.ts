/**
 * output-hygiene-hint — PostToolUse Bash.
 *
 * Напоминает фильтровать распухший вывод команд (≥12 КБ), который целиком осел
 * в контексте. Не срабатывает, если команда уже фильтруется (tail/head/grep/…).
 *
 * Управление: OUTPUT_HYGIENE_HINT=0 — выключить.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "bash") return undefined;
		if (process.env.OUTPUT_HYGIENE_HINT === "0") return undefined;
		const cmd = (event.input as { command?: string }).command ?? "";
		const out = (event.content ?? [])
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
		if (out.length < 12000) return undefined;
		// команда уже фильтруется — напоминать не о чем
		if (/\|\s*(tail|head|grep|rg|awk|sed|wc)\b/.test(cmd)) return undefined;
		const lines = (out.match(/\n/g) ?? []).length;
		const hint = `Вывод команды — ${out.length} байт (${lines} строк) и целиком осел в контексте: каждый следующий ход перечитывает его. Такие прогоны фильтруй сразу — tail -30 для тестов и линтера, grep по строкам ok/FAIL/--- когда нужен только итог. Нужны детали — пиши полный вывод в файл и читай точечно.`;
		return { content: [...(event.content ?? []), { type: "text" as const, text: "\n\n" + hint }] };
	});
}
