/**
 * What the run did with its hands.
 *
 * Token counters say what a run cost and the timings say where it went, but
 * neither answers the question a supervisor asks about an agent's work: did it
 * read the code before changing it, and how much did it change. A run that
 * writes 300 lines having read 40 is a different event from one that writes 30
 * having read 900 — and until now both looked identical in the journal.
 *
 * Counted from the tool stream, so it measures what the agent did through its
 * own tools. Work done by shelling out (`bash: cat file`, `sed -i`) is not
 * visible here and deliberately not guessed at: an approximation that silently
 * mixes in `bash` output would make the read/write ratio unreadable.
 */

/** Tools that put file content into the model's context. */
const READ_TOOLS = new Set(["read", "read_file", "view"]);

/** Tools that replace a file whole. */
const WRITE_TOOLS = new Set(["write", "write_file", "create"]);

/** Tools that swap a fragment inside a file. */
const EDIT_TOOLS = new Set(["edit", "edit_file", "str_replace", "multi_edit", "apply_patch"]);

/** Tools that run a shell. Counted apart: they are how an agent leaves the measured path. */
const SHELL_TOOLS = new Set(["bash", "shell", "run", "exec", "run_command"]);

/**
 * Длина ключа вызова, по которому ищется повтор.
 *
 * Полный аргумент писать в память незачем — повтор виден и по началу команды,
 * а `content` целого файла в ключе стоил бы копии этого файла на каждый вызов.
 */
const CALL_KEY_CHARS = 200;

export function createAgentWorkState() {
  return {
    linesRead: 0,
    linesWritten: 0,
    linesReplaced: 0,
    readPaths: new Set(),
    writtenPaths: new Set(),
    rereads: 0,
    // Ошибки инструментов, разложенные по роду работы. Общий счётчик
    // `toolErrors` складывает в одну кучу «правка не нашла строку», «файла
    // нет» и «команда упала», а это три разных диагноза: первый значит, что
    // модель правит по памяти, а не по прочитанному.
    editErrors: 0,
    readErrors: 0,
    shellErrors: 0,
    otherErrors: 0,
    // Доля работы, ушедшей в шелл. Она же — размер слепого пятна метрик выше:
    // `bash: cat` и `sed -i` в строки не попадают.
    shellCalls: 0,
    toolCalls: 0,
    // Сколько прогон осматривался, прежде чем изменить первый файл. Отделяет
    // «долго читал» от «долго думал»: и то и другое выглядит как медленный
    // прогон, а лечится по-разному.
    firstEditMs: null,
    startedAt: null,
    // Самая длинная серия одинаковых вызовов подряд. Повтор ОТВЕТОВ ловит
    // repeat_run на прокси; здесь тот же круг, но в действиях — агент, который
    // третий раз подряд запускает ту же команду, не движется.
    repeatCallRun: 0,
    lastCallKey: null,
    currentCallRun: 0
  };
}

/**
 * Lines in a blob of text.
 *
 * A trailing newline does not add a line — `"a\nb\n"` is two lines, the same
 * two a person counts looking at the file.
 *
 * Scanned rather than split: this runs on the result of every read, and a
 * 10,000-line file costs 0.075 ms this way against 0.182 ms for
 * `slice().split().length`, which also allocates a 10,000-element array of
 * substrings for the collector to take back. Both numbers are noise next to a
 * request to the model — the point is that measuring the work should not
 * allocate a copy of it.
 */
export function countLines(text) {
  if (typeof text !== "string" || text === "") {
    return 0;
  }
  // A newline in the last position closes the final line instead of opening
  // another, so the scan stops before it.
  const end = text.endsWith("\n") ? text.length - 1 : text.length;
  let lines = 1;
  let index = 0;
  while ((index = text.indexOf("\n", index)) !== -1 && index < end) {
    lines += 1;
    index += 1;
  }
  return lines;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return null;
}

/** The file an argument object is about, under whichever name this pi uses. */
export function toolPath(args) {
  if (!args || typeof args !== "object") {
    return null;
  }
  return firstString(args.path, args.file, args.filePath, args.file_path, args.target);
}

