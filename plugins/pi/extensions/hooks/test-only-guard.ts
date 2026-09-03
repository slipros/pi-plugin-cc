/**
 * test-only-guard — PreToolUse Bash + PostToolUse Bash|Write|Edit.
 *
 * Держит границу QA-профилей: агент проверяет чужой код и пишет тесты, но не
 * чинит продакшн-код. Правило держится не абзацем в промпте, а гейтом.
 *
 * Хук не привязан ни к языку, ни к конкретному профилю: он знает только, какие
 * пути считаются тестовыми (набор ниже покрывает ходовые экосистемы, остальное
 * добавляется через TEST_ONLY_GUARD_ALLOW), и включается тем профилем, которому
 * нужен, — через PI_HOOKS.
 *
 * Где он неуместен: языки, где юнит-тесты живут В продакшн-файле (Rust с
 * `#[cfg(test)]`, doctest'ы Python). Там гейт разрешает лишь тесты, вынесенные в
 * отдельные файлы и каталоги, — профилю, который пишет тесты рядом с кодом, его
 * включать не нужно.
 *
 * Гейт стоит на КОММИТЕ, а не на правке файла — иначе он запретил бы мутационную
 * пробу, без которой тест ничего не доказывает: чтобы убедиться, что новый тест
 * различает требование, проверяемое поведение ломают в продакшн-коде, смотрят на
 * красный и откатывают. Правка временная и обязана исчезнуть; в историю не должно
 * уехать ничего, кроме тестов. Поэтому:
 *
 *   1) `git add <не-тестовый путь>` — блок;
 *   2) `git commit` при изменённых не-тестовых файлах в индексе, рабочем дереве
 *      или среди untracked — блок с перечнем: незавершённая проба видна как
 *      грязный прод, и коммит ждёт её отката;
 *   3) правка не-тестового файла (write/edit или запись из bash) — не блок, а
 *      напоминание в результате тула: это допустимо только как проба, откати.
 *
 * Почему коммита достаточно. Прогон отдаёт наружу две вещи — коммиты и рабочее
 * дерево. Коммит закрыт гейтом, а невосстановленная правка видна супервизору в
 * секции Changes отчёта и в `result --diff`, то есть тихой «починкой» быть
 * перестаёт. Герметичности это не даёт (её даёт только контейнер), но переводит
 * выход за границу профиля из «незаметно» в «явно видно».
 *
 * Управление:
 *   TEST_ONLY_GUARD=0            — выключить гейт целиком;
 *   TEST_ONLY_GUARD_ALLOW=a,*b   — дополнительно разрешённые пути: префикс
 *                                  относительно корня репозитория (`qa/`) или
 *                                  маска имени файла (`*.feature`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAbsolute, join, normalize, relative } from "node:path";
import { realpathSync } from "node:fs";
import { basename, commandSegments, gitSubcommandOf, writeTargets } from "./utils";

/**
 * Каталоги, содержимое которых целиком относится к тестам. `run` не здесь: это
 * каталог артефактов пайплайна, и разрешены в нём только отчёты (`.md`), а не
 * произвольный код — `internal/run/server.go` тестовым не является.
 */
const TEST_DIRS = new Set([
	"testdata", "testutil", "testutils", "testhelper", "testhelpers",
	"test", "tests", "__tests__", "spec", "specs", "e2e", "features", "fixtures",
]);
/**
 * Имя файла называет уровень само — по конвенции своей экосистемы: `_test.go`,
 * `test_x.py`, `x.spec.ts`, `FooTest.java`, `x_spec.rb`. Списком имён, а не одним
 * регэкспом на язык: профиль может быть любым, а имя файла — единственное, что
 * видно гейту.
 */
const TEST_FILE = [
	/_test\.go$/,
	/(^|\/)test_[^/]+\.py$/, /_test\.py$/,
	/\.(test|spec)\.[cm]?[jt]sx?$/,
	/_test\.rs$/, /_test\.exs$/, /_test\.php$/,
	/(Test|Tests|IT)\.(java|kt|cs|scala)$/,
	/_spec\.rb$/, /_test\.rb$/,
	/\.feature$/,
];
/**
 * Манифесты зависимостей: промпт разрешает добавить ТЕСТОВУЮ зависимость, когда
 * в репозитории нечем поднять окружение. Запретить манифест значило бы запретить
 * и это. Правка манифеста при этом видна в диффе и починкой кода не является.
 */
