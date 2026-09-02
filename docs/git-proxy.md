# Git from the sandbox: fetch yes, push no

How the git proxy works: how forges are declared, where the token comes from, what happens to
redirects, and why this is sturdier than a read-only token. The agent needs one fact out of this —
push from the sandbox is impossible — and that one is in the skill.

The image has no `ssh`, and does not need one. Forges are reachable through a **per-run git proxy**: the container talks HTTP to `host.docker.internal`, the real token is substituted on the host, and of the two smart-HTTP routes only fetch is proxied. Push is refused before any credential is attached to the request:

```
remote: Push is disabled for this sandbox: the git proxy forwards fetch only.
fatal: unable to access '…': The requested URL returned error: 403
```

Forges are declared once, at the root of the config:

```json
"gitProxy": {
  "gitlab.example.com": {
    "user": "oauth2",
    "tokenCommand": "phase secrets export GITLAB_RO_TOKEN --app personal --env Production --format kv"
  },
  "git.example.dev": {
    "user": "me",
    "tokenCommand": "phase secrets export FORGEJO_RO_TOKEN --app personal --env Production --format kv",
    "sshPorts": [2222]
  }
}
```

- The token comes from `token` (a literal), `tokenEnv` or `tokenCommand` — the command runs on the host and its stderr is not logged (secret managers like to quote the request in an error). The output is normalised whatever the source: the last non-empty line is taken (a secret manager's banner before the value is dropped), `KEY=` and quotes are stripped, `\r` is trimmed — so Phase's `--format kv` works as is. A value containing a control character is rejected (the host drops out with a warning) rather than going into a header, where it used to kill the process.
- `user` is the basic-auth login of the forge: the account name on Forgejo/Gitea, `oauth2` for a GitLab PAT, and the issued name like `gitlab+deploy-token-42` for a deploy token.
- The container gets its own `~/.gitconfig` where every address form — `https://`, `git@host:`, `ssh://…`, `ssh://…:2222/` — is rewritten to the proxy through a credential helper (the token lives in the helper, not in the URL, or it would show up in `git remote -v` and in the transcript). The agent does not need to know about the proxy: it clones the URL it found in a remote or in `go.mod`. The host's own `~/.gitconfig` is **not** mounted: its `insteadOf` rules would rewrite addresses back to ssh, which the image does not have.
- Commit identity does not depend on any of this — it arrives through `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, see [git-identity.md](git-identity.md).
- A profile or preset narrows the list — the `gitProxy` key lives **inside** the `sandbox` object: `"sandbox": {"profile": "go", "gitProxy": ["git.example.dev"]}` allows that forge only, `"gitProxy": false` allows no git over the network at all. A top-level `gitProxy` inside a preset is ignored (it describes host credentials, which is the user config's business).
- Push is enabled deliberately and per host: `"allowPush": true`.
- The proxy lives exactly as long as the run and is closed on **any** exit (timeout, cancellation, exception) through `try/finally`; closing also aborts live outbound fetches, so a stream carrying the real token cannot outlive the run. A leaked run token opens nothing afterwards, and while the run is alive it opens only fetch of the repositories the agent reads anyway.

**Why this is sturdier than a read-only token.** A token depends on what the forge is willing to issue (a corporate GitLab may not allow deploy tokens), while the refusal here is a property of the channel: the same proxy rejects `git-receive-pack` on every host alike. Everything that is not smart-HTTP fetch is cut as well: dumb HTTP, `..` in a path (including `%2e%2e` — segments are decoded before the check), and requests to hosts that were never declared. Push attempts and requests carrying somebody else's run token are counted and printed in the run header.

A forge redirect is followed **by the proxy itself** (up to 3 hops, gated on each) instead of being handed to the client — otherwise git re-authenticates at the "new location" and catches a challenge in the middle of the negotiation (`fatal: expected flush after ref listing`). This is needed for `go`, which tries the URL without the `.git` suffix and gets a 301 to the canonical one from GitLab. The canonicalisation is remembered for the run, so the second smart-HTTP request (a POST to the same path) goes straight to the right place. A redirect cannot smuggle `git-receive-pack` through, and a redirect to a host outside the list is a 502.

**About the proxy address.** It listens on `127.0.0.1`: the container arrives through `host.docker.internal`, which on Docker Desktop lands on the host loopback (measured — connections show up as `127.0.0.1 → 127.0.0.1`). A listener holding real credentials has no business being on every interface; override with `PI_PROXY_BIND`. The request handler is wrapped in try/catch: a malformed request from the container (say `%zz` in the path) gets a 400 rather than killing the host process.

One subtlety is a race: the forwarder notices a freshly listening socket with a delay (measured between ~320 and ~580 ms — a request ~320 ms after `listen` does not connect yet, one at ~580 ms does). So a run waits `PI_PROXY_SETTLE_MS` (1000 by default; `=0` disables) once before starting the container, instead of dropping the first model request or fetch.
