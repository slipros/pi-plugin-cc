/**
 * Общие утилиты для хуков pi.
 *
 * Этот файл НЕ является расширением: pi авто-обнаруживает только `*.ts` в корне
 * `~/.pi/agent/extensions/` и `index.ts` в подкаталогах. `hooks/utils.ts` —
 * обычный модуль, импортируется хуками через `./utils`.
 */

export const segSplit = /\|\||&&|[;\|&\n]/;
export function segments(cmd: string): string[] {
	return cmd.split(segSplit).filter((s) => s.trim());
}

/**
 * Токенизация команды с учётом кавычек: границы слов сохраняются, кавычки снимаются.
 *
 * Операторы (`;`, `&&`, `||`, `|`, `&`, перевод строки) и скобки групп выделяются
 * отдельными токенами — по ним `commandSegments` режет команду на простые вызовы.
 *
 * Перевод строки — такой же разделитель, как `;`: без него многострочная команда
 * («echo hi⏎git stash») склеивалась в ОДИН сегмент, головой становилась первая
 * команда, и правило не проверялось ни разу. Это снимало все хуки на этом лексере
 * в обычной работе, а не только под обходом (проверено на живом pi).
 */
export function tokenize(cmd: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: '"' | "'" | null = null;
	const push = () => { if (cur !== "") { out.push(cur); cur = ""; } };

	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		if (quote) {
			if (c === quote) quote = null;
			else if (c === "\\" && quote === '"' && i + 1 < cmd.length) { cur += cmd[++i]; }
			else cur += c;
			continue;
		}
		if (c === '"' || c === "'") { quote = c; continue; }
		// `\` + перевод строки — продолжение строки: склеивает слова, а не даёт токен
		// «\n» (из-за него `git \⏎ stash` читался как git с подкомандой «\n»).
		if (c === "\\" && cmd[i + 1] === "\n") { i++; continue; }
		if (c === "\\" && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
		if (c === "\n") { push(); out.push(";"); continue; }
		if (/\s/.test(c)) { push(); continue; }
		if (c === ";" || c === "|" || c === "&") {
			push();
			const two = cmd.slice(i, i + 2);
			if (two === "&&" || two === "||") { out.push(two); i++; } else out.push(c);
			continue;
		}
		// Обратные кавычки — та же подстановка команды, что `$(…)`: их содержимое
		// исполняется, значит это отдельный вызов, а не текст.
		if (c === "(" || c === ")" || c === "{" || c === "}" || c === "`") { push(); out.push(c); continue; }
		cur += c;
	}
	push();
	return out;
}

