/**
 * Custom-GCL PreCommit Gate Extension (pi)
 *
 * Перенос логики хука Claude Code `~/.claude/hooks/custom-gcl-precommit.sh`
 * на механизм расширений pi: событие `tool_call` для bash.
 *
 * Назначение: когда агент собирается выполнить `git commit` со staged/изменёнными
 * `*.go` файлами — прогнать custom-gcl (gid.team) по диффу коммита и, если на
 * строках коммита есть нарушения, заблокировать коммит.
 *
 * Соответствие оригинальному bash-хуку:
 *   - Набор правил берётся у репозитория, если он свой: гейт обязан говорить то
 *     же, что скажет `make lint` у человека, иначе расхождение работает в обе
 *     стороны — прогон уходит зелёным, а нарушения возвращаются у супервизора,
 *     либо коммит блокируется правилом, которого в проекте нет. Своего набора
 *     нет — остаются gid-правила (`--gid-rules-only` с v0.38.2); стоковый набор
 *     (staticcheck, gocritic, gosec, revive, unparam + goimports) тогда не гоняет
 *     никто, а форматирование закрывает goimports-on-edit.
 *   - Issues на строках коммита блокируют коммит; ошибки запуска линтера — нет
 *     (не залипаем, в интерактиве спрашиваем пользователя).
 *
 * Управление:
 *   CUSTOM_GCL_PRECOMMIT=0  — выключить гейт целиком
 *   CUSTOM_GCL_FULL=1       — вернуть полный набор правил (если своего golangci-lint нет)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { commandSegments, gitSubcommandOf } from "./utils";

// Команда вида `git commit` (напр. `git commit -m "..."`, `git -C x commit`).
const GIT_COMMIT_RE = /\bgit\b[^|;&]*[\s]+commit([\s]|$)/;
// commit с -a/--all берёт worktree, обычный коммит — индекс.
const GIT_COMMIT_ALL_RE = /\bgit\b[^|;&]*[\s]+commit[\s]+[^|;&]*(-[a-zA-Z]*a|--all)\b/;
// Первый `cd <path>` в цепочке команд.
const CD_RE = /(?:^|&&|;)\s*cd\s+([^&|;]+)/;
// git -C <path>
const GIT_C_RE = /\bgit\s+-C\s+([^\s]+)/;

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = (event.input as { command?: string }).command ?? "";
		if (!command) return undefined;

		// Гейт можно полностью выключить.
		if (process.env.CUSTOM_GCL_PRECOMMIT === "0") {
			// Снятый гейт без следа неотличим от соблюдённого правила.
			console.error("[custom-gcl-precommit] гейт снят через CUSTOM_GCL_PRECOMMIT=0 — правило НЕ проверялось");
			return undefined;
		}

		// Интересуют только команды, содержащие `git commit`.
		if (!GIT_COMMIT_RE.test(command)) return undefined;

		// Индексация и коммит одной командой — слепое пятно гейта: хук смотрит
		// индекс ДО выполнения команды, а `git add` в ней ещё не отработал, поэтому
		// изменённых файлов «нет» и коммит уходит непроверенным. Молча пропустить
		// такой коммит хуже, чем потребовать два вызова: гейт, который иногда не
		// срабатывает, не гейт (найдено разбором коммита c16769d, UDMP-3766).
		if (stagesInSameCommand(command)) {
			return {
				block: true,
				reason: [
					"Индексация и коммит в одной команде — раздели на два вызова:",
					"  1) git add <файлы>",
					"  2) git commit -m \"…\"",
					"Гейт стайлгайда судит индекс на момент запуска команды, и при `git add … && git commit …`",
					"он видит пустой индекс — коммит уходит без проверки.",
				].join("\n"),
			};
		}

		// ── 1. Рабочая директория: ctx.cwd + опциональный `cd ...` / `git -C ...`
		let dir = ctx.cwd;
		const cdMatch = command.match(CD_RE);
		if (cdMatch) {
			dir = stripQuotes(cdMatch[1].trim());
		} else {
			const cMatch = command.match(GIT_C_RE);
			if (cMatch) dir = cMatch[1];
		}
		dir = dir.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");

		// ── 2. Корень репозитория; не репозиторий — не гейтим.
		const rootRes = await exec(pi, "git", ["-C", dir, "rev-parse", "--show-toplevel"]);
		if (rootRes.code !== 0) return undefined;
		const root = rootRes.stdout.trim();
		if (!root) return undefined;

		// ── 3. range: `commit -a` -> worktree (HEAD), иначе индекс (--cached).
		const range = GIT_COMMIT_ALL_RE.test(command) ? ["HEAD"] : ["--cached"];

		// ── 4. Изменённые *.go, кроме testdata/ (фикстуры анализаторов намеренно
		//       нарушают правила и не собираются).
		const names = await exec(pi, "git", [
			"-C", root, "diff", ...range, "--name-only", "--diff-filter=ACMR", "--", "*.go",
		]);
		const files = names.stdout
			.split("\n")
			.map((f) => f.trim())
			.filter((f) => f && !/(^|\/)testdata\//.test(f));
		if (files.length === 0) return undefined;

		// ── 5. Есть ли custom-gcl в PATH — нет, значит гейтить нечем.
		const linter = await exec(pi, "bash", ["-c", "command -v custom-gcl"]);
		if (linter.code !== 0 || !linter.stdout.trim()) return undefined;
		const bin = linter.stdout.trim().split("\n")[0];

		// ── 6. Раскладываем файлы по ближайшему go.mod вверх по дереву (до корня
		//       репозитория). Без этого линтер запускался из корня по любым путям с
		//       *.go: файлы вне модуля (примеры стайл-гайдов, сниппеты в конфигах)
		//       роняли его целиком с "no go files to analyze" (exit 5), а вложенные
		//       модули анализировались чужим контекстом. Файлы без go.mod над ними
		//       анализировать нечем — тихо пропускаем.
		const byModule = new Map<string, string[]>();
		for (const f of files) {
			const mod = findModule(root, dirname(f));
			if (mod === null) continue;
			const list = byModule.get(mod);
			if (list) list.push(f);
			else byModule.set(mod, [f]);
		}
		if (byModule.size === 0) return undefined;

		// ── 7. Режим. Есть у репозитория собственный набор правил — гейт берёт
		//       ЕГО: гейт обязан говорить то же, что скажет `make lint` у человека.
		//       Разные наборы означают, что прогон уходит зелёным, а нарушения
		//       возвращаются уже на стороне супервизора; бывает и обратное — гейт
		//       блокирует коммит правилом, которого в проекте нет.
		//       Своего набора нет — остаётся --gid-rules-only: стоковый тогда
		//       никто не гоняет, а вшитые gid-правила есть всегда.
		//       gid-config --gid-rules-only печатает "default: none" только в
		//       rules-only варианте — это и есть проверка поддержки бинарём.
		const mode: string[] = [];
		const full = process.env.CUSTOM_GCL_FULL === "1";
		const repoRules = [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"]
			.map((name) => `${root}/${name}`)
			.find((file) => existsSync(file));
		if (repoRules) {
			mode.push("--config", repoRules);
		} else if (!full) {
			const cfg = await exec(pi, bin, ["gid-config", "--gid-rules-only"]);
			if (/^\s*default:\s*none\s*$/m.test(cfg.stdout)) mode.push("--gid-rules-only");
		}

		const issues: string[] = []; // нарушения на строках коммита (exit 1)
		const failures: string[] = []; // сбои запуска линтера (exit >= 2)

		// ── 8. По модулю: свой патч и пакеты — путями относительно модуля, запуск
		//       из каталога модуля.
		for (const [mod, modFiles] of byModule) {
			const modDir = mod === "." ? root : `${root}/${mod}`;
			// Аргументы git — позиционными, не интерполяцией в строку шелла:
			// имя каталога модуля приходит из вывода git и в команду не вклеивается.
			const gitArgs = [
				"diff",
				...range,
				...(mod === "." ? [] : [`--relative=${mod}`]),
				"--",
				"*.go",
			];
			const patchRes = await exec(pi, "bash", [
				"-c",
				'p=$(mktemp) && git -C "$1" "${@:2}" > "$p" && printf %s "$p"',
				"pi-custom-gcl",
				root,
				...gitArgs,
			]);
			const patch = patchRes.code === 0 ? patchRes.stdout.trim() : "";
			if (!patch) continue;

			try {
				const pkgs = [
					...new Set(modFiles.map((f) => "./" + dirname(mod === "." ? f : f.slice(mod.length + 1)))),
				].sort();
				if (pkgs.length === 0) continue;

				const out = await exec(pi, bin, [
					"run",
					...mode,
					"--new-from-patch", patch,
					"--whole-files=false",
					"--show-stats=false",
					"--max-issues-per-linter=0",
					"--max-same-issues=0",
					"--timeout=150s",
					...pkgs,
				], { cwd: modDir, timeout: 160_000 });
				const code = out.code;

				// чисто — идём дальше; exit 5 — "no go files to analyze": в модуле
				// нечего смотреть (пустой пакет, build-теги), это не сбой линтера.
				if (code === 0 || code === 5) continue;

				let report = (out.stdout + out.stderr).trim();
				if (!report) continue;
				if (mod !== ".") report = `[модуль ${mod}]\n${report}`;

				if (code === 1) issues.push(report);
				else failures.push(`custom-gcl не отработал (exit ${code}):\n${report}`);
			} finally {
				await exec(pi, "rm", ["-f", patch]);
			}
		}

		// нарушения на строках коммита — жёстко блокируем
		if (issues.length > 0) {
			return {
				block: true,
				reason: [
					"custom-gcl нашёл нарушения на строках этого коммита. Почини код (не правила линтера и не nolint) и повтори коммит.",
					"",
					truncate(issues.join("\n"), 6000),
				].join("\n"),
			};
		}

		if (failures.length === 0) return undefined;

		// ошибка запуска линтера (code >= 2): не залипаем.
		// Интерактив — спросить; автономно — пропустить с предупреждением.
		const msg = [
			"custom-gcl не отработал — гейт пропущен, проверь линтер вручную.",
			"",
			truncate(failures.join("\n"), 6000),
		].join("\n");

		if (ctx.hasUI) {
			const ok = await ctx.ui.confirm("custom-gcl не отработал", msg + "\n\nПродолжить коммит?", {
				timeout: 15_000,
			});
			if (!ok) return { block: true, reason: "Коммит отклонён из-за сбоя линтера (см. выше)." };
		}
		// без UI — пропускаем (не залипаем), но логируем в stderr pi.
		process.stderr.write("[custom-gcl-precommit] " + msg + "\n");
		return undefined;
	});
}

async function exec(
	pi: ExtensionAPI,
	cmd: string,
	args: string[],
	opts: { cwd?: string; timeout?: number } = {},
) {
	try {
		return await pi.exec(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 10_000 });
	} catch {
		return { stdout: "", stderr: "", code: -1, killed: false };
	}
}

/**
 * Меняет ли команда индекс перед тем, как из неё же сделать коммит.
 *
 * Разбор сегментами, а не регуляркой: `git add` может прятаться за обёрткой
 * (`cd x && env A=B git add …`), а слово add — встретиться в сообщении коммита.
 * Учитываются подкоманды, которые двигают индекс сами: add/stage и rm/mv, у
 * которых индекс — побочный эффект.
 */
