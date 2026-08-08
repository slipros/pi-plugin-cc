import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, splitRawArgumentString } from "../plugins/pi/scripts/lib/args.mjs";

test("splitRawArgumentString keeps quoted segments together", () => {
  assert.deepEqual(splitRawArgumentString(`--model x  fix "the flaky test" now`), [
    "--model",
    "x",
    "fix",
    "the flaky test",
    "now"
  ]);
});

test("splitRawArgumentString handles single quotes and escapes", () => {
  assert.deepEqual(splitRawArgumentString(`--system-prompt 'be terse' --role "say \\"hi\\""`), [
    "--system-prompt",
    "be terse",
    "--role",
    'say "hi"'
  ]);
});

test("splitRawArgumentString returns nothing for blank input", () => {
  assert.deepEqual(splitRawArgumentString("   "), []);
  assert.deepEqual(splitRawArgumentString(undefined), []);
});

const SCHEMA = {
  booleans: ["background", "json"],
  strings: ["model", "role"],
  collect: ["append-system-prompt"],
  aliases: { m: "model", resume: "session" }
};

test("parseArgs separates flags from positional text", () => {
  const { flags, positional } = parseArgs(
    ["--model", "glm-5.2", "--background", "investigate", "the", "bug"],
    SCHEMA
  );
  assert.equal(flags.model, "glm-5.2");
  assert.equal(flags.background, true);
  assert.deepEqual(positional, ["investigate", "the", "bug"]);
});

test("parseArgs supports --flag=value and repeated collect flags", () => {
  const { flags } = parseArgs(
    ["--model=glm-5.2", "--append-system-prompt", "a", "--append-system-prompt=b"],
    SCHEMA
  );
  assert.equal(flags.model, "glm-5.2");
  assert.deepEqual(flags["append-system-prompt"], ["a", "b"]);
});

test("parseArgs resolves aliases to canonical names", () => {
  const { flags } = parseArgs(["--m", "kimi-k3"], SCHEMA);
  assert.equal(flags.model, "kimi-k3");
});

test("parseArgs treats everything after -- as positional", () => {
  const { positional, flags } = parseArgs(["--json", "--", "--model", "literal"], SCHEMA);
  assert.equal(flags.json, true);
  assert.deepEqual(positional, ["--model", "literal"]);
});

test("parseArgs collects unknown flags instead of swallowing them", () => {
  const { unknown } = parseArgs(["--nope"], SCHEMA);
  assert.deepEqual(unknown, ["--nope"]);
});

test("parseArgs rejects a value flag with no value", () => {
  assert.throws(() => parseArgs(["--model"], SCHEMA), /expects a value/);
});
