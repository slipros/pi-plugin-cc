/**
 * protect-secrets — PreToolUse Bash.
 *
 * Запрещает команды, которые могут раскрыть содержимое секретов (.env, ключи
 * SSH, kubeconfig, credentials и т.п.) в контекст. Разрешено только то, что
 * содержимое не читает: ls/test/stat/file/find, права и перемещение, запись
 * (cp .env.example .env). Если содержимое правда нужно — пользователь выполняет
 * команду сам через '! <команда>'.
 *
 * Управление: PROTECT_SECRETS=0 — выключить.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { segments, basename, scrub, stripCommentLiterals } from "./utils";

const SENSITIVE =
	"((^|[\\s\"'/=<:])\\.env(\\.[A-Za-z0-9_-]+)?\\b|\\.ssh([/\\s\"']|$)|id_rsa|id_ed25519|id_ecdsa|\\.kube/config|\\.aws/(credentials|config)|\\.netrc\\b|\\.npmrc\\b|\\.credentials\\.json|\\.config/(gh|glab-cli)/|\\.docker/config\\.json|/etc/rancher/k3s/|/var/lib/rancher/k3s/server/token|\\.(pem|p12|pfx)\\b)";
const sensitiveRe = new RegExp(SENSITIVE);
const noPathReaders = /kubectl\s+config\s+view[^|;&]*--raw|gh\s+auth\s+token|phase\s+secrets\s+get/;

export function protectSecretsReason(command: string): string | null {
	if (process.env.PROTECT_SECRETS === "0") {
		// Снятый гейт без следа неотличим от соблюдённого правила.
		console.error("[protect-secrets] гейт снят через PROTECT_SECRETS=0 — правило НЕ проверялось");
		return null;
	}
	if (noPathReaders.test(command)) {
		return "Команда печатает секрет целиком (kubeconfig/токен) — запрещено: он попадёт в контекст. Нужны сами значения — выполни команду сам через '! <команда>'.";
	}
	if (!sensitiveRe.test(scrub(command))) return null;

	// Команды, превращающие ВЫВОД предыдущего звена в АРГУМЕНТЫ следующего: путь к
	// секрету доезжает до читающей команды, ни разу не оказавшись рядом с ней
	// (`echo <путь> | xargs cat`). Разбор по `|` разводил их по разным сегментам:
	// звено с путём выглядело безопасным (`echo`), звено с чтением пути не содержало.
	const pipeToArgs = /(^|[\s|])(xargs|parallel)([\s]|$)|while[\s]+(IFS=\S*[\s]+)?read\b/;

	const allowedLink = (seg: string): boolean | undefined => {
		let t = seg.trim().split(/\s+/);
		let i = 0;
		while (i < t.length && (t[i].includes("=") || t[i] === "sudo")) i++;
		const first = basename(t[i] ?? "");

		// Подстановка читает файл независимо от внешней команды:
		// `echo $(cat ~/.ssh/id_rsa)` печатает ключ так же, как сам cat.
		if (/\$\(|`|\$\(<|<[ \t]*[^ \t]*\.env/.test(seg)) return false;

		switch (first) {
			case "ls": case "test": case "stat": case "file": case "touch":
			case "mkdir": case "chmod": case "chown": case "rm": case "echo":
			case "printf": case "export": case "cd": case "true": case ":":
				return true;
			case "find":
				if (/[ \t]-(exec|execdir|ok|okdir|delete|fprint|fprintf)([ \t]|$)/.test(seg)) return false;
				return true;
			case "git": {
				let j = i + 1;
				let sub = "";
				while (j < t.length) {
					const tkn = t[j];
					if (tkn === "-C" || tkn === "-c") { j += 2; continue; }
					if (tkn.startsWith("-")) { j += 1; continue; }
					sub = tkn; break;
				}
				if (["add", "rm", "status", "check-ignore", "update-index", "ls-files"].includes(sub)) return true;
				return false;
			}
			case "cp": case "mv": case "rsync": case "scp": case "install": {
				const rest = t.slice(i + 1);
				const src = rest.slice(0, Math.max(0, rest.length - 1)).join(" ");
				if (rest.length >= 2 && sensitiveRe.test(scrub(src))) return false;
				return true;
			}
			default: {
				// запись в секрет допустима (`… > .env`), но только если источник не секрет
				if (/(^|\s)(>|>>)\s*[^\s]*\.env/.test(seg)) {
					const before = seg.split(">")[0];
					if (sensitiveRe.test(scrub(before))) return false;
					return true;
				}
				return false;
			}
		}
	};

	// Сегмент = конвейер целиком; судятся звенья с чувствительным путём, звенья-фильтры
	// без пути (`| wc -l`) содержимое не раскрывают.
	const allowedSeg = (seg: string): boolean | undefined => {
		if (pipeToArgs.test(seg)) return false;
		for (const link of seg.split("|")) {
			if (!link.trim()) continue;
			if (!sensitiveRe.test(scrub(link))) continue;
			if (!allowedLink(link)) return false;
		}
		return true;
	};

	// Перевод строки — такой же разделитель, как `;`: без него звено с чтением
	// секрета пряталось в хвосте многострочной команды за безобидной головой.
	for (const seg of command.split(/\|\||&&|[;&\n]/)) {
		if (!sensitiveRe.test(scrub(seg))) continue;
		if (allowedSeg(seg)) continue;
		return "Команда обращается к потенциальному секрету (.env, ключи SSH, kubeconfig, credentials и т.п.) способом, который может раскрыть содержимое — запрещено. Секреты не должны попадать в контекст.\nРазрешено только то, что содержимое не читает: ls/test/stat/file/find, права и перемещение, запись (cp .env.example .env).\nЕсли содержимое правда нужно — пользователь выполняет команду сам через '! <команда>'.";
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return undefined;
		const cmd = (event.input as { command?: string }).command ?? "";
		if (!cmd) return undefined;
		const reason = protectSecretsReason(cmd);
		if (reason) return { block: true, reason };
		return undefined;
	});
}
