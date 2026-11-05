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
import { resolveRunSettings } from "../plugins/pi/scripts/lib/config.mjs";
import { sandboxForRun, sandboxMountGaps } from "../plugins/pi/scripts/lib/sandbox.mjs";

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
    { half: { image: "img", skills: ["/pi-skills/git-commit"], mounts: ["~/x:/pi-skills-other:ro"] } }
  );
  assert.deepEqual(presetCapabilities(config, "dev").mountGaps, ["/pi-skills/git-commit"]);
  const [line] = presetLines(config.presets, allPresetCapabilities(config));
  assert.match(line, /NOT MOUNTED: \/pi-skills\/git-commit/);
});

test("a preset whose equipment is mounted reports no gaps", () => {
  // Real directory on the host side: a mount pointing at nothing is itself a gap
  // (docker would give the container an empty directory), and that rule has its
  // own test in sandbox.test.mjs.
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-skills-"));
  fs.mkdirSync(path.join(hostDir, "git-commit"));
  try {
    const config = configWith(
      { dev: { sandbox: { profile: "whole" } } },
      { whole: { image: "img", skills: ["/pi-skills/git-commit"], mounts: [`${hostDir}:/pi-skills:ro`] } }
    );
    assert.deepEqual(presetCapabilities(config, "dev").mountGaps, []);
    const [line] = presetLines(config.presets, allPresetCapabilities(config));
    assert.doesNotMatch(line, /NOT MOUNTED/);
  } finally {
    fs.rmSync(hostDir, { recursive: true, force: true });
  }
});

test("the preset's own mounts count as carried equipment", () => {
  // web-developer-zai is the real case: a profile mounting nothing, the preset
  // carrying its own skill mounts. Judging gaps against the bare profile
  // reported NOT MOUNTED for a preset the run started just fine.
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-skills-"));
  fs.mkdirSync(path.join(hostDir, "git-commit"));
  fs.mkdirSync(path.join(hostDir, "browser"));
  try {
    const config = configWith({
      dev: {
        sandbox: { profile: "bare" },
        skills: ["/pi-skills/git-commit", "/pi-skills/browser"],
        mounts: [`${hostDir}/git-commit:/pi-skills/git-commit:ro`, `${hostDir}/browser:/pi-skills/browser:ro`]
      }
    });
    assert.deepEqual(presetCapabilities(config, "dev").mountGaps, []);
  } finally {
    fs.rmSync(hostDir, { recursive: true, force: true });
  }
});

test("a skill carried by neither the profile nor the preset's mounts is still a gap", () => {
  const config = configWith({
    dev: {
      sandbox: { profile: "bare" },
      skills: ["/pi-skills/git-commit"],
      mounts: ["/tmp/nowhere-else:/some/other/dir"]
    }
  });
  assert.deepEqual(presetCapabilities(config, "dev").mountGaps, ["/pi-skills/git-commit"]);
});

test("a preset mount whose host path does not exist is still a gap (missing-host-path)", () => {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-skills-"));
  const missing = path.join(hostDir, "git-commit");
  try {
    const config = configWith({
      dev: {
        sandbox: { profile: "bare" },
        skills: ["/pi-skills/git-commit"],
        mounts: [`${missing}:/pi-skills/git-commit:ro`]
      }
    });
    assert.deepEqual(presetCapabilities(config, "dev").mountGaps, ["/pi-skills/git-commit"]);
  } finally {
    fs.rmSync(hostDir, { recursive: true, force: true });
  }
});

