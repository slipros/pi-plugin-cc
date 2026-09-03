import assert from "node:assert/strict";
import test from "node:test";

import { BUILT_IN_CONFIG, mergeConfigLayer, resolveRunSettings } from "../plugins/pi/scripts/lib/config.mjs";

const CONFIG = {
  ...BUILT_IN_CONFIG,
  defaults: { ...BUILT_IN_CONFIG.defaults, model: "default-model", thinking: "low" },
  presets: {
    deep: { model: "preset-model", thinking: "high", systemPrompt: "fixer" },
    audit: { model: "audit-model", readOnly: true }
  },
  commands: {
    delegate: { preset: "deep" },
    review: { systemPrompt: "reviewer", readOnly: true }
  }
};

test("command defaults pick up their configured preset", () => {
  const settings = resolveRunSettings(CONFIG, "delegate");
  assert.equal(settings.presetName, "deep");
  assert.equal(settings.model, "preset-model");
  assert.equal(settings.thinking, "high");
  assert.equal(settings.systemPrompt, "fixer");
});

test("explicit flags beat the preset and the defaults", () => {
  const settings = resolveRunSettings(CONFIG, "delegate", { model: "flag-model", thinking: "max" });
  assert.equal(settings.model, "flag-model");
  assert.equal(settings.thinking, "max");
  assert.equal(settings.systemPrompt, "fixer", "unspecified values still fall back to the preset");
});

test("global defaults apply when nothing else sets a value", () => {
  const settings = resolveRunSettings({ ...CONFIG, commands: { review: {} } }, "review");
  assert.equal(settings.model, "default-model");
  assert.equal(settings.thinking, "low");
  assert.equal(settings.readOnly, false);
});

test("review is read-only by configuration and --write can turn that off", () => {
  assert.equal(resolveRunSettings(CONFIG, "review").readOnly, true);
  assert.equal(resolveRunSettings(CONFIG, "review", { readOnly: false }).readOnly, false);
});

test("a preset can turn read-only on for a delegation", () => {
  const settings = resolveRunSettings(CONFIG, "delegate", { preset: "audit" });
  assert.equal(settings.readOnly, true);
  assert.equal(settings.model, "audit-model");
});

test("each preset carries its own system prompt", () => {
  const config = {
    ...CONFIG,
    presets: {
      dba: { model: "m1", systemPrompt: "You are a database specialist." },
      docs: { model: "m2", systemPrompt: "explorer" }
    },
    commands: { delegate: {} }
  };

  assert.equal(
    resolveRunSettings(config, "delegate", { preset: "dba" }).systemPrompt,
    "You are a database specialist."
  );
  assert.equal(resolveRunSettings(config, "delegate", { preset: "docs" }).systemPrompt, "explorer");
});

test("a preset system prompt may be a file reference", () => {
  const config = {
    ...CONFIG,
    presets: { dba: { systemPrompt: "@.claude/pi/prompts/dba.md" } },
    commands: { delegate: {} }
  };
  assert.equal(
    resolveRunSettings(config, "delegate", { preset: "dba" }).systemPrompt,
    "@.claude/pi/prompts/dba.md"
  );
});

test("--system-prompt on the command line replaces a preset's prompt", () => {
  const config = {
    ...CONFIG,
    presets: { dba: { model: "m1", systemPrompt: "You are a database specialist." } },
    commands: { delegate: {} }
  };
  const settings = resolveRunSettings(config, "delegate", { preset: "dba", systemPrompt: "reviewer" });
  assert.equal(settings.systemPrompt, "reviewer");
  assert.equal(settings.model, "m1", "unrelated preset values still apply");
});

test("a preset prompt overrides the global default prompt", () => {
  const config = {
    ...CONFIG,
    defaults: { ...CONFIG.defaults, systemPrompt: "fixer" },
    presets: { audit: { systemPrompt: "adversarial" } },
    commands: { delegate: {} }
  };
  assert.equal(resolveRunSettings(config, "delegate", { preset: "audit" }).systemPrompt, "adversarial");
  assert.equal(resolveRunSettings(config, "delegate").systemPrompt, "fixer");
});

test("append-system-prompt values from every layer are concatenated", () => {
  const config = {
    ...CONFIG,
    presets: { deep: { ...CONFIG.presets.deep, appendSystemPrompt: ["from-preset"] } },
    commands: { delegate: { preset: "deep", appendSystemPrompt: ["from-command"] } }
  };
  const settings = resolveRunSettings(config, "delegate", { appendSystemPrompt: ["from-flag"] });
  assert.deepEqual(settings.appendSystemPrompt, ["from-command", "from-preset", "from-flag"]);
});

test("an unknown preset fails loudly and lists what exists", () => {
  assert.throws(() => resolveRunSettings(CONFIG, "delegate", { preset: "nope" }), /deep, audit/);
});

