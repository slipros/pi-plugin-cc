/**
 * grep-scope-guard — PreToolUse Bash.
 *
 * Заворачивает рекурсивный поиск, корень которого накрывает весь домашний
 * каталог (`~`, `$HOME`, `/`) или заведомо тяжёлое дерево зависимостей
 * (`~/go`, `~/.cargo`, `~/.cache`, `~/.npm`).
 *
 * Зачем. У pi нет тулов grep/find — поиск идёт только через bash, и модель на
 * вопрос «где используется X» охотно пишет `cd ~ && grep -rn X .`. В $HOME это
 * `go/pkg/mod` + `.cargo/registry` + `node_modules`: замер 2026-08-09 — 13 с с
 * `--include="*.go"` и больше минуты без него, причём длинный прогон вернулся
 * пустым выводом. Пустой ответ агент читает как «не найдено» и запускает тот же
 * поиск снова — сессия уходит в бесконечный `Working...`. Дефолтного таймаута у
 * bash-тула нет (проверено: `sleep 120` доходит целиком), так что петлю ничто
 * не разрывает.
 *
 * Учитывается `cd` в той же команде: `cd $HOME && grep -rn X .` — корень
 * поиска здесь $HOME, а не рабочий каталог pi.
 *
 * Явный `timeout N …` в начале сегмента снимает блокировку: если поиск по всему
 * дому действительно нужен, он хотя бы оборвётся сам.
 *
 * Управление: GREP_SCOPE_GUARD=0 — выключить.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, normalize, isAbsolute } from "node:path";
import { basename, commandSegments, segmentHead } from "./utils";

const HOME = homedir();

// Деревья, поиск по которым бессмысленно дорог: кеши модулей и пакетов.
const HEAVY = ["go", ".cargo", ".cache", ".npm", ".local/share", ".rustup", "go/pkg/mod"].map((p) => join(HOME, p));

/** Разбивает команду на сегменты по `&& || ; | &`, не заглядывая внутрь кавычек. */
function splitSegments(cmd: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: string | null = null;
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (quote) {
			cur += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			cur += ch;
			continue;
		}
		if (cmd.startsWith("&&", i) || cmd.startsWith("||", i)) {
			out.push(cur);
			cur = "";
			i++;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
			out.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	out.push(cur);
	return out.map((s) => s.trim()).filter(Boolean);
}

/** Токены сегмента с раскавыченными значениями. */
function tokenize(seg: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(seg)) !== null) {
		out.push((m[1] ?? m[2] ?? m[3]).replace(/["']/g, ""));
	}
	return out;
}

// Опции, забирающие следующий токен: иначе `-e ConvertResult` или `--glob !x/**`
// прочитались бы как путь поиска.
const OPTS_WITH_ARG: Record<string, Set<string>> = {
	grep: new Set(["-e", "-f", "-m", "-A", "-B", "-C", "-d", "--include", "--exclude", "--exclude-dir", "--binary-files", "--regexp", "--file", "--max-count"]),
	rg: new Set(["-e", "-g", "-t", "-T", "-m", "-A", "-B", "-C", "-M", "--glob", "--iglob", "--type", "--type-not", "--type-add", "--max-depth", "--max-count", "--max-filesize", "--regexp", "--file", "--replace"]),
	find: new Set([]),
	fd: new Set(["-e", "-t", "-E", "-d", "--extension", "--type", "--exclude", "--max-depth"]),
};

const PATTERN_OPTS = new Set(["-e", "--regexp", "-f", "--file"]);

/** Пути-аргументы поиска (пустой список = корнем будет cwd). */
function searchRoots(tool: string, tokens: string[]): string[] {
	const withArg = OPTS_WITH_ARG[tool] ?? new Set<string>();
	const roots: string[] = [];
	let patternSeen = tool === "find" || tool === "fd"; // у find/fd путь идёт первым
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i];
		// Редирект (`2>/dev/null`, `> out`) — не путь поиска. Иначе он занимает место
		// в списке корней, и команда без явного пути перестаёт проверяться по cwd.
		if (/^\d*[<>]/.test(t)) {
			if (/^\d*[<>]{1,2}$/.test(t)) i++; // `> файл` — цель отдельным токеном
			continue;
		}
		if (tool === "find" && t.startsWith("-")) break; // дальше пошли предикаты find
		if (t.startsWith("-") && t.length > 1) {
			// `-e PATTERN` / `-f FILE` задают шаблон флагом: дальше идут только пути.
			if (PATTERN_OPTS.has(t)) patternSeen = true;
			if (withArg.has(t)) i++;
			continue;
		}
		if (!patternSeen) {
			patternSeen = true; // это шаблон поиска, а не путь
			continue;
		}
		roots.push(t);
	}
	return roots;
}

