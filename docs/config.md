# Configuration: layers, presets, project overrides

How layers merge, what a project is allowed to override, and how to tune a global preset for
one repository. The skill keeps only what is needed at launch time.

Optional. `~/.claude/pi/config.json` holds personal defaults, `<repo>/.claude/pi/config.json` project ones — the project file wins, and command-line flags win over both.

```json
{
  "defaults": { "model": "opencode-go/glm-5.2", "thinking": "medium", "timeoutMs": 1800000 },
  "presets": {
    "fast":  { "description": "narrow questions, no reasoning", "model": "opencode-go/deepseek-v4-flash", "thinking": "off" },
    "audit": { "description": "adversarial read of finished work, changes nothing", "model": "opencode-go/kimi-k3", "systemPrompt": "adversarial", "readOnly": true },
    "dba":   {
      "model": "opencode-go/kimi-k3",
      "systemPrompt": "@.claude/pi/prompts/dba.md",
      "appendSystemPrompt": ["Answer in Russian."],
      "tools": "read,grep,find,ls,bash"
    }
  },
  "commands": { "delegate": { "preset": "dba" }, "review": { "preset": "audit" } }
}
```

**A preset is a whole agent, not just a model.** Give it a `description` — one line saying what it is for: `presets` prints it next to the profile, and that is how an agent is chosen without opening the system prompt behind it (reading a prompt to make the choice costs more than the choice). Beyond the description, any run field can live in a preset: `model`, `provider`, `thinking`, `systemPrompt`, `appendSystemPrompt`, `tools`, `excludeTools`, `extensions`, `skills`, `sandbox`, `mounts`, `git`, `readOnly`, `noTools`, `noBuiltinTools`, `noExtensions`, `noSkills`, `timeoutMs`, `engine`, `budget`. Define it once, then run `--preset dba`.

Two fields deserve naming separately, because decisions live in them rather than details:

- **`timeoutMs`** — hard limit of a run in milliseconds (1,800,000 — half an hour — by default). It stops both pi and the container, and it is also the ceiling for auto-continuation after a truncated answer: the clock covers the whole run rather than restarting per continuation.
- **`sandbox`** — `"docker"`, `"none"`, the name of a profile from `sandboxProfiles`, or an object. In object form `{"profile": "go", …}` the profile is the base and the remaining fields amend it: equipment (`mounts`, `env`, `args`, `extensions`, `skills`) adds to the profile's, decisions (`image`, `network`, `memory`, `cpus`) replace it. A profile may name another profile; a cycle is an error, not a hang.

```json
"presets": {
  "go-fix": {
    "description": "Go edits with the gates running inside the container",
    "sandbox": { "profile": "go", "mounts": ["~/proj/protos:/protos:ro"] },
    "timeoutMs": 3600000,
    "budget": { "maxCostUsd": 2, "maxTurns": 40 }
  }
}
```

Values resolve layer by layer, highest first: **command-line flags → preset → per-command defaults → global defaults.** Commit identity is the one exception: your gitconfig sits between the flags and the preset (see [git-identity.md](git-identity.md)). The system prompt is chosen as a unit, so `--system-prompt` replaces a preset's prompt outright; `appendSystemPrompt`, `extensions`, `skills` and `mounts` stack across layers instead.

## Budgets: stopping a run that costs too much

Time used to be the only ceiling a run had, and it is a poor proxy for the thing worth bounding — a fast model can spend a dollar in two minutes, a cheap one can idle for an hour for free.

```json
"presets": {
  "explorer": { "model": "opencode-go/kimi-k3", "budget": { "maxCostUsd": 2, "maxTurns": 40 } }
}
```

```bash
/pi:delegate --max-cost 0.5 --max-tokens 200000 --max-turns 20   refactor the parser
```

Each ceiling applies on its own, and the flags add to what a preset already set rather than replacing it. The numbers come from the usage the run already reports, checked after every model answer: on the rpc engine the run is asked to `abort`, so it wraps up and keeps what it has produced; on `--engine json` there is no control channel and the process is stopped the way a timeout stops it.

Enforcement is "stop after", never "predict before" — the size of a message is known only once it is paid for, so a budget can be crossed by the last message and no earlier. Set them as ceilings you do not want passed, not as exact allowances. A run stopped this way ends as a failure with `Stopped by the run budget: …` among its problems.

## Tuning a global preset for one project

The project file **merges into** your personal one field by field, so a repository names only what it changes:

```json
{
  "presets": {
    "go-review": {
      "model": "opencode-go/kimi-k3",
      "appendSystemPrompt": ["This service uses sqlc; migrations are generated, do not hand-edit them."]
    }
  },
  "sandboxProfiles": { "go": { "mounts": ["~/proj/protos:/protos:ro"] } }
}
```

The system prompt, `readOnly`, the sandbox and the whole toolchain come from the global definitions untouched. Three rules cover what "merges" means:

- **Equipment accumulates** — `appendSystemPrompt`, `extensions`, `skills`, `mounts`, `env`, `args`. An entry that collides with an inherited one takes its place: mounts are matched by container path, env by variable name, so `"mounts": ["~/other:/gobin:ro"]` redirects `/gobin` instead of mounting it twice.
- **Decisions are replaced** — `model`, `thinking`, `systemPrompt`, `sandbox`, `readOnly`, `tools`, `excludeTools`, `timeoutMs`. A project that lists `excludeTools` means exactly those.
- **`null` removes** — `"sandbox": null` drops a sandbox the global preset asked for. It is the way back out of a merge.

Nested objects merge the same way, so `"sandbox": {"network": "none"}` keeps the image, mounts and everything else the layer below set.

