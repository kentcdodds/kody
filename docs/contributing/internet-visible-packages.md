# Internet-visible packages and capability approval

Internet-visible is a **package app** flag, independent of **forkable** (today's
public / `is_private = 0` community listing + anonymous git read).

| Toggle           | Meaning                                                                   | Default                                                |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| Forkable         | Community can read and fork source; lists on `/community`                 | Off (private). Existing public packages stay forkable. |
| Internet-visible | Hosted app may be served on the public internet after capability approval | Off. Existing packages stay session-gated.             |

Either, both, or neither. Enabling internet-visible requires the owner to
approve a one-page credential and capability summary (stable credential ids,
hosts, storage). Secret values never appear on that page or in package code.

## ADR conflict

Public-site pinning of an approved dependency snapshot conflicts with
[ADR 0001](./decisions/0001-no-package-versioning.md). The accepted exception is
[0069](./decisions/0069-internet-visible-capability-pinning.md) (accepted
2026-10-12, decided by Kent).

## Forks (decided 2026-10-12)

**Decided (Kent, 2026-10-12):** a fork does **not** inherit the origin's
approval record. Credentials are org-local. The forker's approval page starts
empty of grants and shows the origin capability set as review context only. The
forker must approve in their own org before their copy can be internet-visible.
See [0069](./decisions/0069-internet-visible-capability-pinning.md).

## Not in this work

Custom domains; Kody-account login for public apps with roles; third-party
visitor auth; image storage via other packages.
