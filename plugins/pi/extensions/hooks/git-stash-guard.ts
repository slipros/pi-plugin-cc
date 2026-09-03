/**
 * git-stash-guard — PreToolUse Bash.
 *
 * Запрещает `git stash` (кроме list/show/apply/pop/branch): прячет работу, со
 * стороны выглядит как потерянный прогон, а в worktree-режиме refs/stash общий
 * на репозиторий — можно забрать правки соседнего агента.
 *
 * Управление: GIT_STASH_GUARD=0 — выключить.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandSegments, gitSubcommandOf } from "./utils";

const STASH_ALLOWED_OPS = new Set(["list", "show", "apply", "pop", "branch"]);

export function gitStashReason(command: string): string | null {
	if (process.env.GIT_STASH_GUARD === "0") {
		// Снятый гейт без следа неотличим от соблюдённого правила.
		console.error("[git-stash-guard] гейт снят через GIT_STASH_GUARD=0 — правило НЕ проверялось");
		return null;
	}
	// Сегменты с развёрнутыми обёртками: прежний разбор регуляркой пропускал
	// `eval "git stash"` и `(cd /r && git stash)`, а `grep -rn git stash .`
	// блокировал как вызов (проверено).
	for (const seg of commandSegments(command)) {
		const g = gitSubcommandOf(seg);
		if (!g || g.sub !== "stash") continue;
		// Поиск операции останавливается на `--`: дальше идут pathspec'ы, и
		// `git stash -- pop` — это СОХРАНЕНИЕ файла с именем `pop`, а читалось как
		// разрешённый `pop`.
		let op = "";
		for (const tk of g.args) {
			if (tk === "--") break;
			if (!tk || tk.startsWith("-")) continue;
			op = tk;
			break;
		}
		if (STASH_ALLOWED_OPS.has(op)) continue;
		return "git stash прячет работу: со стороны это выглядит как потерянный прогон, а в worktree-режиме refs/stash общий на репозиторий — заберёшь правки соседнего агента.\n\nЧто делать вместо этого:\n· нужен замер гейта на чистом дереве — сними его во втором рабочем дереве: `git worktree add /tmp/base-<id> <BASE>`; своё дерево не трогай;\n· нужно посмотреть свои правки — `git diff` / `git diff --stat`;\n· правки мешают — закоммить их через скилл git-commit, откат делается коммитом.\n\nВосстановление уже спрятанного разрешено: git stash list / show / apply / pop.";
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return undefined;
		const cmd = (event.input as { command?: string }).command ?? "";
		if (!cmd) return undefined;
		const reason = gitStashReason(cmd);
		if (reason) return { block: true, reason };
		return undefined;
	});
}
