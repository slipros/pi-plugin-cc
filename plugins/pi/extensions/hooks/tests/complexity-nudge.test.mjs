// complexity-nudge: событие write → замечание о сложности в результате правки.
//
// Ключевое поведение — дельта: хук говорит только про функции, которые агент
// создал или ухудшил. Сложная функция, лежащая в репозитории нетронутой, должна
// молчать, иначе подсказка тонет в фоне легаси-кода.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
const HOME = process.env.HOME;

const pexec = promisify(execFile);
const src = path.resolve(import.meta.dirname, "..");

// ── модельный репозиторий ────────────────────────────────────────────────────
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cn-repo-"));
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

const SIMPLE = `package svc

func Handle(a int) int {
	if a > 0 {
		return a
	}
	return 0
}

func Legacy(a []int) int {
	total := 0
	for _, v := range a {
		if v > 0 {
			if v > 10 {
				for i := 0; i < v; i++ {
					if i%2 == 0 {
						total += i
					} else if i%3 == 0 {
						total -= i
					} else {
						total++
					}
				}
			} else if v > 5 {
				total += v * 2
			} else {
				total += v
			}
		} else if v < -10 {
			total -= v
		}
	}
	return total
}
`;

// Handle раздута, Legacy не тронута.
const BLOATED = SIMPLE.replace(
	`func Handle(a int) int {
	if a > 0 {
		return a
	}
	return 0
}`,
	`func Handle(a int) int {
	if a > 0 {
		if a > 5 {
			for i := 0; i < a; i++ {
				if i%2 == 0 {
					if i > 3 {
						a += i
					} else if i == 2 {
						a -= i
					} else {
						a++
					}
				} else if i%5 == 0 {
					for j := 0; j < i; j++ {
						if j > 1 {
							a += j
						}
					}
				}
			}
		}
		return a
	}
	return 0
}`,
);

git("init", "-q", ".");
fs.writeFileSync(path.join(repo, "svc.go"), SIMPLE);
git("add", "-A");
// Базовая ревизия — plumbing-командами: `git commit` требует user.* и подписи,
// а здесь нужен только объект, с которым сравнивать.
const tree = git("write-tree");
const commit = git("commit-tree", tree, "-m", "base");
git("update-ref", "refs/heads/main", commit);
git("symbolic-ref", "HEAD", "refs/heads/main");

fs.writeFileSync(path.join(repo, "svc.go"), BLOATED);
fs.writeFileSync(path.join(repo, "untracked.go"), SIMPLE);

// ── хук ──────────────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cn-hook-"));
for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".ts"))) {
	fs.writeFileSync(
		path.join(tmp, f),
		fs.readFileSync(path.join(src, f), "utf8").replace(/from "\.\/([a-z-]+)"/g, 'from "./$1.ts"'),
	);
}
const mod = await import(path.join(tmp, "complexity-nudge.ts"));

let handler;
const fakePi = {
	on: (evt, fn) => {
		if (evt === "tool_result") handler = fn;
	},
	exec: async (cmd, args, opts) => {
		const { stdout } = await pexec(cmd, args, { timeout: opts?.timeout ?? 15_000 }).catch(() => ({
			stdout: "",
		}));
		return { stdout, stderr: "", code: 0, killed: false };
	},
};
mod.default(fakePi);

const fire = (p, tool = "write") =>
	handler({ toolName: tool, input: { path: p }, content: [{ type: "text", text: "ok" }] }, { cwd: repo });

const said = (res) => Boolean(res && res.content.length > 1);
const text = (res) => (said(res) ? res.content[1].text : "");

let bad = 0;
const check = (name, got, want) => {
	const ok = got === want;
	if (!ok) bad++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};

const bloated = await fire(path.join(repo, "svc.go"));
check("раздутая функция → замечание", said(bloated), true);
check("названа именно она", /Handle/.test(text(bloated)), true);
check("нетронутое легаси молчит", /Legacy/.test(text(bloated)), false);
check("показан рост", /было 1/.test(text(bloated)), true);

check("повтор того же файла → тишина (дедуп)", said(await fire(path.join(repo, "svc.go"))), false);
check("файл вне индекса → судим по порогу", said(await fire(path.join(repo, "untracked.go"))), true);
check("markdown игнорируется", said(await fire(`${HOME}/.claude/CLAUDE.md`)), false);
check("несуществующий файл", said(await fire("/nope/nope.go")), false);
check("чужой тул", (await fire(path.join(repo, "svc.go"), "bash")) !== undefined, false);

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(repo, { recursive: true, force: true });

console.log(bad ? `\nПРОВАЛЕНО: ${bad}` : "\nвсе кейсы прошли");
process.exit(bad ? 1 : 0);
