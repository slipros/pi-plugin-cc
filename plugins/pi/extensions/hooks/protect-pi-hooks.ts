/**
 * protect-pi-hooks — PreToolUse Bash|Write|Edit.
 *
 * Запрещает агенту править собственную обвязку: файлы расширений
 * (`~/.pi/agent/extensions/**`, `~/.pi/agent/subagent-extensions/**`) и
 * `~/.pi/agent/settings.json`, где перечислены загружаемые пакеты.
 *
 * Зачем. Все остальные хуки — код в том же процессе, а у built-in тулов права
 * процесса pi (docs/security.md: «No Built-in Sandbox»). До этого хука ни одно
 * правило не мешало агенту переписать сам хук, снести строку из `packages` или
 * запустить дочерний pi с `PI_HOOKS_OFF=…` — то есть любое правило снималось
 * изнутри сессии. Хук не даёт герметичности (её даёт только контейнер или права
 * ФС), но переводит снятие защиты из «одна правка файла» в «явный обход».
 *
 * Три поверхности:
 *   1) запись в защищённые пути — write/edit по пути, bash по цели записи;
 *   2) удаление и перемещение (`rm`, `mv`, `ln -sf`), а также разрушающие
 *      git-команды в репозитории `~/.pi` (`reset --hard`, `clean`, `checkout`);
 *   3) запуск дочернего `pi` с env, снимающим состав хуков или отдельный гейт
 *      (`PI_HOOKS`, `PI_HOOKS_OFF`, `*_GUARD=0`) — env текущего процесса агент
 *      сменить не может, а вот делегировать себе работу без хуков мог.
 *
 * Управление: PROTECT_PI_HOOKS=0 — выключить (для правки хуков человеком; в
 * дочернем pi это же значение блокируется пунктом 3, чтобы агент не выставил его сам).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, normalize, isAbsolute } from "node:path";
import { basename, commandSegments, gitSubcommandOf, segmentHead, tokenize, writeTargets } from "./utils";

const HOME = homedir();
const PI_ROOT = join(HOME, ".pi");
/** Что защищаем: код расширений и список загружаемых пакетов. */
const PROTECTED = [
	join(PI_ROOT, "agent/extensions"),
	join(PI_ROOT, "agent/subagent-extensions"),
	join(PI_ROOT, "agent/settings.json"),
];

/** Команды, чей аргумент исчезает или подменяется без всякой «записи». */
const DESTROYERS = new Set(["rm", "rmdir", "unlink", "shred", "mv", "ln"]);
/**
 * Смена прав и атрибутов: сама по себе файл не меняет, но снимает защиту ФС
 * (`chmod 444` от ВЛАДЕЛЬЦА снимается его же `chmod u+w`), после чего запись
 * разрешена. Ловится отдельно, чтобы совет «сделай хуки read-only» имел смысл.
 */
const PERMS = new Set(["chmod", "chown", "chgrp", "chattr", "setfacl"]);
/** Git-операции, откатывающие рабочее дерево целиком — правку хука они тоже снимут. */
const GIT_DESTROYERS = new Set(["reset", "clean", "checkout", "restore", "stash", "revert"]);

/**
 * env, снимающий защиту: состав хуков целиком или отдельный гейт.
 * `PI_HOOKS_DISPLAY` печатает состав и ничего не меняет — он разрешён.
 */
const HOOK_ENV_ANY = new Set(["PI_HOOKS", "PI_HOOKS_ON", "PI_HOOKS_OFF"]);
const HOOK_ENV_OFF = new Set([
	"PROTECT_PI_HOOKS", "GIT_STASH_GUARD", "GIT_COMMIT_GUARD", "PROTECT_SECRETS",
	"GO_CACHE_GUARD", "GREP_SCOPE_GUARD", "SQL_SEMICOLON_GUARD", "CUSTOM_GCL_PRECOMMIT",
	"TEST_ONLY_GUARD",
]);

function resolvePath(p: string, cwd: string): string {
	let s = p.replace(/^~(?=$|\/)/, HOME).replace(/\$\{?HOME\}?/g, HOME);
	if (!isAbsolute(s)) s = join(cwd, s);
	return normalize(s).replace(/\/+$/, "");
}

function isProtected(p: string, cwd: string): string | null {
	const abs = resolvePath(p, cwd);
	return PROTECTED.find((root) => abs === root || abs.startsWith(root + "/")) ?? null;
}

const WRITE_REASON = (target: string) =>
	`${target} — обвязка самого агента (код расширений и список загружаемых пакетов). Править её изнутри сессии нельзя: этим снимается любое другое правило, включая то, которое сейчас мешает.\n\nЧто делать вместо этого:\n· правку хука нужно ОБСУДИТЬ — опиши в отчёте, что и почему меняешь, человек внесёт правку сам;\n· хук мешает верной работе — скажи об этом прямо, это баг хука, а не повод его обойти;\n· нужен состав хуков для отладки — \`PI_HOOKS_DISPLAY=1\` печатает его и ничего не меняет.`;

