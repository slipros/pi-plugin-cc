/**
 * sql-migration-semicolon-guard — PreToolUse Write|Edit|Bash.
 *
 * Запрещает ';' в комментариях SQL-миграций: db-migrator рвёт файл на
 * стейтменты по ';' не разбирая комментариев, миграция сломается.
 *
 * Управление: SQL_SEMICOLON_GUARD=0 — выключить.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripCommentLiterals, writeTargets } from "./utils";

function semicolonsInComments(content: string): string[] {
	const bad: string[] = [];
	const lines = content.split("\n");
	let inblock = false;
	for (let idx = 0; idx < lines.length; idx++) {
		const orig = lines[idx];
		let line = stripCommentLiterals(orig);
		const at = idx + 1;

		if (inblock) {
			const end = line.indexOf("*/");
			if (end !== -1) {
				const c = line.slice(0, end);
				inblock = false;
				line = line.slice(end + 2);
				if (c.includes(";")) { bad.push(`${at}: ${orig}`); continue; }
			} else {
				if (line.includes(";")) { bad.push(`${at}: ${orig}`); }
				line = "";
				continue;
			}
		}

		const p = line.indexOf("--");
		if (p !== -1 && line.slice(p).includes(";")) { bad.push(`${at}: ${orig}`); continue; }

		const b = line.indexOf("/*");
		if (b !== -1) {
			const rest = line.slice(b + 2);
			const e = rest.indexOf("*/");
			let c: string;
			if (e !== -1) c = rest.slice(0, e);
			else { c = rest; inblock = true; }
			if (c.includes(";")) bad.push(`${at}: ${orig}`);
		}
	}
	return bad;
}

/** Похоже ли на файл миграции: правило смотрит на имя, как и db-migrator. */
export function isMigrationPath(p: string): boolean {
	return /migrat.*\.sql$/.test(p);
}

/**
 * Миграция, записанная из bash (`cat > …`, `tee`, `sed -i`), минует проверку
 * содержимого: у хука на write|edit нет текста, который агент собирается
 * записать. Молчать нельзя — правило снимается сменой инструмента, поэтому
 * запись в миграцию через bash отклоняется с указанием писать её write/edit.
 */
export function bashWriteReason(command: string): string | null {
	const target = writeTargets(command).find(isMigrationPath);
	if (!target) return null;
	return `Файл миграции ${target} записывается из bash — проверка «';' в комментариях» при этом не выполняется, а db-migrator рвёт файл по ';' не разбирая комментариев.\n\nПиши миграцию инструментом write/edit: тогда содержимое проверяется до записи.`;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName === "bash") {
			if (process.env.SQL_SEMICOLON_GUARD === "0") return undefined;
			const cmd = (event.input as { command?: string }).command ?? "";
			if (!cmd) return undefined;
			const reason = bashWriteReason(cmd);
			return reason ? { block: true, reason } : undefined;
		}
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		if (process.env.SQL_SEMICOLON_GUARD === "0") {
			// Снятый гейт без следа неотличим от соблюдённого правила.
			console.error("[sql-semicolon-guard] гейт снят через SQL_SEMICOLON_GUARD=0 — правило НЕ проверялось");
			return undefined;
		}
		const input = event.input as { path?: string; content?: string; edits?: { newText?: string }[] };
		const path = input.path ?? "";
		if (!isMigrationPath(path)) return undefined;

		const chunks: string[] = [];
		if (event.toolName === "write" && typeof input.content === "string") chunks.push(input.content);
		if (event.toolName === "edit" && Array.isArray(input.edits)) {
			for (const e of input.edits) if (typeof e.newText === "string") chunks.push(e.newText);
		}
		for (const chunk of chunks) {
			const bad = semicolonsInComments(chunk);
			if (bad.length) {
				return {
					block: true,
					reason: "В комментариях SQL-миграции есть ';' — db-migrator рвёт файл на стейтменты по ';' не разбирая комментариев, миграция сломается. Перепиши комментарий без ';'. Строки: " + bad.join(", "),
				};
			}
		}
		return undefined;
	});
}
