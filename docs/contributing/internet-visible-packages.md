# Internet-visible packages and capability approval

Internet-visible is a **package app** flag, independent of **forkable** (public
/ `is_private = 0` community listing + anonymous git read).

| Toggle           | Meaning                                                                   | Default                                        |
| ---------------- | ------------------------------------------------------------------------- | ---------------------------------------------- |
| Forkable         | Community can read and fork source; lists on `/community`                 | Off (private). Public packages are forkable.   |
| Internet-visible | Hosted app may be served on the public internet after capability approval | Off. Apps without the flag stay session-gated. |

Either, both, or neither. Enabling internet-visible requires the owner to
approve a one-page credential and capability summary (stable credential ids,
hosts, storage) for the **resolved dependency tree** (root + transitive `kody:@`
packages). Approving the capability set **records** a lockfile-like dependency
snapshot with the fingerprint and enqueues a `went_public` request on the shared
`package_approval_requests` queue (same page as credential-needs pauses). The
owner Approves that request to flip internet-visible on. Secret values never
appear on that page or in package code. Regular packages keep floating on
current `published_commit`
([ADR 0069](./decisions/0069-internet-visible-capability-pinning.md)).

## ADR 0001 exception

Public-site pinning of an approved dependency snapshot is the accepted exception
in [0069](./decisions/0069-internet-visible-capability-pinning.md).

## Forks

A fork does **not** inherit the origin's approval record. Credentials are
org-local. The forker's approval page starts empty of grants and shows the
origin capability set as review context only. The forker must approve in their
own org before their copy can be internet-visible. See
[0069](./decisions/0069-internet-visible-capability-pinning.md).

## Out of scope

Custom domains; Kody-account login for public apps with roles; third-party
visitor auth; image storage via other packages.
