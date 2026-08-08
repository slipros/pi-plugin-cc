import { StringDecoder } from "node:string_decoder";

/**
 * Strict JSONL reader.
 *
 * pi's RPC framing splits on LF only — Node's `readline` also breaks on
 * U+2028/U+2029, which are legal inside JSON strings, so it must not be used
 * here.
 */
export function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const emit = (line) => {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed) {
      onLine(trimmed);
    }
  };

  stream.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      emit(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  });

  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer) {
      emit(buffer);
      buffer = "";
    }
  });
}

/** Parse a JSONL line, returning null instead of throwing on garbage. */
export function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
