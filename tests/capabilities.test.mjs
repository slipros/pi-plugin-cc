import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  allPresetCapabilities,
  hasShell,
  presetCapabilities,
  resolvedSkills
} from "../plugins/pi/scripts/lib/capabilities.mjs";
import { presetLines } from "../plugins/pi/scripts/lib/render.mjs";

const PROFILES = {
  base: { image: "img", skills: ["/pi-skills/vision", "/pi-skills/git-commit"] },
  lite: { profile: "base", image: "img" },
  bare: { image: "img" }
};

function configWith(presets, profiles = PROFILES) {
  return { presets, sandboxProfiles: profiles };
}

test("preset on a profile that mounts the vision skill reports it", () => {
  const config = configWith({ dev: { sandbox: { profile: "base" } } });
  assert.equal(presetCapabilities(config, "dev").vision, "skill");
});

test("skill mounted by an inherited profile counts too", () => {
  const config = configWith({ dev: { sandbox: { profile: "lite" } } });
  assert.equal(presetCapabilities(config, "dev").vision, "skill");
});

test("profile without the skill reports no vision", () => {
  const config = configWith({ dev: { sandbox: { profile: "bare" } } });
  assert.equal(presetCapabilities(config, "dev").vision, null);
});

test("a skill without a shell to run it is not a capability", () => {
  // coverage-auditor is the real case: blind by allow-list. Offering it as an
  // agent that can look at a screenshot would send work somewhere it dies.
  const config = configWith({
    blind: { sandbox: { profile: "base" }, tools: "read,grep,find,ls" }
  });
  const caps = presetCapabilities(config, "blind");
  assert.equal(caps.shell, false);
  assert.equal(caps.vision, null);
});

test("read-only and noTools presets have no shell", () => {
  const config = configWith({
    ro: { sandbox: { profile: "base" }, readOnly: true },
    none: { sandbox: { profile: "base" }, noTools: true }
  });
  assert.equal(presetCapabilities(config, "ro").vision, null);
  assert.equal(presetCapabilities(config, "none").vision, null);
});

test("excludeTools bash removes the capability the mount would give", () => {
  const config = configWith({
    dev: { sandbox: { profile: "base" }, excludeTools: ["bash"] }
  });
  assert.equal(presetCapabilities(config, "dev").vision, null);
});

test("noSkills wins over any mount", () => {
  const config = configWith({ dev: { sandbox: { profile: "base" }, noSkills: true } });
  assert.equal(presetCapabilities(config, "dev").vision, null);
});

test("a skill named on the preset itself counts", () => {
  const config = configWith({ dev: { sandbox: { profile: "bare" }, skills: ["/elsewhere/vision"] } });
  assert.equal(presetCapabilities(config, "dev").vision, "skill");
});

test("a trailing slash does not hide the skill name", () => {
  const config = configWith({ dev: { sandbox: { profile: "bare" }, skills: ["/elsewhere/vision/"] } });
  assert.equal(presetCapabilities(config, "dev").vision, "skill");
});

test("a skill whose name merely contains vision does not count", () => {
  const config = configWith({ dev: { sandbox: { profile: "bare" }, skills: ["/skills/vision-notes"] } });
  assert.equal(presetCapabilities(config, "dev").vision, null);
});

test("unsandboxed runs see the host skill directory", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-caps-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".pi", "agent", "skills", "vision"), { recursive: true });

  const config = configWith({ local: { sandbox: "none" } });
  assert.equal(presetCapabilities(config, "local", { homeDir: home }).vision, "skill");

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pi-caps-empty-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(presetCapabilities(config, "local", { homeDir: empty }).vision, null);
});

test("sandboxed runs ignore the host skill directory", (t) => {
  // The container never sees it, so crediting the preset with it would be a
  // capability that vanishes the moment the run actually starts.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-caps-host-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".pi", "agent", "skills", "vision"), { recursive: true });

  const config = configWith({ boxed: { sandbox: { profile: "bare" } } });
  assert.equal(presetCapabilities(config, "boxed", { homeDir: home }).vision, null);
  assert.deepEqual(resolvedSkills({ sandbox: { profile: "bare" }, skills: [] }, config), []);
});

test("tags are taken as written, from a list or a comma string", () => {
  const config = configWith({
    a: { tags: ["go", "dind"] },
    b: { tags: "go, dind" }
  });
  assert.deepEqual(presetCapabilities(config, "a").tags, ["go", "dind"]);
  assert.deepEqual(presetCapabilities(config, "b").tags, ["go", "dind"]);
});

test("an unresolvable preset degrades to no capabilities instead of throwing", () => {
  const config = { presets: { broken: { git: { name: "no email" } } } };
  const caps = presetCapabilities(config, "broken");
  assert.equal(caps.vision, null);
  assert.equal(caps.shell, false);
});

test("hasShell reads an allow-list in either shape", () => {
  assert.equal(hasShell({ tools: "read,bash" }), true);
  assert.equal(hasShell({ tools: ["read", "bash"] }), true);
  assert.equal(hasShell({ tools: ["read"] }), false);
  assert.equal(hasShell({}), true);
});

test("capabilities land in the preset line, not in a separate block", () => {
  const config = configWith({ dev: { sandbox: { profile: "base" }, tags: ["go"] } });
  const [line] = presetLines(config.presets, allPresetCapabilities(config));
  assert.match(line, /vision `skill`/);
  assert.match(line, /tags `go`/);
});

test("a preset with nothing computed keeps its line unchanged", () => {
  const config = configWith({ plain: { sandbox: { profile: "bare" }, model: "m" } });
  const [line] = presetLines(config.presets, allPresetCapabilities(config));
  assert.doesNotMatch(line, /vision/);
  assert.doesNotMatch(line, /tags/);
});

// Скилл, объявленный пресетом и не смонтированный профилем, — это агент без
// правил, которые скилл несёт: прогон выглядит обычным, а разницу видно только
// в поведении. Ответ обязан быть там, где агента ВЫБИРАЮТ.
test("equipment the container will not have is named in the preset line", () => {
  const config = configWith(
    { dev: { sandbox: { profile: "half" } } },
    { half: { image: "img", skills: ["/pi-skills/git-commit"], mounts: ["~/x:/pi-skills/vision:ro"] } }
  );
  assert.deepEqual(presetCapabilities(config, "dev").mountGaps, ["/pi-skills/git-commit"]);
  const [line] = presetLines(config.presets, allPresetCapabilities(config));
  assert.match(line, /НЕ СМОНТИРОВАНО: \/pi-skills\/git-commit/);
});

test("a preset whose equipment is mounted reports no gaps", () => {
  const config = configWith(
    { dev: { sandbox: { profile: "whole" } } },
    { whole: { image: "img", skills: ["/pi-skills/git-commit"], mounts: ["~/skills:/pi-skills:ro"] } }
  );
  assert.deepEqual(presetCapabilities(config, "dev").mountGaps, []);
  const [line] = presetLines(config.presets, allPresetCapabilities(config));
  assert.doesNotMatch(line, /НЕ СМОНТИРОВАНО/);
});