function resolveRoot(p: string, cwd: string): string {
	let s = p.replace(/^~(?=$|\/)/, HOME).replace(/\$HOME/g, HOME).replace(/\$\{HOME\}/g, HOME);
	if (!isAbsolute(s)) s = join(cwd, s);
	return normalize(s).replace(/\/+$/, "") || "/";
}

/** Корень накрывает $HOME целиком или совпадает с деревом кешей. */
function tooBroad(root: string): boolean {
	if (root === "/" || root === HOME) return true;
	if (HOME.startsWith(root + "/")) return true; // /home, /home/../ и подобное
	return HEAVY.includes(root);
}

function isRecursive(tool: string, tokens: string[]): boolean {
	if (tool !== "grep") return true; // rg/fd/find рекурсивны по своей природе
	return tokens.some((t) => t === "--recursive" || (/^-[^-]/.test(t) && (t.includes("r") || t.includes("R"))));
}

export function scopeReason(command: string, startCwd: string): string | null {
	if (process.env.GREP_SCOPE_GUARD === "0") {
		// Снятый гейт без следа неотличим от соблюдённого правила.
		console.error("[grep-scope-guard] гейт снят через GREP_SCOPE_GUARD=0 — правило НЕ проверялось");
		return null;
	}

	let cwd = startCwd;
	for (const seg of splitSegments(command)) {
		const raw = tokenize(seg);
		if (!raw.length) continue;

		// `cd X` меняет корень для всех следующих сегментов команды.
		if (raw[0] === "cd") {
			const target = raw.find((t, i) => i > 0 && !t.startsWith("-"));
			if (target) cwd = resolveRoot(target, cwd);
			continue;
		}

		// Явный timeout — осознанный долгий поиск, пропускаем. Проверяется до
		// разворота обёрток: общий лексер `timeout` снимает как любую обёртку.
		if (raw[0] === "timeout") continue;

		// Разворот обёрток общим лексером: без него `sudo grep -r ~`,
		// `FOO=1 grep -r ~` и `bash -c "grep -r ~"` головой сегмента давали не grep,
		// и правило не проверялось (проверено прогоном).
		for (const unwrapped of commandSegments(seg)) {
			const h = segmentHead(unwrapped);
			if (!h) continue;
			const tokens = unwrapped.slice(h.index);
			const tool = h.head;
			if (!["grep", "rg", "find", "fd", "fdfind", "ag", "ack"].includes(tool)) continue;
			const kind = tool === "fdfind" ? "fd" : tool === "ag" || tool === "ack" ? "rg" : tool;
			if (!isRecursive(kind, tokens)) continue;

			const roots = searchRoots(kind, tokens);
			const resolved = (roots.length ? roots : ["."]).map((r) => resolveRoot(r, cwd));
			const broad = resolved.find(tooBroad);
			if (!broad) continue;

		return `Поиск с корнем ${broad} накрывает весь домашний каталог: go/pkg/mod, .cargo/registry, node_modules. Это десятки секунд на вызов, а длинные прогоны возвращаются пустым выводом — по нему легко решить «не найдено» и запустить тот же поиск повторно.

Что делать вместо этого:
· ищи в каталоге проекта — \`rg -n "PATTERN" /путь/к/проекту\` (rg уважает .gitignore и на порядок быстрее grep -r);
· не знаешь, где проект — сначала сузь список каталогов: \`ls ~\`, \`fd -t d -d 2 . ~\`;
· по Go/Rust/Python символам бери lsp_workspace_symbols / lsp_references — это точнее текстового поиска.

Если поиск по всему дому действительно нужен — оберни его в таймаут, тогда пропущу: \`timeout 60 rg -n "PATTERN" --glob '!go/pkg/mod/**' --glob '!.cargo/**' --glob '!node_modules/**' ~ | head -50\``;
		}
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return undefined;
		const cmd = (event.input as { command?: string }).command ?? "";
		if (!cmd) return undefined;
		const reason = scopeReason(cmd, process.cwd());
		if (reason) return { block: true, reason };
		return undefined;
	});
}