const DEP_MANIFESTS = new Set([
	"go.mod", "go.sum",
	"package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
	"Cargo.toml", "Cargo.lock",
	"pyproject.toml", "poetry.lock", "requirements-dev.txt",
	"Gemfile", "Gemfile.lock", "composer.json", "composer.lock",
]);
/**
 * Compose тестового контура опознаётся по имени файла: `docker-compose.test.yml`,
 * `compose.e2e.yaml`. Общий стек репозитория (`docker-compose.yml`) остаётся
 * закрытым — E2E идёт против него как есть, а не против подправленного.
 */
const TEST_STACK = /(^|[._-])(test|tests|e2e|integration)([._-]|$)/;

/**
 * Расширение под раскладку конкретного репозитория: `TEST_ONLY_GUARD_ALLOW`
 * принимает пути-префиксы (`qa/`, `internal/probe`) и шаблоны имён по маске
 * (`*.feature`, `*Spec.scala`). Одного из двух не хватает: тесты бывают и
 * отдельным деревом, и файлом по конвенции рядом с кодом.
 */
function allowedRules(): { prefixes: string[]; suffixes: string[] } {
	const prefixes: string[] = [];
	const suffixes: string[] = [];
	for (const raw of (process.env.TEST_ONLY_GUARD_ALLOW || "").split(",")) {
		const s = raw.trim();
		if (!s) continue;
		if (s.startsWith("*")) suffixes.push(s.slice(1));
		else prefixes.push(s.replace(/^\.?\//, "").replace(/\/+$/, ""));
	}
	return { prefixes, suffixes };
}

/** Путь относительно корня репозитория: можно ли его писать и коммитить. */
export function isTestPath(rel: string): boolean {
	const p = normalize(rel).replace(/^\.\//, "");
	if (!p || p.startsWith("..")) return false;

	const parts = p.split("/");
	const file = parts[parts.length - 1];
	const dirs = parts.slice(0, -1);

	if (TEST_FILE.some((re) => re.test(p))) return true;
	if (DEP_MANIFESTS.has(file)) return true;
	if (dirs.some((d) => TEST_DIRS.has(d))) return true;
	// Артефакты пайплайна: отчёт, BACKLOG, TRACKING — но только тексты.
	if (dirs.includes("run") && file.endsWith(".md")) return true;
	if (/\.ya?ml$/.test(file) && TEST_STACK.test(file)) return true;

	const { prefixes, suffixes } = allowedRules();
	if (suffixes.some((suf) => file.endsWith(suf))) return true;
	return prefixes.some((pref) => p === pref || p.startsWith(pref + "/"));
}

/** Абсолютный путь из аргумента команды. */
function resolvePath(p: string, cwd: string): string {
	const s = p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
	return normalize(isAbsolute(s) ? s : join(cwd, s)).replace(/\/+$/, "");
}

/** Путь относительно корня репозитория; null — файл вне репозитория. */
export function toRepoRelative(abs: string, root: string): string | null {
	const rel = relative(root, abs);
	return rel && !rel.startsWith("..") ? rel : null;
}

/**
 * Не-тестовые пути, которые команда добавляет в индекс.
 *
 * `git add -A`/`.`/`-u` здесь не разбираются: их ловит git-commit-guard, а сюда
 * они приходят уже заблокированными. Разбирается именно поимённый add — форма,
 * которой продакшн-файл попадает в индекс незаметно.
 */
export function addTargets(command: string, cwd: string, root: string): string[] {
	const out: string[] = [];
	for (const seg of commandSegments(command)) {
		const g = gitSubcommandOf(seg);
		if (!g || (g.sub !== "add" && g.sub !== "stage")) continue;
		// `git -C <dir> add x` — пути считаются от <dir>, а не от cwd.
		const cIdx = seg.indexOf("-C");
		const base = cIdx !== -1 && cIdx + 1 < seg.length ? resolvePath(seg[cIdx + 1], cwd) : cwd;
		for (const a of g.args) {
			if (a.startsWith("-") || a === "--") continue;
			const rel = toRepoRelative(resolvePath(a, base), root);
			if (rel && !isTestPath(rel)) out.push(rel);
		}
	}
	return [...new Set(out)];
}

/** Не-тестовые файлы, которые команда правит из bash (для напоминания, не для блока). */
export function writtenProduction(command: string, cwd: string, root: string): string[] {
	const out: string[] = [];
	for (const t of writeTargets(command)) {
		const rel = toRepoRelative(resolvePath(t, cwd), root);
		if (rel && !isTestPath(rel)) out.push(rel);
	}
	return [...new Set(out)];
}

/** Изменённые пути из `git status --porcelain -z` (включая untracked и обе стороны переименования). */
export function parseStatus(raw: string): string[] {
	const out: string[] = [];
	const items = raw.split("\0");
	for (let i = 0; i < items.length; i++) {
		const entry = items[i];
		if (entry.length < 4) continue;
		const xy = entry.slice(0, 2);
		out.push(entry.slice(3));
		// R/C печатают два пути: следующий элемент — источник переименования.
		if ((xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") && i + 1 < items.length) {
			const src = items[++i];
			if (src) out.push(src);
		}
	}
	return [...new Set(out.filter(Boolean))];
}

const GIT_COMMIT_RE = /\bgit\b[^|;&]*\s+commit(\s|$)/;

const ADD_REASON = (paths: string[]) =>
	`${paths.join(", ")} — продакшн-код, а ты проверяешь его, а не пишешь. В коммит этого прогона уходят только тесты и артефакты отчёта.\n\nЧто делать вместо этого:\n· нашёл дефект — он идёт в отчёт с воспроизведением (команда, ожидание из спеки, факт), чинит его разработчик;\n· правка нужна была для мутационной пробы — откати её (\`git checkout -- <файл>\`) и коммить только тесты;\n· без правки прода задачу проверить нельзя (нужен хук, интерфейс, экспорт) — это блокер, опиши его в отчёте.`;

const COMMIT_REASON = (paths: string[]) =>
	`Коммит остановлен: в рабочем дереве изменён продакшн-код — ${paths.slice(0, 20).join(", ")}${paths.length > 20 ? ` и ещё ${paths.length - 20}` : ""}.\n\nПрофиль пишет только тесты, поэтому такая правка бывает лишь временной мутационной пробой — и она не откачена. Верни файлы (\`git checkout -- <файл>\`, новые — удали), убедись, что \`git status\` чист по не-тестовым путям, и повтори коммит.\n\nЕсли это артефакт сборки (бинарь, coverage) — убери его из дерева; если правку прода ты считаешь необходимой — не коммить её, а опиши в отчёте: решение за супервизором.`;

/**
 * Корень репозитория для cwd. Кешируется: напоминание висит на каждой правке
 * файла, а корень за прогон не меняется — иначе на каждый edit приходился бы
 * запуск git.
 */
const rootCache = new Map<string, string | null>();

/**
 * cwd без симлинков. `git rev-parse --show-toplevel` печатает РЕАЛЬНЫЙ путь, а
 * ctx.cwd приходит таким, каким его видит процесс: на macOS `/tmp` и `/var` —
 * симлинки в `/private/…`, и относительный путь файла к корню начинался с «..»,
 * то есть всякий файл считался лежащим вне репозитория и гейт молча пропускал
 * правку прода. Кеш — та же причина, что у rootCache: вызов на каждую правку.
 */
const realCache = new Map<string, string>();

function realCwd(cwd: string): string {
	const cached = realCache.get(cwd);
	if (cached !== undefined) return cached;
	let real = cwd;
	try {
		real = realpathSync(cwd);
	} catch {
		real = cwd;
	}
	realCache.set(cwd, real);
	return real;
}

/**
 * То же для абсолютного пути файла: он приходит от тула и может вести через
 * симлинк. Файла может ещё не быть (write создаёт его) — тогда разворачивается
 * каталог, а имя приписывается обратно.
 */
function realAbs(abs: string): string {
	try {
		return realpathSync(abs);
	} catch {
		const dir = abs.replace(/\/[^/]*$/, "");
		const name = abs.slice(dir.length);
		if (!dir || dir === abs) return abs;
		try {
			return realpathSync(dir) + name;
		} catch {
			return abs;
		}
	}
}

async function repoRoot(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const cached = rootCache.get(cwd);
	if (cached !== undefined) return cached;
	let root: string | null = null;
	try {
		const res = await pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 10_000 });
		root = res.code === 0 ? res.stdout.trim() || null : null;
	} catch {
		root = null;
	}
	rootCache.set(cwd, root);
	return root;
}

export default function (pi: ExtensionAPI) {
	// Напоминание печатается один раз на файл: правка прода идёт итерациями.
	const warned = new Set<string>();

	pi.on("tool_call", async (event, ctx) => {
		if (process.env.TEST_ONLY_GUARD === "0") {
			// Снятый гейт без следа неотличим от соблюдённого правила.
			console.error("[test-only-guard] гейт снят через TEST_ONLY_GUARD=0 — правило НЕ проверялось");
			return undefined;
		}
		if (event.toolName !== "bash") return undefined;

		const command = (event.input as { command?: string }).command ?? "";
		if (!command) return undefined;

		const isAdd = commandSegments(command).some((seg) => {
			const g = gitSubcommandOf(seg);
			return g?.sub === "add" || g?.sub === "stage";
		});
		if (!isAdd && !GIT_COMMIT_RE.test(command)) return undefined;

		const cwd = realCwd(ctx.cwd);
		const root = await repoRoot(pi, cwd);
		if (!root) return undefined;

		if (isAdd) {
			const targets = addTargets(command, cwd, root);
			if (targets.length) return { block: true, reason: ADD_REASON(targets) };
		}

		if (!GIT_COMMIT_RE.test(command)) return undefined;

		// Коммит: судим по всему дереву, а не по индексу. `commit -a`, `commit --only`
		// и «сначала add, потом commit» — разные пути к одному результату, а
		// невосстановленная проба одинаково означает, что работа не закончена.
		let status: string;
		try {
			const res = await pi.exec("git", ["-C", root, "status", "--porcelain", "-z"], { timeout: 15_000 });
			if (res.code !== 0) return undefined;
			status = res.stdout;
		} catch {
			return undefined;
		}

		const dirty = parseStatus(status).filter((p) => !isTestPath(p));
		return dirty.length ? { block: true, reason: COMMIT_REASON(dirty) } : undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (process.env.TEST_ONLY_GUARD === "0") return undefined;

		const cwd = realCwd(ctx.cwd);
		let touched: string[] = [];
		if (event.toolName === "write" || event.toolName === "edit") {
			const path = (event.input as { path?: string }).path ?? "";
			if (!path) return undefined;
			const root = await repoRoot(pi, cwd);
			if (!root) return undefined;
			const rel = toRepoRelative(realAbs(resolvePath(path, cwd)), root);
			if (rel && !isTestPath(rel)) touched = [rel];
		} else if (event.toolName === "bash") {
			const command = (event.input as { command?: string }).command ?? "";
			if (!command) return undefined;
			const root = await repoRoot(pi, cwd);
			if (!root) return undefined;
			touched = writtenProduction(command, cwd, root);
		} else {
			return undefined;
		}

		const fresh = touched.filter((p) => !warned.has(p));
		if (!fresh.length) return undefined;
		for (const p of fresh) warned.add(p);

		const names = fresh.map((p) => basename(p)).join(", ");
		return {
			content: [
				{
					type: "text" as const,
					text: `Изменён продакшн-файл: ${names}. В этом профиле такая правка допустима только как временная мутационная проба — убедиться, что тест краснеет на сломанном поведении. Откати её сразу после пробы (\`git checkout -- ${fresh[0]}\`): коммит при изменённом продакшн-коде заблокирован, а дефекты идут в отчёт, а не в код.`,
				},
			],
		};
	});
}