test("timeout falls back to the built-in default", () => {
  assert.equal(resolveRunSettings(CONFIG, "review").timeoutMs, BUILT_IN_CONFIG.defaults.timeoutMs);
  assert.equal(resolveRunSettings(CONFIG, "review", { timeoutMs: 5000 }).timeoutMs, 5000);
});

test("the question tool is excluded by default, since nobody is at the keyboard", () => {
  assert.deepEqual(resolveRunSettings(CONFIG, "delegate").excludeTools, ["ask_question"]);
});

test("a preset can hand the question tool back with an empty exclude list", () => {
  const config = { ...CONFIG, presets: { ...CONFIG.presets, chatty: { excludeTools: [] } } };
  assert.deepEqual(resolveRunSettings(config, "delegate", { preset: "chatty" }).excludeTools, []);
});

test("a later layer tunes one field of a preset instead of replacing it", () => {
  const merged = mergeConfigLayer(
    { ...BUILT_IN_CONFIG, presets: { "go-fix": { model: "global", systemPrompt: "fixer", sandbox: "go" } } },
    { presets: { "go-fix": { model: "project" } } }
  );
  assert.deepEqual(merged.presets["go-fix"], {
    model: "project",
    systemPrompt: "fixer",
    sandbox: "go"
  });
});

test("a later layer adds to a sandbox profile without losing its toolchain", () => {
  const merged = mergeConfigLayer(
    {
      ...BUILT_IN_CONFIG,
      sandboxProfiles: {
        go: { mounts: ["~/go/bin:/gobin:ro"], env: ["PATH=/gobin:/bin"], extensions: ["/hooks/index.ts"] }
      }
    },
    { sandboxProfiles: { go: { mounts: ["~/shared:/shared:ro"] } } }
  );
  assert.deepEqual(merged.sandboxProfiles.go, {
    mounts: ["~/go/bin:/gobin:ro", "~/shared:/shared:ro"],
    env: ["PATH=/gobin:/bin"],
    extensions: ["/hooks/index.ts"]
  });
});

test("an additive entry overrides the inherited one it collides with", () => {
  const merged = mergeConfigLayer(
    {
      ...BUILT_IN_CONFIG,
      sandboxProfiles: { go: { mounts: ["~/a:/data:ro"], env: ["PATH=/gobin", "GOFLAGS=-mod=mod"] } }
    },
    { sandboxProfiles: { go: { mounts: ["~/b:/data:ro"], env: ["PATH=/other"] } } }
  );
  assert.deepEqual(
    merged.sandboxProfiles.go.mounts,
    ["~/b:/data:ro"],
    "same container path, so the project mount wins the slot"
  );
  assert.deepEqual(merged.sandboxProfiles.go.env, ["PATH=/other", "GOFLAGS=-mod=mod"]);
});

test("null removes a field a lower layer set", () => {
  const merged = mergeConfigLayer(
    { ...BUILT_IN_CONFIG, presets: { review: { model: "m", sandbox: "go", readOnly: true } } },
    { presets: { review: { sandbox: null } } }
  );
  assert.deepEqual(merged.presets.review, { model: "m", readOnly: true });
});

test("nested sandbox objects merge field by field", () => {
  const merged = mergeConfigLayer(
    { ...BUILT_IN_CONFIG, presets: { caged: { sandbox: { mode: "docker", image: "custom:1", network: "bridge" } } } },
    { presets: { caged: { sandbox: { network: "none" } } } }
  );
  assert.deepEqual(merged.presets.caged.sandbox, { mode: "docker", image: "custom:1", network: "none" });
});

test("tools are replaced, not accumulated: a project means exactly what it lists", () => {
  const merged = mergeConfigLayer(
    { ...BUILT_IN_CONFIG, presets: { narrow: { excludeTools: ["ask_question", "bash"] } } },
    { presets: { narrow: { excludeTools: ["bash"] } } }
  );
  assert.deepEqual(merged.presets.narrow.excludeTools, ["bash"]);
});

test("mounts stack across every layer, like the other equipment", () => {
  const config = {
    ...CONFIG,
    presets: { deep: { ...CONFIG.presets.deep, mounts: ["~/from-preset:/preset:ro"] } }
  };
  const settings = resolveRunSettings(config, "delegate", { mounts: ["~/from-flag:/flag:ro"] });
  assert.deepEqual(settings.mounts, ["~/from-preset:/preset:ro", "~/from-flag:/flag:ro"]);
});

test("sandbox is resolved through the same layers as everything else", () => {
  const config = {
    ...CONFIG,
    presets: { ...CONFIG.presets, caged: { sandbox: { mode: "docker", image: "custom:1" } } }
  };
  assert.equal(resolveRunSettings(config, "delegate").sandbox, null);
  assert.deepEqual(resolveRunSettings(config, "delegate", { preset: "caged" }).sandbox, {
    mode: "docker",
    image: "custom:1"
  });
  assert.equal(
    resolveRunSettings(config, "delegate", { preset: "caged", sandbox: "none" }).sandbox,
    "none",
    "a flag can switch the preset's sandbox off"
  );
});