test("one preset with an unparseable mount degrades itself, not the listing", () => {
  // The reason the whole channel matters: `presets --json` answers every
  // rejected delegation, so a single mount typo killing the listing silences
  // every hook at once. The broken preset carries the parse error; the healthy
  // one next to it is still described in full.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-home-"));
  try {
    const config = configWith({
      good: { sandbox: { profile: "base" } },
      typo: { sandbox: { profile: "base" }, mounts: ["/pi-skills/git-commit"] }
    });
    const caps = allPresetCapabilities(config, { homeDir: home });
    assert.equal(caps.good.vision, "skill", "the healthy preset keeps its capabilities");
    assert.equal(caps.good.unresolved, undefined);
    assert.equal(caps.typo.vision, null);
    assert.equal(caps.typo.shell, false);
    assert.deepEqual(caps.typo.skills, []);
    assert.match(caps.typo.unresolved, /Invalid mount/);

    const lines = presetLines(config.presets, caps);
    assert.match(lines[0], /vision `skill`/);
    assert.doesNotMatch(lines[0], /NOT PARSED/);
    assert.match(lines[1], /NOT PARSED.*Invalid mount/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the capability report and the run path judge the same sandbox (no docker needed)", () => {
  // The divergence this file exists to prevent: `presets` counted gaps against
  // the bare profile while the run attached the preset's mounts first, and the
  // two answers disagreed. Both sides here go through the shared code paths and
  // nothing else: the report through `presetCapabilities`, the run through the
  // same `sandboxForRun` + `sandboxMountGaps` pair `executeRun` judges its gaps
  // with. A host source is created so the sides CAN agree on empty, and a
  // second preset names a source that does not exist so `reason` is part of the
  // comparison — value-only comparison cannot tell "unmounted" from "mounted
  // from a path that does not exist". No docker: an image-dependent gate is
  // green on the author's machine and red everywhere else.
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-skills-"));
  fs.mkdirSync(path.join(hostDir, "git-commit"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-worktree-"));
  try {
    const config = configWith(
      {
        dev: {
          sandbox: { profile: "bare" },
          skills: ["/pi-skills/git-commit"],
          mounts: [`${hostDir}/git-commit:/pi-skills/git-commit:ro`]
        },
        broken: {
          sandbox: { profile: "bare" },
          skills: ["/pi-skills/git-commit"],
          mounts: [`${hostDir}/absent:/pi-skills/git-commit:ro`]
        }
      },
      { bare: { image: "img" } }
    );

    const runSide = (name) => {
      const settings = resolveRunSettings(config, "delegate", { preset: name });
      return sandboxMountGaps(sandboxForRun(settings, config), {
        workspaceRoot: process.cwd(),
        extensions: settings.extensions ?? [],
        skills: settings.noSkills ? [] : resolvedSkills(settings, config, { homeDir: root })
      });
    };

    // An existing host source leaves no gap on either side.
    const devReport = presetCapabilities(config, "dev", { homeDir: root }).mountGaps;
    assert.deepEqual(runSide("dev"), []);
    assert.deepEqual(devReport, []);

    // The missing source is named on both sides, with the reason intact.
    const brokenRun = runSide("broken");
    assert.deepEqual(
      brokenRun,
      [{ label: "skill", value: "/pi-skills/git-commit", reason: "missing-host-path", hostPath: path.join(hostDir, "absent") }]
    );
    assert.deepEqual(
      presetCapabilities(config, "broken", { homeDir: root }).mountGaps,
      brokenRun.map((gap) => gap.value),
      "the report names the same gap the run path judges"
    );
  } finally {
    fs.rmSync(hostDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the capability report and the run path judge the same sandbox (real build)", async (t) => {
  // The full-build variant: the real buildRunSettings (worktree, read-only
  // guard and all), not a hand-copied assembly — a copy can agree with the
  // report while the actual run path answers differently. This needs a local
  // docker daemon AND the sandbox image, which no test environment is promised
  // to have; without them the case states so out loud via t.skip rather than
  // pretending nothing was checked.
  const { sandboxPreflight } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const preflight = sandboxPreflight({ mode: "docker", image: "busybox" });
  if (!preflight.ok) {
    t.skip(`нужен локальный образ busybox (docker daemon + image): ${preflight.errors[0]}`);
    return;
  }

  const { buildRunSettings } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { execFileSync } = await import("node:child_process");

  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-skills-"));
  fs.mkdirSync(path.join(hostDir, "git-commit"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-worktree-"));
  const main = path.join(root, "main");
  const tree = path.join(root, "tree");
  const run = (args, cwd) =>
    execFileSync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  try {
    run(["init", "-q", main], root);
    run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "init"], main);
    run(["worktree", "add", "-q", tree, "-b", "side"], main);
    const gitDir = path.join(main, ".git");

    // The second mount names a target the worktree's read-only guard also
    // claims: the report must not count it as carried equipment, and the run
    // must say out loud that the guard took the path away.
    const config = configWith(
      {
        dev: {
          sandbox: { profile: "bare" },
          skills: ["/pi-skills/git-commit"],
          mounts: [
            `${hostDir}/git-commit:/pi-skills/git-commit:ro`,
            `${gitDir}/hooks:${gitDir}/hooks`
          ]
        }
      },
      { bare: { image: "busybox" } }
    );

    const reportGaps = presetCapabilities(config, "dev", { homeDir: root }).mountGaps;
    const settings = buildRunSettings({
      command: "delegate",
      flags: { preset: "dev" },
      workspaceRoot: tree,
      runRoot: tree,
      config
    });
    const runGaps = sandboxMountGaps(settings.sandbox, {
      workspaceRoot: tree,
      extensions: settings.extensions,
      skills: settings.skills
    });
    // Full gap objects, reason included: value-only comparison cannot tell
    // "unmounted" from "mounted from a path that does not exist".
    assert.deepEqual(reportGaps, runGaps);
    assert.deepEqual(reportGaps, [], "an existing host source leaves no gap on either side");

    // The guard won the shared target, and the loss was announced.
    assert.ok(
      settings.sandbox.mounts.includes(`${gitDir}/hooks:${gitDir}/hooks:ro`),
      "the read-only guard keeps the container path"
    );
    assert.ok(
      settings.warnings.some(
        (warning) => warning.includes(`${gitDir}/hooks:${gitDir}/hooks`) && warning.includes("overridden")
      ),
      "the overridden mount is named in the run warnings"
    );
    // A mount whose target the guard does not claim still travels.
    assert.ok(settings.sandbox.mounts.includes(`${hostDir}/git-commit:/pi-skills/git-commit:ro`));
  } finally {
    fs.rmSync(hostDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
