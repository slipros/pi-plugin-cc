/**
 * hooks — единое расширение pi, объединяющее все хуки.
 *
 * Каждый хук — отдельный файл в этой папке; здесь он регистрируется в REGISTRY,
 * и состав включённых хуков задаётся снаружи одним параметром, а не россыпью
 * персональных env по файлам.
 *
 * Состав (env):
 *   PI_HOOKS=a,b,c      — явный список: включены ровно эти, остальные выключены
 *   PI_HOOKS_ON=a,b     — добавить к составу по умолчанию (единственный способ
 *                         включить хук с optIn: true или profileOnly: true)
 *   PI_HOOKS_OFF=a,b    — исключить из состава
 *   PI_HOOKS_DISPLAY=1  — напечатать итоговый состав в stderr (отладка)
 *
 * Приоритет: PI_HOOKS (если задан) > дефолт + PI_HOOKS_ON; PI_HOOKS_OFF режет
 * поверх любого из них.
 *
 * `optIn: true` — хук, нужный только в диалоге с человеком. Так помечен
 * memory-recall: интерактивной сессии (`pi` в терминале) память нужна — там
 * спрашивают «кто я», «что решили в прошлый раз»; автономному прогону
 * (delegate, песочница, CI) её уже вложили в постановку, а оглавление стоит
 * токенов и похода к MuninnDB. Поэтому optIn-хуки включаются сами при работе
 * в TTY и молчат в headless. Любой из env выше перебивает это решение —
 * так профиль go-mem включает память в неинтерактивной песочнице.
 *
 * `profileOnly: true` — хук, который осмыслен только у профиля, объявившего его:
 * так помечен test-only-guard. Он режет `git add`/`git commit` всего, что не
 * тест, — граница QA-профиля, а не общее правило. В составе по умолчанию он
 * превращал любой прогон без PI_HOOKS (хостовый запуск, continue от прогона без
 * пресета) в QA-прогон: агент дописывал прод-код, коммит молча отклонялся, и
 * работа оставалась в рабочем дереве незакоммиченной. В отличие от optIn, TTY
 * его не включает: диалог с человеком — не повод запрещать коммит прод-кода.
 *
 * У отдельных хуков остаются свои env для тонкой настройки поведения
 * (пороги, пути) — см. шапки файлов. Здесь решается только «работает/нет».
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import gitCommitGuard from "./git-commit-guard";
import customGclPrecommit from "./custom-gcl-precommit";
import protectSecrets from "./protect-secrets";
import gitStashGuard from "./git-stash-guard";
import goCacheGuard from "./go-cache-guard";
import sqlSemicolonGuard from "./sql-semicolon-guard";
import goimportsOnEdit from "./goimports-on-edit";
import outputHygiene from "./output-hygiene";
import lspDiagnosticsNudge from "./lsp-diagnostics-nudge";
import grepScopeGuard from "./grep-scope-guard";
import memoryRecall from "./memory-recall";
import protectPiHooks from "./protect-pi-hooks";
import testOnlyGuard from "./test-only-guard";
import complexityNudge from "./complexity-nudge";

interface HookDef {
	fn: (pi: ExtensionAPI) => void;
	optIn?: boolean;
	profileOnly?: boolean;
	about: string;
}

const REGISTRY: Record<string, HookDef> = {
	"git-commit-guard": { fn: gitCommitGuard, about: "PreToolUse Bash: запрет ручных git-команд" },
	"custom-gcl-precommit": { fn: customGclPrecommit, about: "PreToolUse Bash: гейт custom-gcl (gid-правила) на git commit" },
	"protect-secrets": { fn: protectSecrets, about: "PreToolUse Bash: запрет раскрытия секретов" },
	"git-stash-guard": { fn: gitStashGuard, about: "PreToolUse Bash: запрет git stash" },
	"sql-semicolon-guard": { fn: sqlSemicolonGuard, about: "PreToolUse Write|Edit: ';' в комментариях SQL" },
	"go-cache-guard": { fn: goCacheGuard, about: "PreToolUse Bash: запрет сноса кеша Go-модулей" },
	"goimports-on-edit": { fn: goimportsOnEdit, about: "PostToolUse Write|Edit: автоформат Go" },
	"output-hygiene": { fn: outputHygiene, about: "PostToolUse Bash: напоминание фильтровать вывод" },
	"lsp-diagnostics-nudge": { fn: lspDiagnosticsNudge, about: "PostToolUse Write|Edit: напоминание прогнать lsp_diagnostics" },
	"complexity-nudge": { fn: complexityNudge, about: "PostToolUse Write|Edit: сигнал о сложности изменённого файла" },
	"grep-scope-guard": { fn: grepScopeGuard, about: "PreToolUse Bash: запрет рекурсивного поиска по всему $HOME" },
	"protect-pi-hooks": { fn: protectPiHooks, about: "PreToolUse Bash|Write|Edit: запрет правки обвязки агента (~/.pi) и запуска pi со снятыми хуками" },
	"test-only-guard": { fn: testOnlyGuard, profileOnly: true, about: "PreToolUse Bash: в коммит уходят только тесты (QA-профили)" },
	"memory-recall": { fn: memoryRecall, optIn: true, about: "before_agent_start: оглавление памяти MuninnDB в системный промпт" },
};

function parseList(name: string): string[] {
	return (process.env[name] || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function selection(): string[] {
	const known = Object.keys(REGISTRY);
	const explicit = parseList("PI_HOOKS");
	const on = parseList("PI_HOOKS_ON");
	const off = new Set(parseList("PI_HOOKS_OFF"));

	// Опечатка в имени не должна тихо отключать защитный хук — сообщаем и идём дальше.
	for (const name of [...explicit, ...on, ...off]) {
		if (!known.includes(name)) console.error(`[hooks] неизвестный хук в env: ${name}`);
	}

	// Интерактивная сессия = диалог с человеком: optIn-хуки (память) включаются сами.
	const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

	const base = explicit.length
		? explicit.filter((n) => known.includes(n))
		: known.filter(
				(n) =>
					(!REGISTRY[n].optIn || interactive || on.includes(n)) &&
					(!REGISTRY[n].profileOnly || on.includes(n))
			);

	return base.filter((n) => !off.has(n));
}

export default function (pi: ExtensionAPI) {
	const enabled = selection();
	for (const name of enabled) REGISTRY[name].fn(pi);
	if (process.env.PI_HOOKS_DISPLAY === "1") {
		console.error(`[hooks] включено ${enabled.length}/${Object.keys(REGISTRY).length}: ${enabled.join(", ")}`);
	}
}