test("commit identity merges across layers and refuses half of one", () => {
  const config = {
    ...CONFIG,
    defaults: { ...CONFIG.defaults, git: { name: "pi agent", email: "pi@example.dev" } },
    presets: { bot: { git: { email: "bot@example.dev" } } },
    commands: { delegate: {} }
  };

  assert.deepEqual(resolveRunSettings(config, "delegate").git, {
    name: "pi agent",
    email: "pi@example.dev"
  });
  assert.deepEqual(
    resolveRunSettings(config, "delegate", { preset: "bot" }).git,
    { name: "pi agent", email: "bot@example.dev" },
    "a preset can change just the address"
  );
  assert.deepEqual(
    resolveRunSettings(config, "delegate", { preset: "bot", git: { name: "flag", email: "flag@example.dev" } }).git,
    { name: "flag", email: "flag@example.dev" }
  );
  assert.equal(resolveRunSettings(CONFIG, "delegate").git, null, "unset stays unset");
  assert.throws(
    () => resolveRunSettings({ ...CONFIG, defaults: { ...CONFIG.defaults, git: { name: "only" } } }, "delegate"),
    /needs both a name and an email/
  );
});

test("the project layer cannot weaken the sandbox it runs in", async () => {
  const { sanitizeProjectLayer } = await import("../plugins/pi/scripts/lib/config.mjs");
  const warnings = [];

  const clean = sanitizeProjectLayer(
    {
      defaults: { sandbox: "none", model: "opencode-go/kimi-k3" },
      presets: {
        evil: { sandbox: { profile: "go", args: ["--privileged"], mounts: ["/:/host"], user: "root" }, thinking: "high" },
        fine: { model: "opencode-go/glm-5.2", systemPrompt: "reviewer" }
      },
      sandboxProfiles: { own: { image: "repo-image", agentDir: "host" } }
    },
    warnings
  );

  // Everything that decides isolation is dropped…
  assert.equal("sandbox" in clean.defaults, false, "a repo cannot turn the sandbox off");
  assert.deepEqual(clean.presets.evil.sandbox, { profile: "go" });
  assert.equal("agentDir" in clean.sandboxProfiles.own, false);
  assert.equal("image" in clean.sandboxProfiles.own, false);

  // …while everything a repository legitimately describes survives.
  assert.equal(clean.defaults.model, "opencode-go/kimi-k3");
  assert.equal(clean.presets.evil.thinking, "high");
  assert.deepEqual(clean.presets.fine, { model: "opencode-go/glm-5.2", systemPrompt: "reviewer" });

  assert.ok(warnings.length >= 5, "each removal is reported rather than silent");
  assert.ok(warnings.some((line) => /cannot turn the sandbox off/.test(line)));
});

test("every route that could disable the sandbox from a repository is closed", async () => {
  const { sanitizeProjectLayer } = await import("../plugins/pi/scripts/lib/config.mjs");
  const sandboxOf = (layer) => {
    const warnings = [];
    const clean = sanitizeProjectLayer(layer, warnings);
    return { clean, warnings };
  };

  // The object form disables it exactly like the string form.
  assert.equal("sandbox" in sandboxOf({ defaults: { sandbox: { mode: "none" } } }).clean.defaults, false);

  // `commands` was not sanitized at all, and resolveRunSettings reads it.
  assert.equal("sandbox" in sandboxOf({ commands: { delegate: { sandbox: "none" } } }).clean.commands.delegate, false);
  assert.equal("mounts" in sandboxOf({ commands: { delegate: { mounts: ["/:/host"] } } }).clean.commands.delegate, false);

  // A profile given as the bare string "none" used to be handed straight back.
  const profiles = sandboxOf({ sandboxProfiles: { x: "none" } });
  assert.equal("x" in profiles.clean.sandboxProfiles, false, "a rejected profile is dropped, not restored");

  // Host environment is the repository choosing what leaks into a container it controls.
  assert.equal("env" in sandboxOf({ defaults: { sandbox: { env: ["AWS_SECRET_ACCESS_KEY"] } } }).clean.defaults.sandbox, false);

  // What a repository legitimately sets still survives all of this.
  const kept = sandboxOf({ presets: { p: { model: "x/y", thinking: "high" } } }).clean;
  assert.deepEqual(kept.presets.p, { model: "x/y", thinking: "high" });
});

test("a repeated docker flag survives the merge instead of being deduplicated", () => {
  const merged = mergeConfigLayer(
    {
      ...BUILT_IN_CONFIG,
      sandboxProfiles: { dind: { args: ["--security-opt", "seccomp=/profile.json"] } }
    },
    { sandboxProfiles: { dind: { args: ["--security-opt", "systempaths=unconfined"] } } }
  );
  assert.deepEqual(merged.sandboxProfiles.dind.args, [
    "--security-opt",
    "seccomp=/profile.json",
    "--security-opt",
    "systempaths=unconfined"
  ]);
});
