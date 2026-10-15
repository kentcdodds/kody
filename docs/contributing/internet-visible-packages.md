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
packages). Each package in the tree contributes only what it declares or was
given (`compute-package-capability-set.ts`): org credentials that fill its
`kody.credentials` needs, its `kody.secretMounts`, its package-scoped
credentials, credentials granted to it (`allowed_packages`), and package storage
when its published source uses it. Implicit user-credential read for
self-authored packages is not a declaration and adds nothing, so account-wide
credentials do not move the fingerprint. Approving the capability set
**records** a lockfile-like dependency snapshot with the fingerprint and
enqueues a `went_public` request on the shared `package_approval_requests` queue
(same page as credential-needs pauses). The owner Approves that request to flip
internet-visible on. Secret values never appear on that page or in package code.
Regular packages keep floating on current `published_commit`
([ADR 0069](./decisions/0069-internet-visible-capability-pinning.md)).

Turning internet-visible on (settings toggle or `packageUpdate`) records the
`went_public` request right away, even before the capability set is approved.
When that request is pending and the live capability set still needs approval,
the approval page shows one **Approve and make internet-visible** button
(`approve-capabilities-and-go-public`). It runs both decisions in order, each
with its own checks and its own org audit event: the capability pin
(`package.capabilities.approve`), then the `went_public` request
(`package.went_public.approve`). The pin does not enqueue a new `went_public`
request, so a request turned off meanwhile stays off. If the second step fails,
the pin stays recorded and the page falls back to the separate went-public card
when the request is still pending. The two steps were never split for a security
reason; they share one queue
([ADR 0068 amendment](./decisions/0068-credentials-own-placement-scoped-clients.md)).
An approval bundle's went-public item cannot be approved until the capability
set is, so it points at the package's approval page instead.

When the current published version has no security audit, the toggle response
(`securityAudit`) and `packageUpdate` (`security_audit`) carry the agent's next
step (`security-audit-next-step.ts`): audit, record with
`packageSecurityAuditRecord` using the returned `package_id`,
`published_commit`, and `fingerprint`, then hand the owner the approval link.
The audit is informational and approves nothing.

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

Kody-account login for public apps with roles; third-party visitor auth; image
storage via other packages. Custom domains are a separate feature
([0071](./decisions/0071-package-app-custom-domains.md)).
