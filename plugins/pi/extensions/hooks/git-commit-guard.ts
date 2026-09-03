/**
 * require-git-commit-skill — PreToolUse Bash.
 *
 * Запрещает ручные git-команды, которые обходят git-хуки репозитория или
 * затягивают CRLF-шум: --no-verify, git add -A/--all/., git commit -a/-am,
 * trailers (Signed-off-by / Co-Authored-By). Коммитить — только через скилл
 * git-commit.
 *
 * Маркером «коммит идёт через скилл» служит ЯВНАЯ ПОДПИСЬ (-S/--gpg-sign):
 * личные настройки требуют подписанных коммитов, поэтому --no-gpg-sign, наоборот,
 * запрещён. Раньше маркером был как раз --no-gpg-sign — хук требовал его, а скилл
 * требовал подпись, и агент выбирался из противоречия единственным проходящим
 * способом: коммитил неподписанным. Так накопились сотни неподписанных коммитов.
 *
 * Управление: GIT_COMMIT_GUARD=0 — выключить.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandSegments, gitSubcommandOf, hasShort } from "./utils";

export function gitCommitReason(command: string): string | null {
	if (process.env.GIT_COMMIT_GUARD === "0") {
		console.error("[git-commit-guard] гейт снят через GIT_COMMIT_GUARD=0 — правило НЕ проверялось");
		return null;
	}
	const hasCoauthor = /Co-Authored-By/i.test(command);

	// Сегменты с развёрнутыми обёртками и сохранёнными границами слов: маскировка
	// литералов регуляркой прятала `eval "git commit …"`, а текст сообщения
	// коммита мог попасть в разбор флагов.
	for (const seg of commandSegments(command)) {
		const g = gitSubcommandOf(seg);
		if (!g) continue;
		const sub = g.sub;
		const args = g.args;

		// `git -c core.hooksPath=/dev/null commit` — точный эквивалент --no-verify,
		// записанный глобальной опцией: опции ищем во всём сегменте, до подкоманды тоже.
		for (const a of seg) {
			if (/^(--config=)?core\.hookspath=/i.test(a))
				return "core.hooksPath=… отключает git-хуки репозитория — это тот же обход, что --no-verify.";
		}
		for (const a of args) {
			if (a === "--no-verify") return "--no-verify запрещён — не обходи git-хуки репозитория.";
			if (sub === "commit" && hasShort(a, "n"))
				return "-n (короткая форма --no-verify) запрещён — не обходи git-хуки репозитория.";
		}

		if (sub === "add") {
			for (const a of args) {
				if (hasShort(a, "A"))
					return "git add — только с явным списком файлов: флаг -A затянет CRLF-шум.";
				if (["-A", "--all", ".", "./", ":/", ":"].includes(a))
					return "git add — только с явным списком файлов: -A/--all/./:/  затянут CRLF-шум (правило скилла git-commit).";
			}
		}

		if (sub === "commit") {
			let signed = 0;
			for (const a of args) {
				if (hasShort(a, "a"))
					return "git commit -a/-am запрещён — добавляй файлы явно через git add (правило скилла git-commit).";
				if (hasShort(a, "s"))
					return "Trailers (Signed-off-by) в коммитах запрещены — правило скилла git-commit.";
				if (hasShort(a, "S") || a === "--gpg-sign" || a.startsWith("--gpg-sign=")) signed = 1;
				if (a === "--no-gpg-sign")
					return "--no-gpg-sign запрещён: коммиты подписываются GPG (личные настройки, CLAUDE.md). Подпись берётся из commit.gpgsign/user.signingkey репозитория, флаг -S её объявляет явно.";
				if (a === "--all")
					return "git commit --all запрещён — добавляй файлы явно через git add.";
				if (a === "--signoff")
					return "Trailers (Signed-off-by) в коммитах запрещены — правило скилла git-commit.";
			}
			if (!signed)
				return "Коммить только через скилл git-commit (он ставит -S, отсеивает CRLF-шум и не добавляет trailers). Вызови скилл git-commit вместо ручного git commit.";
			if (hasCoauthor)
				return "Trailers (Co-Authored-By) в коммитах запрещены — правило скилла git-commit.";
		}
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return undefined;
		const cmd = (event.input as { command?: string }).command ?? "";
		if (!cmd) return undefined;
		const reason = gitCommitReason(cmd);
		if (reason) return { block: true, reason };
		return undefined;
	});
}