**A project system prompt**, from one-off to permanent: `--system-prompt @./.claude/pi/prompts/try-a.md` for a single run; `<project>/.claude/pi/prompts/<name>.md` shadows the global file of that name for every preset; `<project>/.claude/pi/APPEND_SYSTEM.md` is appended to whatever prompt was chosen, always.

What a workspace outside `trustedProjects` may **not** override — mounts, env, images, the agent directory — is in [sandbox.md](sandbox.md).

## Continuation cache: `cacheTtl`

Continuing a session (`continue`, `delegate --session`) replays its whole history to the provider. While the prompt is still in the provider's cache that is nearly free; once the cache has expired the very same tokens are billed again at the full input rate — and the longer the session, the more expensive "just finish it off" an hour later becomes.

Providers do not report cache lifetime in any machine-readable way and do not agree with each other, so the window is configured:

```json
"cacheTtl": { "default": "40m", "providers": { "anthropic": "5m" } }
```

Values are `40m`, `90s`, `2h`, `500ms`; a bare number reads as minutes. The provider comes from the run record (the recipe's `provider`, else the `provider/` half of the model id), and a provider entry outranks `default`. Session age is measured from the run's last activity (`completedAt`), not from the session file: a sandboxed session lives in the sandbox volume and has no file on the host at all. Older than the TTL and the continuation is refused with a non-zero exit; `--stale-ok` pays for the replay on purpose, `--fresh` keeps the agent and drops the history. What can be continued, and how warm its cache still is, is `sessions`.

The session file itself never expires: the TTL here is about money, not about keeping work.

## Model output ceiling: `~/.pi/agent/models.json`

That file is pi's own provider table rather than plugin config — but the answer ceiling can only be set there, and inside the sandbox the plugin is the only thing that carries it into the request.

```json
{
  "providers": {
    "opencode-go": {
      "compat": { "maxTokensField": "max_tokens" },
      "models": [ { "id": "kimi-k3", "samplingParams": { "max_tokens": 32000 } } ]
    }
  }
}
```

**`samplingParams` on a model.** pi validates the field and folds it into the model object, but what reaches the provider is the agent config, not the model — and nobody carries `samplingParams` across, so the request leaves without a ceiling. Behind the provider mask the credential proxy fixes this: before forwarding it adds the `samplingParams` keys that are missing from the body (anything pi set itself is never touched). Both spellings of the field are handled: `max_tokens` is not added when pi already sent `max_completion_tokens`, and the other way round — an API expecting the new name rejects the old one.

The cost of no ceiling is not theoretical: the server applies its own maximum, and a model that has gone into a loop generates up to it. In one epic's journal that was 19 such answers — under one percent of requests, 46% of all output tokens. Worse than the tokens is the shape of the failure: a truncated answer ends mid tool call, the call is dropped, and the text half becomes the final answer (see auto-continuation in the skill).

**`compat.maxTokensField`.** Which field the provider takes the ceiling in. pi derives it from the provider name and the address, and the mask replaces both: behind it every provider looks like stock OpenAI and gets `max_completion_tokens`. A compatible endpoint that only knows `max_tokens` silently ignores that field — no ceiling at all (measured: a request with a limit of 64 returned 15,518 tokens; the same limit in `max_tokens` stopped exactly at 64). The proxy restores the decision made on the host, using the name and URL list copied from pi's own `detectCompat` plus `ollama.com` and a local Ollama by address and port.

An explicit user `compat` always outranks the detection — the proxy fills a gap, it does not argue with a setting. The field is read from both provider and model: `compat` on a provider covers all of its models, including ones not listed in `models[]`.

**Boundaries.** pi reads `compat` itself; the proxy only restores it behind the mask. `samplingParams`, on the other hand, never reaches the request without the proxy — so a declared ceiling applies to **sandboxed** runs only: the proxy is raised there and nowhere else (and not at all when a profile turned it off with `"proxyCredentials": false`).

## Environment variables

Read from the companion process on the host — they are not passed into the container, and there are no preset fields for them.

- **`PI_TRUNCATION_RETRIES`** — how many times in a row a run continues itself after being truncated at the output ceiling. Default 10; `0` disables continuation entirely; a non-numeric or negative value falls back to the default. The limit is on **consecutive** truncations: an answer that finishes resets the counter.
- **`PI_LOOP_NUDGE`** — intervention in a run going round in its own reasoning. On by default; exactly `0` turns it off (any other value leaves it on). The detector counts a turn as looping when it goes **entirely** into reasoning — no text, no tool call — and at most two messages are sent per run. The thresholds (6,000 characters of reasoning, 3 such turns out of the last 10) are hard-coded and not derived from measurement: a deliberately conservative guess. The journal counter (`nudges sent`) counts the sending: the message is written into the session, but whether the agent picked it up — changed behaviour rather than ignoring it or receiving it too late — is not tracked at all, because the RPC event stream carries no reliable sign of it.
- **`PI_PLUGIN_BINARY`** — what to run pi with (default: `pi` from `PATH`).
- **`PI_PLUGIN_DB`** — the run journal file instead of `$XDG_DATA_HOME/pi-plugin/jobs.db` (without `XDG_DATA_HOME`: `~/.local/share/pi-plugin/jobs.db`).
- **`PI_PROXY_BIND`**, **`PI_PROXY_SETTLE_MS`** — bind address and settle delay of the host-side proxies, see [git-proxy.md](git-proxy.md).

When something does not work, start with `setup`: it shows whether the pi binary was found, whether any models are reachable, which configs were picked up and where job state lives.
