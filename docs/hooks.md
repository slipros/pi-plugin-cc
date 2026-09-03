# Hooks: the gates a run works under

A system prompt asks; a hook decides. Everything an agent must not do regardless of how the task was worded — commit around the repository's own git hooks, wipe the module cache to "fix" a build, grep the whole home directory, paste a token into a log — lives in [`plugins/pi/extensions/hooks`](../plugins/pi/extensions/hooks) instead of in prose. pi calls them extensions; this one bundles fourteen of them behind a single entry point, so a run turns them on with one path rather than a list.

The sources are in Russian, like `skills/pi/SKILL.md`: they are read by the agent that runs under them.

## Turning it on

pi resolves an extension by path, so a symlink into your pi agent directory is the whole install:

```bash
ln -s "$PWD/plugins/pi/extensions/hooks" ~/.pi/agent/extensions/hooks
```

From there a run picks it up with `--extension`, or a preset does it once:

```jsonc
"presets": {
  "go-developer": {
    "extensions": ["~/.pi/agent/extensions/hooks/index.ts"]
  }
}
```

Inside a sandbox the host directory has to be mounted first — the container has its own agent directory, and equipment that nothing mounts silently stops gating. A profile that mounts `~/.pi/agent/extensions` and names hooks by container path is in [sandbox.md](sandbox.md); a preset whose equipment will not arrive refuses to start rather than running ungated.

## What is enabled, and by whom

Composition is one decision made outside the files, not a personal environment variable per hook:

| Variable | Effect |
| --- | --- |
| `PI_HOOKS=a,b,c` | Exactly these, everything else off |
| `PI_HOOKS_ON=a,b` | Added to the default set — the only way to enable an `optIn` or `profileOnly` hook |
| `PI_HOOKS_OFF=a,b` | Removed, on top of either of the above |
| `PI_HOOKS_DISPLAY=1` | Print the resulting set to stderr |

Unset `PI_HOOKS` means the default set: everything except two kinds of hook that have to be asked for.

- **`optIn`** — useful only in a conversation with a human. `memory-recall` is the one: an interactive session asks "what did we decide last time", an autonomous run was handed that in its brief and pays tokens plus a round trip to MuninnDB for a table of contents it will not read. So an `optIn` hook switches itself on when both stdin and stdout are a TTY, and stays quiet headless.
- **`profileOnly`** — meaningful only to the profile that declares it. `test-only-guard` is the one: it refuses `git add`/`git commit` of anything that is not a test, which is the boundary of a QA profile and not a general rule. A TTY does **not** enable it — talking to a human is no reason to forbid committing production code.

`profileOnly` exists because of a specific failure. `PI_HOOKS` lives in `preset.sandbox.env`, so a host run (`--sandbox none`), a run with no preset, and any `continue` from one arrived with `PI_HOOKS` unset — and the old default of "enable everything" made each of them a QA run. The agent wrote production code, `git add` and `git commit` were rejected with a message it treated as advice, and finished work stayed uncommitted in the working tree. `tests/selection.test.mjs` stands on that flag.

A misspelled name in any of the variables is reported on stderr and ignored — a typo must not silently disable a protective hook.

## The set

