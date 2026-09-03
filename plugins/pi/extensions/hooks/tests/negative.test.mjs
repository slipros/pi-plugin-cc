/**
 * Негативные наборы pi-хуков: команда, которую хук обязан поймать, в разных формах
 * записи, и текст, который он поймать НЕ должен.
 *
 * Позитивных проверок мало: у bash-двойников этих хуков тесты были зелёными при
 * восьми обходах у каждого. Ловить нужно то, что автор не предусмотрел — обёртки
 * (`eval`, `(…)`, `env`, `bash -c`) и, с другой стороны, ложные срабатывания на
 * текст (`grep -rn git stash .`).
 *
 * Хуки импортируются как есть; правится только спецификатор `./utils` — pi грузит
 * расширения через бандлер, а node требует расширение файла.
 *
 * Прогон: node ~/.pi/agent/extensions/hooks/tests/negative.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const HOME = process.env.HOME;

const src = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hooks-test-"));

for (const f of ["utils.ts", "git-stash-guard.ts", "git-commit-guard.ts", "go-cache-guard.ts", "protect-secrets.ts", "sql-semicolon-guard.ts", "grep-scope-guard.ts", "protect-pi-hooks.ts", "test-only-guard.ts", "custom-gcl-precommit.ts"]) {
	const text = fs.readFileSync(path.join(src, f), "utf8").replace(/from "\.\/utils"/g, 'from "./utils.ts"');
	fs.writeFileSync(path.join(tmp, f), text);
}

const { stagesInSameCommand } = await import(path.join(tmp, "custom-gcl-precommit.ts"));
const { gitStashReason } = await import(path.join(tmp, "git-stash-guard.ts"));
const { gitCommitReason } = await import(path.join(tmp, "git-commit-guard.ts"));
const { goCacheReason } = await import(path.join(tmp, "go-cache-guard.ts"));
const { protectSecretsReason } = await import(path.join(tmp, "protect-secrets.ts"));

let pass = 0;
let fail = 0;

function check(name, fn, cmd, wantBlock) {
	const got = fn(cmd) !== null;
	if (got === wantBlock) pass++;
	else {
		fail++;
		console.log(`FAIL [${name}] ${JSON.stringify(cmd)} — ждали ${wantBlock ? "блок" : "пропуск"}, получили ${got ? "блок" : "пропуск"}`);
	}
}

const stash = (cmd, want) => check("git-stash-guard", gitStashReason, cmd, want);
const commit = (cmd, want) => check("git-commit-guard", gitCommitReason, cmd, want);

// Обёртки: команда та же, запись другая.
stash("git stash", true);
stash("git stash push -m wip", true);
stash('eval "git stash"', true);
stash("(cd /r && git stash)", true);
stash("env X=1 git stash", true);
stash('bash -c "git stash"', true);
stash("sudo git stash", true);
// Восстановление разрешено, текст про stash — не вызов.
stash("git stash list", false);
stash("git stash pop", false);
stash("git stash apply", false);
stash('echo "git stash" >> notes.md', false);
stash("grep -rn git stash .", false);
stash('rg -n "git stash" docs/', false);

commit("git commit -m x", true);
commit('eval "git commit -m x"', true);
commit("(cd /r && git commit -m x)", true);
commit("env X=1 git commit -m x", true);
commit("git add -A", true);
commit("git commit -am x", true);
commit("git commit -m x --no-verify -S", true);
// Подпись — маркер того, что коммит идёт через скилл; снятие подписи запрещено
// отдельно, иначе агент выбирается из противоречия неподписанным коммитом.
commit("git commit -m x --no-gpg-sign", true);
commit("git commit -S -m x --no-gpg-sign", true);
// Коммит скиллом и текст про коммит — проходят.
commit("git commit -S -m x", false);
commit("git commit --gpg-sign -m x", false);
commit("git commit --gpg-sign=7C56781A -m x", false);
commit('git commit -S -m "не забудь --no-verify"', false);
commit('echo "git commit -m x" >> TRACKING.md', false);
commit("git add a.go b.go", false);
commit("git log --all", false);

const cache = (cmd, want) => check("go-cache-guard", goCacheReason, cmd, want);
cache("go clean -modcache", true);
cache('eval "go clean -modcache"', true);
cache("(cd /r && go clean -modcache)", true);
cache("rm -rf /home/pi/go/pkg/mod", true);
cache('bash -c "rm -rf /home/pi/go/pkg/mod"', true);
cache("go clean", false);
cache("go build ./...", false);
cache("rm -rf /tmp/scratch", false);
cache('echo "go clean -modcache" >> notes.md', false);

// Секреты: у этого хука неизвестная команда и так блокируется — проверяем, что
// обёртки не пробивают его и что легитимные операции не ловятся.
const E = ".env";
const secret = (cmd, want) => check("protect-secrets", protectSecretsReason, cmd, want);
secret("c" + "at " + E, true);
secret('eval "c' + "at " + E + '"', true);
secret("ls -la " + E, false);
secret("cp " + E + ".example " + E, false);
secret("echo hi", false);

// Запрет на write|edit обходится сменой инструмента: миграция из bash.
const { bashWriteReason } = await import(path.join(tmp, "sql-semicolon-guard.ts"));
const sql = (cmd, want) => check("sql-semicolon-guard", bashWriteReason, cmd, want);
sql("cat > migrations/001_init.sql", true);
sql("echo x | tee db/migrations/002.sql", true);
sql("sed -i s/a/b/ migrations/003.sql", true);
sql("cp /tmp/x.sql migrations/004.sql", true);
sql("cat migrations/001_init.sql", false);
sql("cat > internal/query.sql", false);
sql("go build ./...", false);

// --- Ревизия 2026-08-13: форма записи не должна снимать запрет ---------------
// Класс тот же, что чинился у bash-двойников: обёртка перед командой, pathspec
// после `--`, глобальная опция git, конвейер, где путь и чтение — в разных звеньях.
stash("timeout 60 git stash push -m wip", true);
stash("stdbuf -o0 git stash", true);
stash("setsid git stash", true);
stash("sudo -u root git stash", true);
stash("nice -n 10 git stash", true);
stash("git stash -- pop", true);          // сохранение файла с именем pop, не восстановление
stash("git stash apply stash@{0}", false);

commit("timeout 60 git commit -m x", true);
commit("git -c core.hooksPath=/dev/null commit -m x --no-gpg-sign", true);
commit("git -c CORE.HOOKSPATH=/dev/null commit -m x --no-gpg-sign", true);

secret("echo " + E + " | xargs c" + "at", true);
secret("ls " + E + " | xargs head -5", true);
secret("echo " + E + " | while read f; do c" + "at $f; done", true);
secret("ls " + E + " | wc -l", false);    // фильтр без пути содержимое не раскрывает

// Обёртка не должна съедать флаги внутренней команды: `-i` делает sed записью.
sql("command sed -i s/a/b/ migrations/005.sql", true);
sql("nice -n 10 sed -i s/a/b/ migrations/006.sql", true);
sql("timeout 30 cat > migrations/007.sql", true);

// --- Ревизия 2026-08-13, второй заход: лексер на классе «форма записи» --------
// Прогон 58 форм показал 36 пропусков. Три подкласса: перевод строки не считался
// разделителем (снимал ВСЕ хуки на общем лексере — и в обычной работе, не только
// под обходом), обёртки вне таблиц, и правила, обходимые длинной формой флага.

// Перевод строки — разделитель, как `;`.
stash("echo hi\ngit stash", true);
stash("cd /repo\ngit stash push -m wip", true);
stash("git \\\n  stash", true);                    // продолжение строки склеивает вызов
commit("echo ok\ngit commit --no-verify -m x", true);
cache("echo hi\ngo clean -modcache", true);
secret("echo hi\nc" + "at ~/.ssh/id_rsa", true);
sql("echo x\nsed -i s/a/b/ db/migrations/008.sql", true);
// Многострочная рабочая команда шумом не становится.
stash(`cd ${HOME}/proj\ngo build ./...\ngo test ./...`, false);
commit("git diff --stat\ngit log --oneline -5", false);

// Подстановка команды: `$(…)` и обратные кавычки — исполняемый вызов, не текст.
stash("$(git stash)", true);
stash("`git stash`", true);

// Обёртки: команда в значении опции, за позиционным параметром, в here-string.
stash('su -c "git stash"', true);
stash("runuser -u sli -- git stash", true);
stash('script -qec "git stash" /dev/null', true);   // ею же проверяется TTY-ветка хуков
stash("flock /tmp/lock git stash", true);
stash("strace -f git stash", true);
stash("watch -n1 git stash", true);
stash("unshare -r git stash", true);
stash("taskset -c 0 git stash", true);
stash("chrt -f 1 git stash", true);
stash("proxychains git stash", true);
stash("parallel git stash ::: 1", true);
stash('busybox sh -c "git stash"', true);
stash('nix-shell --run "git stash"', true);
stash("systemd-run --scope git stash", true);
stash("chroot / git stash", true);
stash("eval git stash", true);                      // eval без кавычек: хвост терялся
stash('bash <<< "git stash"', true);
stash("bash <<'EOF'\ngit stash\nEOF", true);
cache('su -c "go clean -modcache"', true);
cache("flock /tmp/l go clean -modcache", true);
commit('script -qec "git commit --no-verify -m x" /dev/null', true);
// Известный предел: команда исполняется НЕ на этом хосте — вне модели угроз хука.
stash('ssh localhost "git stash"', false);
stash("docker exec box git stash", false);

// Правила, обходимые длинной формой и сменой утилиты.
cache("rm --recursive /home/pi/go/pkg/mod", true);
cache("rm -R /home/pi/go/pkg/mod", true);
cache("find /home/pi/go/pkg/mod -delete", true);
cache("find /home/pi/go/pkg/mod -name '*.go'", false);   // обход дерева без удаления

// grep-scope-guard переведён на общий лексер: обёртка больше не снимает правило.
const { scopeReason } = await import(path.join(tmp, "grep-scope-guard.ts"));
const scope = (cmd, want) => check("grep-scope-guard", (c) => scopeReason(c, `${HOME}/proj`), cmd, want);
scope("grep -r pattern ~", true);
scope("sudo grep -r pattern ~", true);
scope("FOO=1 grep -r pattern ~", true);
scope('bash -c "grep -r pattern ~"', true);
scope("timeout 60 rg -n pattern ~", false);         // явный таймаут — осознанный долгий поиск
scope(`rg -n pattern ${HOME}/proj/src`, false);

// --- protect-pi-hooks: обвязка агента не правится изнутри сессии --------------
// До этого хука снятие любого правила стоило одной правки файла: built-in тулы
// работают с правами процесса pi, и ~/.pi ничем не был защищён.
const { bashReason: piBash, pathReason: piPath } = await import(path.join(tmp, "protect-pi-hooks.ts"));
const H = os.homedir();
const piB = (cmd, want) => check("protect-pi-hooks", (c) => piBash(c, `${HOME}/proj`), cmd, want);
const piP = (p, want) => check("protect-pi-hooks", (x) => piPath(x, `${HOME}/proj`), p, want);

// Запись: инструментом и из bash, в том числе через обёртки и подстановку.
piP(`${H}/.pi/agent/extensions/hooks/git-stash-guard.ts`, true);
piP(`${H}/.pi/agent/settings.json`, true);
piP(`${H}/.pi/agent/sessions/x.jsonl`, false);      // сессии — не обвязка
piP(`${HOME}/proj/internal/service.go`, false);
piB(`echo x > ${H}/.pi/agent/extensions/hooks/utils.ts`, true);
piB(`sed -i s/a/b/ ${H}/.pi/agent/extensions/hooks/index.ts`, true);
piB(`tee ~/.pi/agent/settings.json < /tmp/new.json`, true);
piB(`cp /tmp/x.ts ${HOME}/.pi/agent/extensions/hooks/protect-secrets.ts`, true);
piB(`sudo tee ~/.pi/agent/settings.json < /tmp/new.json`, true);
piB('echo hi\ncat > ~/.pi/agent/extensions/hooks/utils.ts', true);   // хвост многострочной

// Удаление и подмена: файл не «пишется», а исчезает.
piB("rm -f ~/.pi/agent/extensions/hooks/protect-pi-hooks.ts", true);
piB("mv ~/.pi/agent/extensions/hooks/index.ts /tmp/index.ts", true);
piB("ln -sf /tmp/fake.ts ~/.pi/agent/extensions/hooks/utils.ts", true);
piB("rm -rf /tmp/scratch", false);

// Смена прав — подготовка к записи: без этого совет «сделать хуки read-only»
// снимается одной командой, ведь владелец файлов и агент — один и тот же uid.
piB("chmod u+w ~/.pi/agent/extensions/hooks/utils.ts", true);
piB("chmod -R 755 ~/.pi/agent/extensions", true);
piB("sudo chattr -i ~/.pi/agent/extensions/hooks/index.ts", true);
piB("chown sli:sli ~/.pi/agent/settings.json", true);
piB(`chmod +x ${HOME}/proj/build.sh`, false);

// Откат рабочего дерева снимает правку, не называя файлов.
piB(`git -C ${H}/.pi reset --hard HEAD~1`, true);
piB(`git -C ${H}/.pi checkout -- agent/extensions/hooks`, true);
piB(`git -C ${H}/.pi log --oneline -5`, false);
piB(`git -C ${HOME}/proj reset --hard HEAD~1`, false);

// Дочерний pi со снятыми хуками — обход через делегирование самому себе.
piB('PI_HOOKS_OFF=git-stash-guard pi -p "прибери дерево"', true);
piB('PI_HOOKS= pi -p "…"', true);
piB('env GIT_STASH_GUARD=0 pi -p "…"', true);
piB('PROTECT_PI_HOOKS=0 pi -p "перепиши хук"', true);
piB('PI_HOOKS_DISPLAY=1 pi -p "…"', false);          // печатает состав, ничего не снимает
piB('pi -p "обычная задача"', false);
piB("pi uninstall pi-subagents", true);
piB("pi install ./my-extension", false);
piB("GIT_STASH_GUARD=0 go test ./...", false);       // без запуска pi гейт не про это

// --- test-only-guard: в коммит уходят только тесты (QA-профили) ---------------
// Гейт стоит на коммите, а не на правке: мутационная проба обязана оставаться
// возможной, поэтому проверяется, что правка не УЕХАЛА, а не что её не было.
// Хук не про Go: тестовые пути опознаются по конвенциям разных экосистем.

const {
	isTestPath: qaTestPath,
	addTargets: qaAdd,
	writtenProduction: qaWritten,
	parseStatus: qaStatus,
} = await import(path.join(tmp, "test-only-guard.ts"));

const R = `${HOME}/proj`;
const qaPath = (p, want) => check("test-only-guard", (x) => (qaTestPath(x) ? null : "block"), p, want);
const qaA = (cmd, want) => check("test-only-guard", (c) => (qaAdd(c, R, R).length ? "block" : null), cmd, want);
const qaW = (cmd, want) => check("test-only-guard", (c) => (qaWritten(c, R, R).length ? "block" : null), cmd, want);

// Тестовые пути — их агент и пишет, и коммитит.
qaPath("users_test.go", false);
qaPath("internal/service/handler_test.go", false);
qaPath("internal/service/testdata/response.json", false);
qaPath("internal/testutil/postgres.go", false);
qaPath("test/e2e/checkout.go", false);
qaPath("e2e/main.go", false);
qaPath("go.mod", false);                                  // тестовая зависимость разрешена промптом
qaPath("go.sum", false);
qaPath("docs/epics/consents/run/reports/qa-wave-1.md", false);
qaPath("docker-compose.test.yml", false);
qaPath("compose.e2e.yaml", false);
// Другие экосистемы: конвенция имени называет уровень сама.
qaPath("api/tests/test_users.py", false);
qaPath("api/users_test.py", false);
qaPath("web/src/cart.spec.ts", false);
qaPath("web/src/cart.test.tsx", false);
qaPath("web/__tests__/cart.js", false);
qaPath("src/UserServiceTest.java", false);
qaPath("spec/models/user_spec.rb", false);
qaPath("features/checkout.feature", false);
qaPath("package.json", false);                            // манифест: тестовая зависимость
qaPath("Cargo.toml", false);
// …но сам код этих экосистем остаётся продакшном.
qaPath("api/users.py", true);
qaPath("web/src/cart.ts", true);
qaPath("src/UserService.java", true);
qaPath("src/lib.rs", true);
// Продакшн — чужая зона.
qaPath("users.go", true);
qaPath("internal/service/handler.go", true);
qaPath("cmd/app/main.go", true);
qaPath("Makefile", true);
qaPath("docker-compose.yml", true);                       // общий стек: E2E идёт против него как есть
qaPath("README.md", true);
qaPath("internal/run/server.go", true);                   // каталог `run` разрешён только под отчёты
qaPath("docs/epics/x/run/fix.sh", true);
qaPath(".golangci.yml", true);                            // конфиг линтера правится не агентом

// Раскладка репозитория добирается через env: путь-префикс и маска имени.
process.env.TEST_ONLY_GUARD_ALLOW = "qa/, *Spec.scala";
qaPath("qa/harness/main.go", false);
qaPath("app/UserSpec.scala", false);
qaPath("app/User.scala", true);
delete process.env.TEST_ONLY_GUARD_ALLOW;
qaPath("qa/harness/main.go", true);                       // без env — обычный продакшн-путь

// Поимённый add продакшн-файла — форма, которой правка уезжает в индекс незаметно.
qaA("git add users.go", true);
qaA("git add users_test.go users.go", true);
qaA('eval "git add internal/service/handler.go"', true);
qaA(`git -C ${HOME}/proj add cmd/app/main.go`, true);
qaA("git add users_test.go", false);
qaA("git add internal/service/testdata/big.json", false);
qaA("git add docs/epics/x/run/reports/qa.md", false);
qaA("echo git add users.go", false);                      // текст, а не вызов
qaA("git add /tmp/scratch/notes.txt", false);             // вне репозитория — не наша граница

// Запись из bash по продакшн-пути ловится тем же признаком, что и write/edit.
qaW("sed -i s/a/b/ internal/service/handler.go", true);
qaW("echo x > users.go", true);
qaW("echo x > users_test.go", false);
qaW("go test ./... > /tmp/out.txt", false);

// Статус дерева: коммит судится по нему, включая untracked и переименования.
check("test-only-guard", () => (qaStatus(" M users.go\0?? new_helper.go\0").length === 2 ? "ok" : null), "", true);
check("test-only-guard", () => (qaStatus("R  new.go\0old.go\0").includes("old.go") ? "ok" : null), "", true);
check("test-only-guard", () => (qaStatus("").length === 0 ? null : "nonempty"), "", false);

// Индексация и коммит одной командой: гейт стайлгайда судит индекс ДО запуска,
// поэтому на такой записи он слеп и обязан её отклонить.
const gclPair = (cmd, want) =>
	check("custom-gcl-precommit", (c) => (stagesInSameCommand(c) ? "block" : null), cmd, want);

gclPair("git add users.go && git commit -m x", true);
gclPair("git add . ; git commit -m x", true);
gclPair("cd /r && git add users.go && git commit -m x", true);
gclPair('eval "git add users.go && git commit -m x"', true);
gclPair("git -C /r add users.go && git -C /r commit -m x", true);
gclPair("git rm old.go && git commit -m x", true);
gclPair("git mv a.go b.go && git commit -m x", true);
// Раздельные вызовы, коммит без индексации и текст про add — проходят.
gclPair("git commit -m x", false);
gclPair("git add users.go", false);
gclPair("git commit -m 'git add users.go в прошлом коммите'", false);
gclPair("git rm --dry-run old.go && git commit -m x", false);
gclPair("git status && git commit -m x", false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nитого: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
