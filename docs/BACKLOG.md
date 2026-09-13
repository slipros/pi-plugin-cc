# Backlog

Known defects and gaps without a fix yet. An entry leaves this file with the commit that closes it.

## Runs and continuation

- **`continue` of a developer run is refused by the QA commit gate.** Continued `go-developer` / `rust-developer` runs (3 of 3) got "only tests go into the commit" from `test-only-guard`, even with an explicit `--preset` and every `--mount`, while the completion event showed the developer preset. The developer presets do not enable that hook, so the gate comes from somewhere else. Hypotheses: the continued pi session carries extension state or the system prompt of a QA run from the same session; `continue <session>` resolves a QA job as the parent; state kept in the sandbox volume. Until fixed, a fix round that writes production code goes through `rerun <run-id> --append`, not `continue`.
- **A lost brief once arrived as its header only.** The brief file existed and read fine, yet the agent received only the first line; not reproduced in 4 attempts. Since the loud failure on a lost transfer, the next occurrence should carry its cause in the error text — capture it.
- **`pia events --follow` under a long-lived monitor exited with code 144** in the middle of work. Cause unknown.

## Acceptance

- **`pi-accept.sh` does not validate the STATUS block.** A run whose work was done but whose final answer came out garbled (after a connection reset mid-stream) passes every mechanical check; only reading the answer catches it. Candidate: validate the block's shape and refuse acceptance (or ask for a retry) when it is broken.

## Presets and sandbox

- **`presets` checks mounted skills by their host path.** A skill that is a symlink to an absolute host path looks mounted, but inside the container the link dangles (seen on `tech-reviewer` until its skills were mounted explicitly). The check should resolve the link the way the container will — a target outside every mount is a skill that will not arrive.
- **The hooks extension drifted from the legacy set.** `anti-slop-precommit` exists in the legacy `~/.pi/agent/extensions/hooks` but not in `plugins/pi/extensions/hooks`, where the hooks moved.

## Hooks

- **No guard against `pgrep -f` / `pkill -f` self-match.** A pattern that also occurs in the command's own line (or its parent's) matches the checking process itself: "stopped" while the target is alive, "still waiting" with nothing to wait for. Candidate: a hint in `output-hygiene` for `-f` patterns without the `[x]` bracket trick.

## Credential proxy

- **The proxy mask restores only part of pi's inferred compat.** `maxTokensField` (and `prompt_cache_key` for api.openai.com) is restored; `thinkingFormat`, `supportsStore`, `requiresReasoningContentOnAssistantMessages` survive only as an explicit `compat` in `models.json`. Either restore more or warn when a masked provider has no explicit compat.