const WRAPPERS_EXEC = new Set(["eval", "sh", "bash", "zsh", "dash", "ksh"]);
// `timeout` рекомендован для долгих прогонов, `stdbuf`/`setsid`/`doas` — тот же класс.
// Остальные добавлены по прогону обходов: каждая запускает произвольную команду,
// оставаясь головой сегмента. `script -qec "…"` — та самая форма, которой
// проверяется TTY-ветка хуков: инструмент проверки снимал проверяемое.
const WRAPPERS_SKIP = new Set([
	"sudo", "doas", "nohup", "time", "command", "builtin", "exec",
	"xargs", "nice", "ionice", "timeout", "stdbuf", "setsid",
	"su", "runuser", "script", "flock", "chroot", "unshare", "busybox",
	"strace", "ltrace", "watch", "taskset", "chrt", "systemd-run",
	"proxychains", "proxychains4", "parallel", "nix-shell",
]);
// Обёртки, у которых команда — ЗНАЧЕНИЕ опции, а не позиционный аргумент.
// Учитываются и кластеры коротких флагов (`script -qec "git stash"`), и форма
// `--run=…`.
const WRAPPER_CMD_OPT: Record<string, Set<string>> = {
	su: new Set(["-c", "--command"]),
	runuser: new Set(["-c", "--command"]),
	script: new Set(["-c", "--command"]),
	"nix-shell": new Set(["--run", "--command"]),
};
// Опции обёрток, забирающие следующий токен значением: нужны, чтобы снимать ТОЛЬКО
// собственные флаги обёртки. Прежний `filter(a => !a.startsWith("-"))` выбрасывал
// флаги внутренней команды — `command sed -i <файл>` переставал быть записью, а у
// `sudo -u root rm -rf /etc` головой сегмента становился `root`.
const WRAPPER_OPT_VALUE: Record<string, Set<string>> = {
	sudo: new Set(["-u", "-g", "-p", "-C", "-U", "-r", "-t", "--user", "--group", "--prompt", "--role", "--type"]),
	doas: new Set(["-u", "-C"]),
	nice: new Set(["-n", "--adjustment"]),
	ionice: new Set(["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid"]),
	timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
	xargs: new Set(["-I", "-i", "-n", "-P", "-s", "-d", "-a", "-E", "-e", "-L",
		"--replace", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--max-lines"]),
	stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
	strace: new Set(["-o", "-p", "-e", "-s", "-E", "-P", "-a", "-b", "-u", "--output", "--attach"]),
	ltrace: new Set(["-o", "-p", "-e", "-s", "-l", "-u", "--output"]),
	watch: new Set(["-n", "--interval"]),
	taskset: new Set(["-c", "-p", "--cpu-list", "--pid"]),
	chrt: new Set(["-p", "--pid"]),
	flock: new Set(["-w", "-E", "--timeout", "--conflict-exit-code"]),
	unshare: new Set(["-S", "-G", "--setuid", "--setgid", "--map-user", "--map-group", "--wd", "--root"]),
	"systemd-run": new Set(["-p", "-u", "--property", "--unit", "--slice", "--description", "-E", "--setenv"]),
	proxychains: new Set(["-f"]),
	proxychains4: new Set(["-f"]),
	parallel: new Set(["-j", "-P", "-n", "-N", "--jobs", "--max-procs", "-S", "--sshlogin"]),
	su: new Set(["-s", "-g", "-G", "--shell", "--group", "--supp-group"]),
	runuser: new Set(["-u", "-s", "-g", "-G", "--user", "--shell", "--group"]),
	script: new Set(["-o", "-l", "-B", "-I", "-O", "-T", "--logging-format", "--log-out"]),
};
/**
 * Обёртки, у которых перед командой идут позиционные параметры: `flock <файл> cmd`,
 * `timeout 60 cmd`, `taskset 0x3 cmd`. `test` страхует от съедания самой команды,
 * когда параметр опущен (`flock -x cmd` — редко, но валидно).
 */
const DURATION = /^[0-9]+(\.[0-9]+)?[smhd]?$/;
const WRAPPER_POSITIONAL: Record<string, { count: number; test?: RegExp }> = {
	timeout: { count: 1, test: DURATION },
	flock: { count: 1, test: /^(\/|\.{0,2}\/|[0-9]+$)/ },
	chroot: { count: 1, test: /^[\/.]/ },
	taskset: { count: 1, test: /^(0x)?[0-9a-fA-F][0-9a-fA-F,\-]*$/ },
	chrt: { count: 1, test: /^[0-9]+$/ },
	su: { count: 1, test: /^[a-z_][a-z0-9_-]*$/ },
};
const SEPARATORS = new Set([";", "|", "&", "&&", "||", "(", ")", "{", "}", "`"]);

function unwrap(argv: string[], depth: number): string[][] {
	if (depth > 6 || argv.length === 0) return argv.length ? [argv] : [];
	const head = basename(argv[0]);

	if (head === "env") {
		let rest = argv.slice(1);
		while (rest.length) {
			const t = rest[0];
			if (t.includes("=") && !t.startsWith("-")) rest = rest.slice(1);
			else if (t === "-u" || t === "--unset" || t === "-S" || t === "--split-string") rest = rest.slice(2);
			else if (t === "--") { rest = rest.slice(1); break; }
			else if (t.startsWith("-")) rest = rest.slice(1);
			else break;
		}
		return unwrap(rest, depth + 1);
	}
	// `su -c "git stash"`, `script -qec "…" /dev/null`, `nix-shell --run "…"`:
	// команда лежит в значении опции, а не в позиции.
	const cmdOpts = WRAPPER_CMD_OPT[head];
	if (cmdOpts) {
		const args = argv.slice(1);
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			const cluster = /^-[a-zA-Z]+$/.test(a) && cmdOpts.has("-" + a[a.length - 1]);
			if (cmdOpts.has(a) || cluster) {
				return i + 1 < args.length ? commandSegments(args[i + 1], depth + 1) : [];
			}
			const eq = [...cmdOpts].find((o) => o.startsWith("--") && a.startsWith(o + "="));
			if (eq) return commandSegments(a.slice(eq.length + 1), depth + 1);
		}
		// опции с командой нет — обёртка разбирается дальше как позиционная
	}
	if (WRAPPERS_SKIP.has(head)) {
		const opts = WRAPPER_OPT_VALUE[head] ?? new Set<string>();
		let rest = argv.slice(1);
		while (rest.length && rest[0].startsWith("-")) {
			if (rest[0] === "--") { rest = rest.slice(1); break; }
			rest = opts.has(rest[0]) ? rest.slice(2) : rest.slice(1);   // `-I{}`/`-n10` — значение приклеено
		}
		const pos = WRAPPER_POSITIONAL[head];
		for (let k = 0; k < (pos?.count ?? 0); k++) {
			if (rest.length && (!pos?.test || pos.test.test(rest[0]))) rest = rest.slice(1);
		}
		return unwrap(rest, depth + 1);
	}
	if (WRAPPERS_EXEC.has(head)) {
		// `bash <<< "git stash"`: команда приходит here-string'ом, а не аргументом.
		const hs = argv.indexOf("<<<");
		if (hs !== -1 && hs + 1 < argv.length) return commandSegments(argv[hs + 1], depth + 1);
		// `eval git stash` — аргументы склеиваются в одну команду; разбор только
		// первого позиционного терял хвост и пропускал вызов.
		if (head === "eval") {
			const rest = argv.slice(1).filter((a) => !a.startsWith("-"));
			return rest.length ? commandSegments(rest.join(" "), depth + 1) : [];
		}
		// `bash -c "…"`: команда — первый позиционный, остальные уходят в $0/$1.
		for (const a of argv.slice(1)) {
			if (a.startsWith("-")) continue;
			return commandSegments(a, depth + 1);
		}
		return [];
	}
	return [argv];
}

/**
 * Сегменты команды: простые вызовы с развёрнутыми обёртками.
 *
 * Разбор регуляркой по строке (`segments` + `maskLiterals`) пропускал
 * `eval "git stash"` и `(cd /r && git stash)`, а `git` искали по всем словам
 * сегмента, из-за чего `grep -rn git stash .` блокировался как вызов. Здесь
 * граница слов сохраняется, обёртки разворачиваются, и команда сегмента — его
 * первый токен (после env-присваиваний).
 */
export function commandSegments(cmd: string, depth = 0): string[][] {
	const toks = tokenize(cmd);
	const segs: string[][] = [];
	let cur: string[] = [];
	for (const t of toks) {
		if (SEPARATORS.has(t)) { if (cur.length) segs.push(cur); cur = []; continue; }
		cur.push(t);
	}
	if (cur.length) segs.push(cur);

	const out: string[][] = [];
	for (const s of segs) for (const u of unwrap(s, depth)) if (u.length) out.push(u);
	return out;
}

const REDIR_WRITE = [">>", "&>", "1>", "2>", ">|", ">"];

/**
 * Файлы, в которые пишет команда: перенаправления, `tee`, `sed -i`, `cp/mv/install`
 * (приёмник), `dd of=`, `git checkout -- <path>`.
 *
 * Нужно там, где запрет висит на write|edit: те же файлы правятся из bash, и
 * правило снимается сменой инструмента, а не обходом.
 */
export function writeTargets(command: string): string[] {
	const out: string[] = [];
	for (const tokens of commandSegments(command)) {
		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i];
			const exact = REDIR_WRITE.find((op) => t === op);
			if (exact) { if (i + 1 < tokens.length) out.push(tokens[i + 1]); continue; }
			const pref = REDIR_WRITE.find((op) => t.startsWith(op) && t.length > op.length);
			if (pref) { const rest = t.slice(pref.length); if (rest && !">|&".includes(rest[0])) out.push(rest); }
		}
		const head = segmentHead(tokens);
		if (!head) continue;
		const args = tokens.slice(head.index + 1);
		const positional = args.filter((a) => !a.startsWith("-"));
		switch (head.head) {
			case "tee":
				out.push(...positional);
				break;
			case "sed": case "perl": case "ruby":
				if (args.some((a) => a === "-i" || a.startsWith("-i.") || (/^-[a-z]*i/.test(a) && !a.startsWith("--")))) {
					const skip = args.some((a) => a === "-e" || a === "-f" || a === "--expression") ? 0 : 1;
					out.push(...positional.slice(skip));
				}
				break;
			case "cp": case "mv": case "install": case "rsync":
				if (positional.length >= 2) out.push(positional[positional.length - 1]);
				break;
			case "dd":
				for (const a of args) if (a.startsWith("of=")) out.push(a.slice(3));
				break;
			case "truncate":
				out.push(...positional);
				break;
			case "git":
				if (positional[0] === "checkout" || positional[0] === "restore") {
					out.push(...positional.slice(1).filter((p) => p !== "--"));
				}
				break;
		}
	}
	return [...new Set(out.filter(Boolean))];
}

