/**
 * memory-recall — before_agent_start.
 *
 * Кладёт в системный промпт ОГЛАВЛЕНИЕ памяти (список concept'ов), а не результаты
 * семантического поиска. Так же устроен хук Claude Code
 * `~/.claude/hooks/muninn-session-start.sh` — правятся ПАРНО, и это принципиально:
 *
 *   Прошлая версия прогоняла `mem rc` по тексту промпта и вклеивала записи с
 *   content_match >= 0.35. На коротких абстрактных вопросах («Кто я?») ретривал
 *   промахивается — короткая запись user/role (116 симв.) не попадает даже в
 *   top-20, её вытесняют длинные многотемные записи. Хук молча не вклеивал
 *   ничего, агент шёл в тот же `rc` и отвечал «в памяти этого нет» при живой
 *   записи. Оглавление от качества эмбеддингов не зависит вовсе: агент видит
 *   имя записи и читает её напрямую.
 *
 * Два блока собираются по-разному:
 *   `ops`  — полное оглавление concept'ов (~900 байт, дёшево).
 *   `docs` — только топ-3 имени, релевантных текущему проекту: cwd прогоняется через
 *            /api/activate. Полное оглавление `docs` — это 200 выжимок udmp/* и ~3.8k
 *            токенов в каждой сессии (13.2k → 17k input на первом ходу), при том что
 *            нужны они лишь в задачах по документации DataNova.
 *
 * В `docs` ходим напрямую в HTTP API, а не через `mem rc`: CLI ведёт журнал recall'ов,
 * и вызов из хука засчитался бы агенту как поиск («это 3-й recall за 10 минут —
 * прекрати искать») ещё до того, как тот что-то спросил.
 *
 * Хук помечен optIn в REGISTRY (index.ts): по умолчанию не подключается, включается
 * через PI_HOOKS_ON=memory-recall. Агенту, которому дали готовую постановку
 * (coding-агент в песочнице), память не нужна — за него уже подумали, а оглавление
 * стоит токенов и сетевого похода к MuninnDB.
 *
 * Управление (env) — только поведение; включение/выключение живёт в index.ts:
 *   MEMORY_HOOK_VAULTS=ops        — чьё ПОЛНОЕ оглавление перечислять
 *   MEMORY_HOOK_DOCS=default      — вольт для топ-N по проекту; пусто = блок выключен
 *   MEMORY_HOOK_DOCS_TOP=3        — сколько имён из него показывать
 *   MEMORY_HOOK_DOCS_MIN=0.25     — ниже этого content_match имена считаются шумом
 *                                   (мягче CLI-шного 0.35: запросом служит путь, а не вопрос)
 *   MEMORY_HOOK_TTL=300           — сколько секунд жить кешу оглавления
 *   MEMORY_HOOK_DISPLAY=1         — печатать подгруженное в stderr (отладка)
 *   MEMORY_MEM_PATH=mem           — путь к CLI mem, если не в PATH
 *   MUNINN_HOST=...               — адрес MuninnDB
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

const MEM_PATH = process.env.MEMORY_MEM_PATH || "mem";
const HOST = process.env.MUNINN_HOST || "http://127.0.0.1:8475";
const KEY_SH = join(process.env.HOME || "~", ".claude/skills/memory/scripts/muninn-key.sh");

/**
 * Имена записей вольта. `null` = вольт НЕ прочитан (сервер молчит, ключ протух),
 * пустой массив = вольт прочитан и пуст. Раньше оба случая давали `[]`, блок молча
 * исчезал из врезки, а шапка «Ниже — только имена записей» оставалась: врезка
 * выглядела полной, и агент делал ровно тот вывод, ради предотвращения которого
 * хук и написан — «в операционной памяти пусто».
 */
async function vaultConcepts(pi: ExtensionAPI, vault: string): Promise<string[] | null> {
	try {
		// bash -lc подхватывает ~/.profile (PATH). MEM_RAW отдаёт сырой JSON.
		const r = await pi.exec("bash", ["-lc", `MEM_RAW=1 ${MEM_PATH} --${vault} l 200`], { timeout: 8000 });
		if (r.code !== 0 || !r.stdout) return null;
		const d = JSON.parse(r.stdout);
		if (d.error) return null;
		const items = d.engrams || d.activations || d.entries || [];
		// Имена приходят из данных и вклеиваются в системный промпт: перевод строки
		// внутри concept'а рисует лишние строки врезки, вплоть до фальшивого заголовка.
		const seen = new Set<string>();
		return items
			.map((m: { concept?: string }) => String(m.concept || "").replace(/\s+/g, " ").trim().slice(0, 120))
			.filter((c: string) => c && !seen.has(c) && (seen.add(c), true));
	} catch {
		return null;
	}
}

