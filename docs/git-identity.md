# Who the agent commits as

A delegated run that commits should be recognisable in `git log` — as the agent, not as you, and
without the run having to carry a `~/.gitconfig` that may not exist inside a container at all.

```json
"defaults": { "git": { "name": "pi agent", "email": "pi@example.dev" } },
"presets": { "go-developer": { "git": { "email": "go-developer@example.dev" } } }
```

```bash
/pi:delegate --git-name "pi agent" --git-email pi@example.dev   implement SPEC.md
```

This sets `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, which git reads ahead of any config file — so one setting covers a sandboxed run (where `~/.gitconfig` may not exist) and a host run (where it does exist, but names you rather than the agent). The run header shows `Commits as: …`.

Name and email come as a pair: half an identity is refused before the run starts, since git would refuse the commit anyway. Layers merge field by field, so a global name and a per-preset address work together.

**Order of precedence: flags, then your gitconfig, then a preset.** A `git` block in a preset or in `defaults` is a *fallback*, used only where git itself has no answer — it does not override the identity you configured for that tree. To make an agent commit as itself in a tree where you have an identity, pass the flags on the run.

**With no flags, the identity is read from the working directory.** The companion asks git, in the directory the agent will work in, who it would commit as — so `includeIf "gitdir:…"` rules keep working inside the sandbox:

```gitconfig
[includeIf "gitdir:~/work/"]
	path = ~/work/.gitconfig
[includeIf "gitdir:~/work/client/"]
	path = ~/work/client/.gitconfig
```

Rules apply top to bottom, so the narrower one goes below the general one. The lookup happens **on the host, before the container starts** — inside it never could: the repository is under `/workspace/` there, and the path the rule matches on does not exist.

Identity is independent of how the container reaches a forge: fetch goes through a per-run proxy and push is refused outright, see [git-proxy.md](git-proxy.md).
