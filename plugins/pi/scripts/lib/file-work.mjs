/**
 * How much code a run actually moved.
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

export function createFileWorkState() {
  return {
    linesRead: 0,
    linesWritten: 0,
    linesReplaced: 0,
    readPaths: new Set(),
    writtenPaths: new Set(),
    rereads: 0
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
export function noteToolStart(state, toolName, args) {
  if (!state) {
    return;
  }
  const name = String(toolName ?? "").toLowerCase();
  const path = toolPath(args);

  if (WRITE_TOOLS.has(name)) {
    const content = firstString(args?.content, args?.text, args?.contents, args?.body);
    state.linesWritten += countLines(content ?? "");
    if (path) {
      state.writtenPaths.add(path);
    }
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
  }
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
  if (!state || isError) {
    return;
  }
  const name = String(toolName ?? "").toLowerCase();
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
export function summarizeFileWork(state) {
  if (!state) {
    return { linesRead: 0, linesWritten: 0, linesReplaced: 0, filesRead: 0, filesWritten: 0, rereads: 0 };
  }
  return {
    linesRead: state.linesRead,
    linesWritten: state.linesWritten,
    linesReplaced: state.linesReplaced,
    filesRead: state.readPaths.size,
    filesWritten: state.writtenPaths.size,
    rereads: state.rereads
  };
}

/**
 * Add up two runs' file work, for a run resumed after a truncation.
 *
 * File counts are summed rather than de-duplicated: the halves are separate
 * processes and neither kept the other's path set. A file touched in both
 * halves is therefore counted twice — an overstatement bounded by how often a
 * run has to be resumed at all, and the alternative is carrying every path
 * through the journal to be exact about a rare case.
 */
export function mergeFileWork(first = {}, second = {}) {
  const add = (a, b) => (a ?? 0) + (b ?? 0);
  return {
    linesRead: add(first.linesRead, second.linesRead),
    linesWritten: add(first.linesWritten, second.linesWritten),
    linesReplaced: add(first.linesReplaced, second.linesReplaced),
    filesRead: add(first.filesRead, second.filesRead),
    filesWritten: add(first.filesWritten, second.filesWritten),
    rereads: add(first.rereads, second.rereads)
  };
}
