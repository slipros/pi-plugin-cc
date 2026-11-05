---
description: Show (or reset) the plugin's pool liveness records — which slot pools are skipping dispatch and until when
argument-hint: '[--reset <pool>|--reset-all] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

Show the pool liveness records the plugin keeps for its own dispatch: a pool proven dead (balance, quota, unreachable endpoint) stays out of the variant choice until its probe deadline, and this is where those holds are readable and resettable.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" pools "$ARGUMENTS"
```

Each line names one pool, its failure class, the probe deadline and the short reason recorded from the provider's refusal. With no records at all it says every known pool is considered live.

`--reset <pool>` clears one record, `--reset-all` clears all of them. Resetting is debugging, never part of the normal loop: a pool returns on its own when its deadline passes, and a successful run erases the record entirely — there is no manual "revive" step to perform.

Return the output verbatim.