/** Команда сегмента — первый токен после env-присваиваний (`VAR=val`). */
export function segmentHead(tokens: string[]): { head: string; index: number } | null {
	let i = 0;
	while (i < tokens.length && tokens[i].includes("=") && !tokens[i].startsWith("-")) i++;
	if (i >= tokens.length) return null;
	return { head: basename(tokens[i]), index: i };
}

/**
 * Подкоманда git для сегмента — или null, если сегмент вызывает не git.
 * Ищет `git` СТРОГО в позиции команды: иначе текст (`grep -rn git stash .`)
 * читается как вызов.
 */
export function gitSubcommandOf(tokens: string[]): { sub: string; args: string[] } | null {
	const h = segmentHead(tokens);
	if (!h || h.head !== "git") return null;
	let i = h.index + 1;
	while (i < tokens.length) {
		const t = tokens[i];
		if (GIT_GLOBAL_OPTS.has(t)) { i += 2; continue; }
		if (t.startsWith("-")) { i += 1; continue; }
		return { sub: t, args: tokens.slice(i + 1) };
	}
	return null;
}
/** Строковые литералы → QSTR, чтобы текст не влиял на разбор команд. */
export function maskLiterals(cmd: string): string {
	return cmd.replace(/"[^"]*"/g, "QSTR").replace(/'[^']*'/g, "QSTR");
}
export function basename(p: string): string {
	const i = p.lastIndexOf("/");
	return i === -1 ? p : p.slice(i + 1);
}
/** Короткий флаг -abc: начинается с одной `-` и кластер содержит букву. */
export function hasShort(a: string, letter: string): boolean {
	if (a.length < 2 || a[0] !== "-" || a[1] === "-") return false;
	return a.slice(1).includes(letter);
}
export const GIT_GLOBAL_OPTS = new Set([
	"-C", "-c", "--git-dir", "--work-tree", "--exec-path", "--namespace",
]);
/** Пример-файлы окружения — не секреты, а часть репозитория. */
export const scrub = (s: string) => s.replace(/[^\s]*\.env\.(example|sample|template|dist|tpl)\b/g, "");
export function stripCommentLiterals(line: string): string {
	return line.replace(/'[^']*'/g, "");
}
export function joinPath(base: string, rel: string): string {
	return (base.endsWith("/") ? base : base + "/") + rel;
}
