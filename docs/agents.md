# Agents: models, prompts, tools, presets

Who does the work, and what they are allowed to do. The working commands live in the skill
(`skills/pi/SKILL.md`); this file is the reasoning behind the flags.

## Choosing a model

Every run command takes the same selection flags:

```bash
/pi:delegate --model opencode-go/kimi-k3 --thinking high   fix the failing auth test
/pi:delegate --provider anthropic --model claude-sonnet-5  refactor the retry logic
/pi:review   --model opencode-go/glm-5.2 --base main
```

- `--model` accepts `provider/id`, a bare id, or a substring that matches exactly one catalogue entry (`kimi` → `opencode-go/kimi-k3`). The local catalogue is checked first and a name matching nothing or several things is a warning, not a refusal — the name is passed to pi either way, so a model the catalogue does not know still runs.
- `--thinking off|minimal|low|medium|high|xhigh|max` sets reasoning effort.
- `--preset <name>` applies a named bundle from your config.
- With no flags at all, pi uses its own configured default model.

`/pi:models [search]` prints the catalogue: context window, output ceiling, thinking and image support.

## Choosing an agent: `presets`

`/pi:presets` answers a different question than the catalogue — not "what can answer me" but "who should do the work" — and answers it without walking several hundred catalogue entries.

```
- `go-developer` — Go task end to end: code, unit tests, gates, commit · model `zai/glm-5.3-flash` (ctx 1M · out 131.1K), thinking `low`, prompt `developer`, sandbox `agent`, vision `skill`, tags `go, dev`
```

Three fields on that line are computed rather than copied from the config:

- **`ctx` / `out`** — the model's context window and **output ceiling**. The ceiling belongs next to the model because a run that hits it ends mid-sentence while the job still closes as `completed`; picking between two presets is often exactly this number. The catalogue is walked only for the human report — `presets --json` stays instant, because hooks call it on every rejected run.
- **`vision`** — whether the preset can actually look at an image: a mounted vision skill plus a shell to run it. A skill without a shell behind it is not a capability.
- **`⚠ NOT MOUNTED`** — equipment the preset declares that the container will not have. See below.

## Equipment that does not arrive is a refusal, not a note

A preset can name skills and extensions (`"skills": ["/pi-skills/git-commit"]`). Those paths exist inside the container only if some mount puts them there, and a missing one is invisible in the result: the agent works without the rules that skill carries, and the run looks entirely normal.

So `delegate` **refuses to start** when a run declares equipment the sandbox will not carry, naming the mount that would fix it:

```
Sandbox will not carry equipment this run declares, so the agent would work without it:
- skill `/pi-skills/git-commit` — mount it: --mount <host path>:/pi-skills/git-commit:ro
Add the mount to the profile (`sandboxProfiles.<name>.mounts`) or the preset, or drop the
entry with --no-skills / --no-extensions.
```

Two shapes of the same failure are caught:

1. **Nothing mounts the path** — no mount covers `/pi-skills/git-commit`.
2. **The mount's source does not exist** — docker would create an empty directory, and the skill is just as absent. The quieter half, and the one that survives a `mv` on the host.

`npm:` and `git:` sources are resolved inside the container and are never gaps.

## Choosing a system prompt

One flag, three kinds of value:

```bash
/pi:delegate --system-prompt explorer                      how does session resumption work here?
/pi:delegate --system-prompt @.claude/pi/prompts/dba.md    explain this query plan
/pi:delegate --system-prompt "Answer in one sentence"      what does this module do?
```

- **A name** — looked up in `.claude/pi/prompts/<name>.md`, then `~/.claude/pi/prompts/<name>.md`, then the prompts shipped with the plugin. A project file shadows a built-in of the same name.
- **`@path`** (or any path ending in `.md`/`.txt`) — a file.
- **Anything else** — the prompt text itself.

Prompts that ship with the plugin:

| Name | For |
| --- | --- |
| `reviewer` | Structured code review: verdict, findings by severity, notes. |
| `adversarial` | Challenges the design, not the syntax: assumptions, failure modes, rollback. |
| `fixer` | Makes a change: smallest correct edit, verifies it, reports what it could not verify. |
| `explorer` | Investigates and explains existing code with `file:line` citations. |

With nothing set, `.claude/pi/SYSTEM.md` in the repository is used, and failing that pi keeps its own prompt. `--append-system-prompt <text|@file>` (repeatable) and `.claude/pi/APPEND_SYSTEM.md` add to whichever base was chosen instead of replacing it.

The prompt is chosen **as a unit**: `--system-prompt` on the command line replaces a preset's prompt outright, while `appendSystemPrompt` stacks across every layer.

## Choosing the agent's tools

Built-in pi tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

```bash
/pi:delegate --read-only            investigate why the build fails   # read, grep, find, ls + LSP navigation
/pi:delegate --tools read,grep,bash reproduce the bug, change nothing
/pi:delegate --exclude-tools bash   fix the types, do not run commands
/pi:delegate --no-tools             think out loud about the architecture
/pi:delegate --write                override a preset's read-only setting
```

`--read-only` and `--write` are the top layer: they outrank both the preset and the command's defaults, which is why `review --write` lifts the read-only setting review is configured with. `--stdin` appends piped input to the prompt, for handing over a brief without quoting it.

`--read-only` keeps the LSP navigation tools — `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_more` — since finding who calls a symbol changes nothing and is exactly what a review needs. `lsp_diagnostics` is left out: gates decide whether code is broken. Note that `--tools` is an allow list, so spelling one out drops everything you did not name, LSP included.

Anything beyond the built-ins comes from pi extensions — including MCP servers, via the `pi-mcp-adapter` extension that reads your project's `.mcp.json`:

```bash
/pi:delegate --extension npm:pi-mcp-adapter   query the database over MCP
/pi:delegate --extension ./tools/my-ext.ts --skill ./skills/db  …
/pi:delegate --no-extensions                  clean run, no third-party tools
```

pi itself has **no sandbox**: by default `bash`, `edit` and `write` run with your permissions. `/pi:review` is read-only by configuration and `/pi:delegate` allows writes; either can be flipped for one run. A delegated run that edited files leaves those edits in your working tree — review them with `git diff` before committing, the plugin never commits anything. For real isolation see [sandbox.md](sandbox.md).

One default is set for you: `excludeTools` is `["ask_question"]`, because a delegated run has nobody at the keyboard and a question tool would burn a turn waiting for an answer that never comes. Set `"excludeTools": []` in any layer to hand it back.