export function stagesInSameCommand(command: string): boolean {
	let stages = false;
	let commits = false;
	for (const seg of commandSegments(command)) {
		const g = gitSubcommandOf(seg);
		if (!g) continue;
		if (g.sub === "add" || g.sub === "stage") stages = true;
		// `git rm/mv --cached` и обычные формы правят индекс; `--dry-run` — нет.
		if ((g.sub === "rm" || g.sub === "mv") && !g.args.some((a) => a === "--dry-run" || a === "-n")) stages = true;
		if (g.sub === "commit") commits = true;
	}
	return stages && commits;
}

function stripQuotes(s: string): string {
	if (s.length >= 2) {
		if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
			return s.slice(1, -1);
		}
	}
	return s;
}

function dirname(f: string): string {
	const i = f.lastIndexOf("/");
	return i === -1 ? "." : f.slice(0, i);
}

/**
 * Ближайший каталог с go.mod вверх от `dir` (путь относительно `root`, "." — корень
 * репозитория). null — файл вне модуля: анализировать его нечем.
 */
function findModule(root: string, dir: string): string | null {
	let d = dir;
	for (;;) {
		if (existsSync(`${root}/${d}/go.mod`)) return d;
		if (d === ".") return null;
		d = dirname(d);
	}
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, n);
}
