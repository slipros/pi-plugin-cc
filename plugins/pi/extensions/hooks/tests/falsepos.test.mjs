/**
 * Контроль ложных срабатываний: типовые рабочие команды прогоняются через ВСЕ
 * блокирующие предикаты. Ни одна не должна быть заблокирована.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const HOME = process.env.HOME;

const src = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hooks-fp-"));
for (const f of ["utils.ts", "git-stash-guard.ts", "git-commit-guard.ts", "go-cache-guard.ts", "protect-secrets.ts", "sql-semicolon-guard.ts", "grep-scope-guard.ts", "protect-pi-hooks.ts"]) {
	fs.writeFileSync(path.join(tmp, f), fs.readFileSync(path.join(src, f), "utf8").replace(/from "\.\/utils"/g, 'from "./utils.ts"'));
}
const { gitStashReason } = await import(path.join(tmp, "git-stash-guard.ts"));
const { gitCommitReason } = await import(path.join(tmp, "git-commit-guard.ts"));
const { goCacheReason } = await import(path.join(tmp, "go-cache-guard.ts"));
const { protectSecretsReason } = await import(path.join(tmp, "protect-secrets.ts"));
const { bashWriteReason } = await import(path.join(tmp, "sql-semicolon-guard.ts"));
const { scopeReason } = await import(path.join(tmp, "grep-scope-guard.ts"));
const { bashReason: piBash } = await import(path.join(tmp, "protect-pi-hooks.ts"));

const hooks = [
	["git-stash-guard", gitStashReason],
	["git-commit-guard", gitCommitReason],
	["go-cache-guard", goCacheReason],
	["protect-secrets", protectSecretsReason],
	["sql-semicolon-guard", bashWriteReason],
	["grep-scope-guard", (c) => scopeReason(c, `${HOME}/proj`)],
	["protect-pi-hooks", (c) => piBash(c, `${HOME}/proj`)],
];

const WORK = [
	"go build ./...",
	"go test ./internal/... -run TestFoo -count=1",
	"go mod tidy && go mod download",
	"rg -n 'ConvertResult' internal/service",
	"grep -rn 'TODO' ./cmd",
	"find . -name '*.go' -newer go.mod",
	"git status --short",
	"git diff --stat",
	"git log --oneline -20",
	"git add internal/service/user.go internal/service/user_test.go",
	"kubectl get pods -n default",
	"docker compose up -d",
	"ls -la ~/.config",
	"cat internal/service/user.go",
	"sed -i 's/old/new/' internal/service/user.go",
	"timeout 60 rg -n 'PATTERN' ~ | head -50",
	"npm run build 2>&1 | tail -20",
	"golangci-lint run ./...",
	// многострочные — самый чувствительный к правке класс
	`cd ${HOME}/proj\ngo build ./...\ngo test ./...`,
	"echo '=== сборка'\ngo build ./...\necho '=== тесты'\ngo test ./...",
	"for f in *.go; do\n  gofmt -l \"$f\"\ndone",
	"if [ -f go.mod ]; then\n  go mod tidy\nfi",
	"while read -r line; do\n  echo \"$line\"\ndone < list.txt",
	"cat > /tmp/notes.md <<'EOF'\nсписок задач\nпроверить сборку\nEOF",
	"git diff --stat\ngit log --oneline -5\ngo build ./...",
	"make build \\\n  BINARY=app \\\n  VERSION=1.0",
	"rg -n 'stash' docs/\ngrep -rn 'commit' README.md",
	"go clean -cache-dir ./tmp",
	"rm -rf ./build ./dist",
	"cp .env.example .env",
	"stat ~/.ssh/id_ed25519.pub",
	"tee /tmp/out.log < input.txt",
	"cp /tmp/x.sql db/schema/001_init.sql",
];

let pass = 0;
const fails = [];
for (const cmd of WORK) {
	for (const [name, fn] of hooks) {
		let r;
		try { r = fn(cmd); } catch (e) { r = `ОШИБКА ${e.message}`; }
		if (r === null) pass++;
		else fails.push({ cmd, name, r: String(r).split("\n")[0].slice(0, 90) });
	}
}
for (const f of fails) console.log(`ЛОЖНОЕ [${f.name}] ${JSON.stringify(f.cmd)}\n    → ${f.r}`);
console.log(`\nкоманд: ${WORK.length} × хуков: ${hooks.length} = ${WORK.length * hooks.length} проверок; чисто: ${pass}, ложных блоков: ${fails.length}`);
process.exit(fails.length ? 1 : 0);