/** Запрос к docs из хвоста пути проекта: /mnt/w/GPM-Data/UDMP → «GPM Data UDMP». */
function projectQuery(cwd: string): string {
	const skip = new Set(
		["mnt", "home", "srv", "opt", "var", "tmp", "users", "projects", "src", "work", "github", "gitlab",
			process.env.USER || ""].filter(Boolean),
	);
	return cwd
		.split(sep)
		.filter((p) => p.length > 1 && !skip.has(p.toLowerCase()))
		.slice(-3)
		.map((p) => p.replace(/[_.-]+/g, " "))
		.join(" ");
}

type Hit = { concept: string; match: number };

async function docsHits(pi: ExtensionAPI, vault: string, query: string): Promise<Hit[]> {
	// Тело запроса кладём в файл: экранировать JSON внутри bash -lc — верный способ
	// однажды поймать кавычку из имени каталога.
	const bodyFile = join(tmpdir(), `pi-memory-q-${process.pid}.json`);
	try {
		writeFileSync(bodyFile, JSON.stringify({ context: [query] }), { mode: 0o600 });
		const cmd =
			`source ${KEY_SH}; KEY=$(muninn_resolve_key ${vault}); ` +
			`curl -s --max-time 5 -X POST "${HOST}/api/activate?vault=${vault}" ` +
			`\${KEY:+-H "Authorization: Bearer $KEY"} -H 'Content-Type: application/json' -d @${bodyFile}`;
		const r = await pi.exec("bash", ["-lc", cmd], { timeout: 8000 });
		if (r.code !== 0 || !r.stdout) return [];
		const d = JSON.parse(r.stdout);
		if (d.error) return [];
		const items = d.activations || d.engrams || d.entries || [];
		const min = parseFloat(process.env.MEMORY_HOOK_DOCS_MIN || "0.25");
		const top = parseInt(process.env.MEMORY_HOOK_DOCS_TOP || "3", 10);
		const ranked: Hit[] = items
			.map((m: { concept?: string; score_components?: { content_match?: number } }) => ({
				concept: m.concept || "?",
				match: m.score_components?.content_match ?? 0,
			}))
			.filter((h: Hit) => h.match >= min)
			.sort((a: Hit, b: Hit) => b.match - a.match);

		// Дедуп после сортировки, иначе у повторного concept'а выжил бы худший match.
		const seen = new Set<string>();
		return ranked.filter((h) => !seen.has(h.concept) && (seen.add(h.concept), true)).slice(0, top);
	} catch {
		return [];
	} finally {
		try {
			unlinkSync(bodyFile);
		} catch {
			// файла нет — и хорошо
		}
	}
}

/**
 * Врезка на случай непрочитанного вольта. Говорит только о себе: индекс не поднят.
 *
 * Вывод «памяти нет» отсюда НЕ следует, и раньше он делался зря — NAS паркует диски,
 * первый запрос после простоя уходит на раскрутку шпинделя и не укладывается в таймаут,
 * а следующий тот же вызов отвечает за миллисекунды. В транскриптах Claude Code таких
 * ложных срабатываний 9 из 79 стартов (11%), кластерами по дням — форма именно
 * засыпающего хранилища. Поэтому единственная инструкция здесь — повторить чтение
 * руками, а сообщать пользователю только по его итогу.
 */
function unavailableBlock(dead: string[]): string {
	return [
		"\n\n## Память (MuninnDB)",
		`ИНДЕКС ПАМЯТИ НЕ ПОДНЯТ: вольт(ы) ${dead.join(", ")} не прочитаны (MuninnDB ${HOST}).`,
		"Это значит только одно: оглавления вольта в этом контексте нет. Сервер мог просто" +
			" раскручивать диски — таймаут здесь не равен отказу.",
		"О состоянии памяти НЕ СУДИ по этой врезке и НЕ СООБЩАЙ пользователю, что память" +
			" недоступна, пока не повторил чтение сам: `mem l 5` или `mem -A rc <запрос>`.",
		"Отвечает — работай как обычно, оглавление тяни через `mem l`. Молчит и он — вот тогда" +
			" скажи пользователю, что память недоступна.",
	].join("\n");
}

