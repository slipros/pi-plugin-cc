#!/usr/bin/env python3
"""Build the sandbox seccomp profile (used by the `agent` sandbox profile,
whichever stack — Go, Rust, Python, TS/Vue — needs a nested docker daemon)
from the upstream rootless one.

Provenance
----------
Base profile: the one rootless podman ships, containers/common.
  URL:    https://raw.githubusercontent.com/containers/common/main/pkg/seccomp/seccomp.json
  Fetched: 2026-08-13
  sha256 (upstream, as fetched):  886ae167646b7e5db381ecf7c31e6de720a8e8da15cf3202fe1f67f424af2b75
  sha256 (generated dind-seccomp.json): 7e8b51a0e6fa9a5ea811b4c4b72c3ec8786b27e3ef9fc299b5406d0ff53dbb67

The base already allows the namespace and mount syscalls a nested rootless
daemon needs, while everything outside its list stays SCMP_ACT_ERRNO.

Why it is not used verbatim
---------------------------
runc, while starting a nested container, performs a handful of syscalls that
upstream gates behind CAP_SYS_ADMIN and denies otherwise: sethostname,
setdomainname, setns, chroot. Docker resolves that gate against the *outer*
container's capabilities, and the outer container has CapEff=0 — so the inner
runc is refused even though it holds CAP_SYS_ADMIN inside its own user
namespace, and the nested container fails to start (verified: "sethostname:
operation not permitted"). Allowing the syscall unconditionally does not grant
the privilege — the kernel still requires CAP_SYS_ADMIN in the namespace that
owns the target, which is what the nested runtime has and what a process
reaching for the host does not (verified empirically: a pen-test agent inside
the sandbox could not escape). A CAP_SYS_ADMIN-gated ALLOW does NOT work here
and was tried: it breaks the nested daemon for the reason above.

Reproduce
---------
  # with an explicit base file:
  python3 make-dind-seccomp.py <base-seccomp.json> dind-seccomp.json
  # or let the script fetch and verify the pinned upstream:
  python3 make-dind-seccomp.py --fetch dind-seccomp.json
  sha256sum dind-seccomp.json   # expect the generated hash above
"""

import hashlib
import json
import sys
import urllib.request

UPSTREAM_URL = "https://raw.githubusercontent.com/containers/common/main/pkg/seccomp/seccomp.json"
UPSTREAM_SHA256 = "886ae167646b7e5db381ecf7c31e6de720a8e8da15cf3202fe1f67f424af2b75"
NESTED_RUNTIME_SYSCALLS = ["sethostname", "setdomainname", "setns", "chroot"]


def load_base(source):
    if source == "--fetch":
        raw = urllib.request.urlopen(UPSTREAM_URL, timeout=30).read()
        digest = hashlib.sha256(raw).hexdigest()
        if digest != UPSTREAM_SHA256:
            sys.exit(
                f"upstream sha256 mismatch: got {digest}, pinned {UPSTREAM_SHA256}.\n"
                "The base profile changed upstream — review the diff before trusting it."
            )
        return json.loads(raw)
    return json.load(open(source))


def build(profile):
    blocks = []
    for block in profile["syscalls"]:
        names = [n for n in block.get("names", []) if n not in NESTED_RUNTIME_SYSCALLS]
        if names:
            blocks.append({**block, "names": names})
    blocks.append({"names": NESTED_RUNTIME_SYSCALLS, "action": "SCMP_ACT_ALLOW"})
    profile["syscalls"] = blocks
    return profile


def main():
    if len(sys.argv) != 3:
        sys.exit(f"usage: {sys.argv[0]} <base-seccomp.json | --fetch> <output.json>")
    profile = build(load_base(sys.argv[1]))
    json.dump(profile, open(sys.argv[2], "w"), indent=1)
    print(f"blocks: {len(profile['syscalls'])}")


if __name__ == "__main__":
    main()
