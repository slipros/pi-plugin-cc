---
description: Run a read-only pi code review of the current git changes
argument-hint: '[--background|--wait] [--job <id>] [--base <ref>] [--scope auto|working-tree|branch] [--preset <name>] [--system-prompt reviewer|adversarial] [--cwd <path>] [focus text]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), Read, Glob, Grep, AskUserQuestion
---

Run a pi code review of the current work.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:

- This command is review-only. Do not fix anything, do not apply patches, do not offer to make the changes in this turn.
- Your only job is to run the review and return pi's output verbatim.

Review target:

- Default scope is `auto`: the working tree when it is dirty, otherwise the branch diff against the detected default branch.
- `--base <ref>` reviews `<ref>...HEAD`. `--scope working-tree|branch` forces a scope.
- `--job <id>` reviews exactly what another pi run changed, measured against the commit that run started from — the natural next step after delegating work. It also picks up that run's working directory, so a review of a `--cwd` or worktree run looks in the right tree.
- Anything that is not a flag is extra focus text handed to the reviewer.

Model and prompt:

- The review runs read-only — `read`, `grep`, `find`, `ls` plus LSP navigation — with the `reviewer` system prompt. `--system-prompt adversarial` switches to the design-challenging review. Read-only here is a default, not a guarantee: `--write` overrides it, so do not pass that flag unless the user asked for a review that also edits.
- `--preset`, `--model`, `--provider` and `--thinking` select the profile and model, exactly as in `/pi:delegate`.

Execution mode rules:

- `--wait` runs in the foreground, `--background` runs as a Claude background task; never ask when one of them is present.
- Otherwise estimate the size first: `git status --short --untracked-files=all`, plus `git diff --shortstat` and `git diff --shortstat --cached` for a working-tree review, or `git diff --shortstat <base>...HEAD` for a branch review.
  - Recommend waiting only for a clearly tiny change (roughly 1-2 files).
  - Recommend background in every other case, including when the size is unclear.
  - Treat untracked files as reviewable work even when the diff stat is empty.
- Ask once with `AskUserQuestion`: `Run in background` and `Wait for results`, recommended option first with `(Recommended)` in its label.

Foreground flow:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" review "$ARGUMENTS"
```

Return the stdout verbatim, with no commentary before or after it.

Background flow:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" review --background "$ARGUMENTS"`,
  description: "pi code review",
  run_in_background: true
})
```

Then tell the user the review started and to check `/pi:status`, then `/pi:result`.