/** Путь, куда пишет write/edit. */
export function pathReason(path: string, cwd: string): string | null {
	const hit = isProtected(path, cwd);
	return hit ? WRITE_REASON(path) : null;
}

export function bashReason(command: string, cwd: string): string | null {
	// 1. Запись: перенаправления, tee, sed -i, cp/mv-приёмник, git checkout -- <path>.
	for (const t of writeTargets(command)) {
		if (isProtected(t, cwd)) return WRITE_REASON(t);
	}

	for (const seg of commandSegments(command)) {
		const head = segmentHead(seg);
		if (!head) continue;

		// 2. Удаление и подмена: `writeTargets` их не видит — файл не «пишется».
		if (DESTROYERS.has(head.head)) {
			const victim = seg.slice(head.index + 1).find((a) => !a.startsWith("-") && isProtected(a, cwd));
			if (victim) return WRITE_REASON(victim);
		}

		// 2b. Смена прав/атрибутов — подготовка к записи, а не сама запись.
		if (PERMS.has(head.head)) {
			const victim = seg.slice(head.index + 1).find((a) => !a.startsWith("-") && isProtected(a, cwd));
			if (victim)
				return `\`${head.head}\` на ${victim} снимает защиту файлов обвязки агента. Права на них выставлены сознательно; менять их изнутри сессии — тот же обход, что правка самого хука.\n\nНужна правка обвязки — опиши её в отчёте, человек внесёт и права, и код.`;
		}

		// 3. Откат рабочего дерева в репозитории ~/.pi снимает правку целиком,
		// не касаясь ни одного файла по имени.
		const g = gitSubcommandOf(seg);
		if (g && GIT_DESTROYERS.has(g.sub)) {
			const cIdx = seg.findIndex((t) => t === "-C");
			const repo = cIdx !== -1 && cIdx + 1 < seg.length ? resolvePath(seg[cIdx + 1], cwd) : resolvePath(".", cwd);
			if (repo === PI_ROOT || repo.startsWith(PI_ROOT + "/")) {
				return `\`git ${g.sub}\` в ${PI_ROOT} откатывает рабочее дерево вместе с обвязкой агента — это то же снятие защиты, только без правки файла по имени.\n\nНужно вернуть состояние репозитория — попроси человека: он видит, что именно откатывается.`;
			}
		}

		// 4. `pi uninstall <пакет>` вынимает расширение из состава так же, как правка settings.json.
		if (head.head === "pi") {
			const sub = seg.slice(head.index + 1).find((a) => !a.startsWith("-"));
			if (sub === "uninstall" || sub === "remove")
				return `\`pi ${sub}\` вынимает расширение из состава — это правка обвязки агента в обход файла settings.json.\n\nСостав меняет человек.`;
		}
	}

	// 5. Дочерний pi с env, снимающим хуки. Смотрим СЫРЫЕ токены: общий лексер
	// разворачивает `env A=B cmd` и выбрасывает присваивания, а здесь важны именно они.
	const raw = tokenize(command);
	const runsPi = raw.some((t, i) => basename(t) === "pi" && !raw[i - 1]?.startsWith("<"));
	if (runsPi) {
		for (const t of raw) {
			const eq = t.indexOf("=");
			if (eq <= 0 || t.startsWith("-")) continue;
			const name = t.slice(0, eq);
			const value = t.slice(eq + 1);
			if (HOOK_ENV_ANY.has(name) || (HOOK_ENV_OFF.has(name) && value === "0")) {
				return `\`${name}=${value}\` при запуске pi снимает хуки в дочерней сессии — правило, которое мешает здесь, перестанет действовать там. Это обход, а не решение.\n\nЧто делать вместо этого:\n· задача правда требует другого состава хуков — опиши это в отчёте, состав меняет человек;\n· нужен только СОСТАВ для отладки — \`PI_HOOKS_DISPLAY=1\` печатает его и ничего не снимает.`;
			}
		}
	}

	return null;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (process.env.PROTECT_PI_HOOKS === "0") {
			// Снятый гейт без следа неотличим от соблюдённого правила.
			console.error("[protect-pi-hooks] гейт снят через PROTECT_PI_HOOKS=0 — правило НЕ проверялось");
			return undefined;
		}
		const cwd = process.cwd();
		if (event.toolName === "bash") {
			const cmd = (event.input as { command?: string }).command ?? "";
			if (!cmd) return undefined;
			const reason = bashReason(cmd, cwd);
			return reason ? { block: true, reason } : undefined;
		}
		if (event.toolName === "write" || event.toolName === "edit") {
			const path = (event.input as { path?: string }).path ?? "";
			if (!path) return undefined;
			const reason = pathReason(path, cwd);
			return reason ? { block: true, reason } : undefined;
		}
		return undefined;
	});
}