function editPairs(args) {
  if (!args || typeof args !== "object") {
    return [];
  }
  const list = Array.isArray(args.edits) ? args.edits : [args];
  return list
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      next: firstString(entry.new_string, entry.newText, entry.new_text, entry.replacement, entry.new),
      previous: firstString(entry.old_string, entry.oldText, entry.old_text, entry.old)
    }));
}

/**
 * A tool is starting: writes are counted here, from the arguments.
 *
 * Written lines come from the request rather than the result because that is
 * where the content is — a write tool answers with "ok", not with the file.
 */
export function noteToolStart(state, toolName, args, { now = null, runStartedAt = null } = {}) {
  if (!state) {
    return;
  }
  const name = String(toolName ?? "").toLowerCase();
  const path = toolPath(args);

  state.toolCalls += 1;
  if (SHELL_TOOLS.has(name)) {
    state.shellCalls += 1;
  }
  if (state.startedAt === null && runStartedAt !== null) {
    state.startedAt = runStartedAt;
  }
  noteRepeat(state, name, args);

  if (WRITE_TOOLS.has(name)) {
    const content = firstString(args?.content, args?.text, args?.contents, args?.body);
    state.linesWritten += countLines(content ?? "");
    if (path) {
      state.writtenPaths.add(path);
    }
    noteFirstEdit(state, now);
    return;
  }

  if (EDIT_TOOLS.has(name)) {
    for (const { next, previous } of editPairs(args)) {
      state.linesWritten += countLines(next ?? "");
      state.linesReplaced += countLines(previous ?? "");
    }
    if (path) {
      state.writtenPaths.add(path);
    }
    noteFirstEdit(state, now);
  }
}

/**
 * The moment the run stopped looking and started changing.
 *
 * Measured from the first event rather than from the process start: container
 * boot and the sandbox slot queue are already counted elsewhere, and folding
 * them in here would make a busy machine look like a hesitant model.
 */
function noteFirstEdit(state, now) {
  if (state.firstEditMs !== null || now === null || state.startedAt === null) {
    return;
  }
  state.firstEditMs = Math.max(0, now - state.startedAt);
}

/**
 * The same call, again.
 *
 * Compared on name plus the head of the arguments: an agent re-reading the
 * same file after each of its own edits is doing something normal, while three
 * identical `bash` calls in a row is a run that is not moving. Only immediate
 * repeats count — the same command twice with work in between is a retry, not
 * a loop.
 */
function noteRepeat(state, name, args) {
  let key = name;
  try {
    key = `${name}:${JSON.stringify(args ?? null).slice(0, CALL_KEY_CHARS)}`;
  } catch {
    // Circular or otherwise unserialisable arguments: the name alone still
    // catches a tool called in a loop with the same shape.
  }
  state.currentCallRun = key === state.lastCallKey ? state.currentCallRun + 1 : 1;
  state.lastCallKey = key;
  state.repeatCallRun = Math.max(state.repeatCallRun, state.currentCallRun);
}

/**
 * The text a tool answered with, whatever shape this pi wraps it in.
 *
 * Reads counted only plain strings at first, and the rpc engine hands back
 * `{content: [{type: "text", …}]}` — every read scored zero lines while the
 * file count went up, which reads as "opened nine files and saw nothing".
 */
export function resultText(result) {
  if (typeof result === "string") {
    return result;
  }
  if (Array.isArray(result?.content)) {
    return result.content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  }
  if (typeof result?.output === "string") {
    return result.output;
  }
  if (typeof result?.text === "string") {
    return result.text;
  }
  return "";
}

/**
 * A tool has finished: reads are counted here, from what came back.
 *
 * The result is what actually entered the context — the argument only says
 * which file was asked for, and a range request or a truncated answer would
 * make that a different number. A failed read put nothing in the context and
 * counts as nothing.
 */