| Hook | Event | What it does |
| --- | --- | --- |
| `git-commit-guard` | PreToolUse Bash | Blocks git commands that bypass the repository's hooks or drag in noise: `--no-verify`, `git add -A/.`, `git commit -a`, `Signed-off-by`/`Co-Authored-By` trailers. An explicit signature (`-S`) marks a commit made through the `git-commit` skill; `--no-gpg-sign` is refused |
| `custom-gcl-precommit` | PreToolUse Bash | Runs the linter over the commit's own diff and blocks on violations in its lines. Takes the repository's rule set when it has one — a gate that says something different from `make lint` returns the work at the supervisor instead |
| `protect-secrets` | PreToolUse Bash | Refuses commands that would print or copy credentials |
| `git-stash-guard` | PreToolUse Bash | Refuses `git stash` — work parked there is work nobody finds |
| `go-cache-guard` | PreToolUse Bash | Refuses wiping the Go module cache |
| `grep-scope-guard` | PreToolUse Bash | Refuses recursive search over the whole `$HOME` |
| `protect-pi-hooks` | PreToolUse Bash/Write/Edit | Refuses edits to the agent's own rigging (`~/.pi`) and launching pi with the hooks removed |
| `sql-semicolon-guard` | PreToolUse Write/Edit | Catches a `;` left inside an SQL comment |
| `goimports-on-edit` | PostToolUse Write/Edit | Formats Go after an edit |
| `output-hygiene` | PostToolUse Bash | Reminds the agent to filter command output instead of pasting it whole |
| `lsp-diagnostics-nudge` | PostToolUse Write/Edit | Reminds it to run `lsp_diagnostics` on what it just changed |
| `complexity-nudge` | PostToolUse Write/Edit | Reports complexity the edit itself introduced or worsened — untouched legacy stays quiet |
| `test-only-guard` (`profileOnly`) | PreToolUse Bash, PostToolUse | QA boundary: only tests reach the commit. The gate stands on the commit, not on the edit, so a mutation probe — break production code, watch the test go red, revert — is still possible |
| `memory-recall` (`optIn`) | before_agent_start | Puts the MuninnDB table of contents into the system prompt |

Individual hooks keep their own variables for thresholds and paths — see the header of each file. A gate switched off through one of them says so on stderr: a gate removed without a trace is indistinguishable from a rule that was followed.

## Accepting a run: `pi-accept.sh`

[`plugins/pi/scripts/pi-accept.sh`](../plugins/pi/scripts/pi-accept.sh) is the other half — what a supervisor runs after a delegated task reports success.

```bash
pi-accept.sh <repo> [--base <sha>] [--report <path>] [--allow <path>]... [--fix] [--qa]
```

It answers three questions the job status cannot: did a commit appear on top of `--base` at all (a background engine's "done" is compatible with work that was never committed), does the `--report` file exist and hold something, and is the tree clean afterwards. A sandbox leaves behind files no one intended to change — lock files a nested toolchain rewrote, platform artifacts a container built. Unnoticed, they ride along in the next task's commit, where a reviewer spends their time on a diff nobody can explain. `go.sum` touched by the sandbox toolchain is cleaned up on its own; `--allow` names a file whose change was legitimate for *this* task, and it is reported rather than cleaned.

Two behaviours are worth knowing before using `--fix`:

- **No commit on top of `--base` means the working tree is the only output of the run.** It is reported as unsaved work, `git checkout --` is not offered, and `--fix` cleans nothing. An earlier version called it a tail and offered to discard it — a mutation probe on that version confirmed it destroyed finished work.
- **`--qa` accepts a QA run**, where "defect found" is success. Such an agent finishes without a commit by construction, leaving a red test in the tree as the reproduction — that *is* the result. Test paths are not a tail there and `--fix` does not touch them; production paths still are, since QA does not write them.

Platform artifacts are recognised by platform, not by name: an ELF `.venv/bin/python`, ELF `*.node` bindings, a `go.work` pointing at `/workspace`. A host-built frontend `node_modules` is not an artifact.

Exit codes: `0` — clean (or the noise was cleaned by `--fix`), `1` — there is a tail, `2` — bad invocation.

## Tests

The hook tests run with the rest of the suite:

```bash
npm test
node plugins/pi/extensions/hooks/tests/negative.test.mjs   # or one file at a time
```

They cover selection (`selection.test.mjs`), refusals and their false positives (`negative.test.mjs`, `falsepos.test.mjs`), the QA gate end to end (`test-only-guard.integration.test.mjs`) and that everything still loads together (`smoke.test.mjs`).