async function buildIndex(pi: ExtensionAPI): Promise<string> {
	const cwd = process.cwd();
	const query = projectQuery(cwd);
	// Кеш привязан к проекту: блок docs зависит от cwd, общий файл отдал бы в одном
	// проекте подборку из другого.
	const cache = join(tmpdir(), `pi-memory-index-${createHash("sha1").update(cwd).digest("hex").slice(0, 12)}.json`);
	const ttl = parseInt(process.env.MEMORY_HOOK_TTL || "300", 10) * 1000;
	try {
		if (Date.now() - statSync(cache).mtimeMs < ttl) {
			return readFileSync(cache, "utf8");
		}
	} catch {
		// кеша нет или он протух — строим заново
	}

	const vaults = (process.env.MEMORY_HOOK_VAULTS || "ops").split(",").map((v) => v.trim()).filter(Boolean);
	const blocks: string[] = [];
	const dead: string[] = [];
	for (const v of vaults) {
		const concepts = await vaultConcepts(pi, v);
		if (concepts === null) {
			dead.push(v);
			continue;
		}
		blocks.push(
			`Что лежит в вольте \`${v}\`:\n` + (concepts.length ? concepts.map((c) => `- ${c}`).join("\n") : "- пусто"),
		);
	}

	// Вольт не прочитан — говорим об этом прямо, как это делает хук Claude Code.
	// Врезку в таком виде НЕ кешируем: иначе следующие сессии в этом каталоге до
	// пяти минут стартуют без памяти уже при живой базе (проверено).
	if (dead.length) return unavailableBlock(dead);

	const docsVault = (process.env.MEMORY_HOOK_DOCS ?? "default").trim();
	if (docsVault && query) {
		const hits = await docsHits(pi, docsVault, query);
		if (hits.length) {
			blocks.push(
				`В вольте \`${docsVault}\` (${query}) ближе всего к текущему проекту — имена, содержимое читай сам:\n` +
					hits.map((h) => `- ${h.concept}  (match ${h.match.toFixed(2)})`).join("\n") +
					`\nЭто не всё содержимое \`${docsVault}\` — там сотни записей, ` +
					`ищи их через \`mem --${docsVault} rc <запрос>\`.`,
			);
		}
	}

	if (!blocks.length) return "";

	const text = [
		"\n\n## Память (MuninnDB)",
		"Источник правды о пользователе и проектах — MuninnDB, доступ через CLI `mem` (скилл memory), не через файлы.",
		"Ниже — только имена записей (concept'ы). Содержимое тяни прямым чтением `mem g <concept>` —",
		"поиска не тратит и не промахивается; **если имя в списке отвечает на вопрос, идти в `rc` незачем**.",
		"Не знаешь, в каком вольте факт — сквозной поиск одним вызовом: `mem -A rc <запрос>`",
		"(оба вольта параллельно, вольт печатается у каждой записи). Вольт известен — одиночный `mem rc`.",
		"Запрос к `rc` — обычный вопрос: ищется смысл, синонимы находятся. Точные имена (файлы, команды,",
		"сервисы) поднимают match, но не обязательны.",
		"Промах `rc` — не отсутствие факта. Переспроси точными именами (сервис, файл, команда, латиница) —",
		"это другой запрос, он не блокируется; или прочти по имени из списка ниже.",
		"",
		// Разницу ev/ap из названий не угадать, а цена ошибки асимметрична: `ev` вместо
		// `ap` стирает прежний текст записи целиком.
		"Запись: `mem r <concept>` — новый факт; `mem ev <id|concept>` ЗАМЕНЯЕТ текст записи целиком;",
		"`mem ap <id|concept>` ДОПИСЫВАЕТ к нему. Факт дополняется — `ap`, а не `ev`.",
		"Правь по имени (concept), а не по id из старой выдачи: правка устаревшей версии ветвит запись.",
		"",
		blocks.join("\n\n"),
	].join("\n");

	try {
		writeFileSync(cache, text, { mode: 0o600 });
	} catch {
		// кеш не обязателен
	}
	return text;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const index = await buildIndex(pi);
		if (!index) return undefined;
		if (process.env.MEMORY_HOOK_DISPLAY === "1") {
			console.error("[memory-hook] оглавление: " + (index.match(/^- /gm) || []).length + " записей");
		}
		return { systemPrompt: event.systemPrompt + index };
	});
}
