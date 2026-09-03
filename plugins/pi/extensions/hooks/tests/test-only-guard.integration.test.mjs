/**
 * test-only-guard против настоящего git.
 *
 * Разбор путей и команд проверяет negative.test.mjs; здесь проверяется само
 * решение — оно принимается по состоянию рабочего дерева, а состояние дерева
 * знает только git. Хук поднимается как в pi (через default-экспорт с фейковым
 * `pi`), поэтому проверяется в том числе то, что он вешается на нужные события.
 *
 * Прогон: node ~/.pi/agent/extensions/hooks/tests/test-only-guard.integration.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const src = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tog-"));

for (const f of ["utils.ts", "test-only-guard.ts"]) {
	const text = fs.readFileSync(path.join(src, f), "utf8").replace(/from "\.\/utils"/g, 'from "./utils.ts"');
	fs.writeFileSync(path.join(tmp, f), text);
}
const mod = await import(path.join(tmp, "test-only-guard.ts"));

const handlers = {};
const pi = {
	on: (evt, fn) => { handlers[evt] = fn; },
	exec: async (cmd, args, opts = {}) => {
		try {
			const { stdout, stderr } = await run(cmd, args, { cwd: opts.cwd });
			return { stdout, stderr, code: 0, killed: false };
		} catch (e) {
			return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1, killed: false };
		}
	},
};
mod.default(pi);

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tog-repo-"));
const git = (...args) => run("git", ["-C", repo, ...args]);
const write = (rel, text) => fs.writeFileSync(path.join(repo, rel), text);

await git("init", "-q", "-b", "main");
await git("config", "user.email", "t@example.com");
await git("config", "user.name", "t");
write("users.go", "package p\n\nfunc A() int { return 1 }\n");
write("users_test.go", "package p\n");
await git("add", "users.go", "users_test.go");
await git("commit", "--no-gpg-sign", "-qm", "init");

let pass = 0;
let fail = 0;

function check(name, blocked, wantBlock) {
	if (blocked === wantBlock) pass++;
	else {
		fail++;
		console.log(`FAIL [${name}] — ждали ${wantBlock ? "блок" : "пропуск"}, получили ${blocked ? "блок" : "пропуск"}`);
	}
}

const bash = async (command) => await handlers.tool_call({ toolName: "bash", input: { command } }, { cwd: repo });
const blocks = async (command) => Boolean((await bash(command))?.block);

// Чистое дерево: коммит тестов — обычная работа профиля.
check("чистое дерево, commit", await blocks('git commit -m "test: тест"'), false);
check("add теста", await blocks("git add users_test.go"), false);
check("не git-команда", await blocks("go test ./..."), false);

// Продакшн-файл поимённо в индекс — форма, которой правка уезжает незаметно.
check("add прода", await blocks("git add users.go"), true);
check("add прода в обёртке", await blocks('eval "git add users.go"'), true);

// Незавершённая мутационная проба: дерево грязное по проду — коммит ждёт отката.
write("users.go", "package p\n\nfunc A() int { return 2 }\n");
const dirty = await bash('git commit -m "test: тест"');
check("commit при грязном проде", Boolean(dirty?.block), true);
check("причина называет файл", Boolean(dirty?.reason?.includes("users.go")), true);
check("commit -a при грязном проде", await blocks("git commit -am wip"), true);

// Проба откачена — работа продолжается.
await git("checkout", "--", "users.go");
check("commit после отката", await blocks('git commit -m "test: тест"'), false);

// Новый продакшн-файл — тоже продакшн, даже без коммита.
write("service.go", "package p\n");
check("untracked прод", await blocks('git commit -m "test: тест"'), true);
fs.rmSync(path.join(repo, "service.go"));

// Новый тест — то, ради чего профиль и работает.
write("handler_test.go", "package p\n");
check("untracked тест", await blocks('git commit -m "test: тест"'), false);

// Напоминание при правке прода: один раз на файл, тестовые файлы не трогает.
const result = async (toolName, input) => await handlers.tool_result({ toolName, input }, { cwd: repo });
const noticed = async (toolName, input) => Boolean((await result(toolName, input))?.content?.length);

check("напоминание на write прода", await noticed("write", { path: path.join(repo, "users.go") }), true);
check("напоминание не повторяется", await noticed("write", { path: path.join(repo, "users.go") }), false);
check("напоминание на sed -i из bash", await noticed("bash", { command: "sed -i s/a/b/ service.go" }), true);
check("тестовый файл — молча", await noticed("write", { path: path.join(repo, "handler_test.go") }), false);

// Выключатель: гейт снимается только человеком и оставляет след.
process.env.TEST_ONLY_GUARD = "0";
check("TEST_ONLY_GUARD=0", await blocks("git add users.go"), false);
delete process.env.TEST_ONLY_GUARD;

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(repo, { recursive: true, force: true });
console.log(`\nитого: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