export function noteToolEnd(state, toolName, args, result, isError = false) {
  if (!state) {
    return;
  }
  const name = String(toolName ?? "").toLowerCase();

  if (isError) {
    // Which kind of thing went wrong is the whole point of splitting this out:
    // a failed edit says the model wrote against code it had not read, a failed
    // read says it guessed a path, a failed command says the work itself broke.
    if (EDIT_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
      state.editErrors += 1;
    } else if (READ_TOOLS.has(name)) {
      state.readErrors += 1;
    } else if (SHELL_TOOLS.has(name)) {
      state.shellErrors += 1;
    } else {
      state.otherErrors += 1;
    }
    return;
  }

  if (!READ_TOOLS.has(name)) {
    return;
  }
  state.linesRead += countLines(resultText(result));
  const path = toolPath(args);
  if (!path) {
    return;
  }
  // A file read again is a signal in itself: the run either lost what it had or
  // is checking its own edit. Counted separately rather than folded into the
  // path set, which would hide it.
  if (state.readPaths.has(path)) {
    state.rereads += 1;
  } else {
    state.readPaths.add(path);
  }
}

/** The plain numbers a finished run reports. */
export function summarizeAgentWork(state) {
  if (!state) {
    return {
      linesRead: 0,
      linesWritten: 0,
      linesReplaced: 0,
      filesRead: 0,
      filesWritten: 0,
      rereads: 0,
      editErrors: 0,
      readErrors: 0,
      shellErrors: 0,
      otherErrors: 0,
      shellCalls: 0,
      toolCalls: 0,
      firstEditMs: null,
      repeatCallRun: 0
    };
  }
  return {
    linesRead: state.linesRead,
    linesWritten: state.linesWritten,
    linesReplaced: state.linesReplaced,
    filesRead: state.readPaths.size,
    filesWritten: state.writtenPaths.size,
    rereads: state.rereads,
    editErrors: state.editErrors,
    readErrors: state.readErrors,
    shellErrors: state.shellErrors,
    otherErrors: state.otherErrors,
    shellCalls: state.shellCalls,
    toolCalls: state.toolCalls,
    firstEditMs: state.firstEditMs,
    repeatCallRun: state.repeatCallRun
  };
}

/**
 * Add up two runs' work, for a run resumed after a truncation.
 *
 * File counts are summed rather than de-duplicated: the halves are separate
 * processes and neither kept the other's path set. A file touched in both
 * halves is therefore counted twice — an overstatement bounded by how often a
 * run has to be resumed at all, and the alternative is carrying every path
 * through the journal to be exact about a rare case.
 */
export function mergeAgentWork(first = {}, second = {}) {
  const add = (a, b) => (a ?? 0) + (b ?? 0);
  return {
    linesRead: add(first.linesRead, second.linesRead),
    linesWritten: add(first.linesWritten, second.linesWritten),
    linesReplaced: add(first.linesReplaced, second.linesReplaced),
    filesRead: add(first.filesRead, second.filesRead),
    filesWritten: add(first.filesWritten, second.filesWritten),
    rereads: add(first.rereads, second.rereads),
    editErrors: add(first.editErrors, second.editErrors),
    readErrors: add(first.readErrors, second.readErrors),
    shellErrors: add(first.shellErrors, second.shellErrors),
    otherErrors: add(first.otherErrors, second.otherErrors),
    shellCalls: add(first.shellCalls, second.shellCalls),
    toolCalls: add(first.toolCalls, second.toolCalls),
    // The first edit of the whole job is the earlier of the two, and a half
    // that never edited has no opinion — its `null` must not win.
    firstEditMs:
      [first.firstEditMs, second.firstEditMs].filter((value) => typeof value === "number").length
        ? Math.min(
            ...[first.firstEditMs, second.firstEditMs].filter((value) => typeof value === "number")
          )
        : null,
    // A loop is the longest one either half saw, not their sum: two runs of
    // three are not a run of six.
    repeatCallRun: Math.max(Number(first.repeatCallRun) || 0, Number(second.repeatCallRun) || 0)
  };
}
