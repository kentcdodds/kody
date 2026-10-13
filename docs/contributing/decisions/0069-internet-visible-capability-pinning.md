# 0069: Internet-visible apps pin an approved capability snapshot (amends 0001)

- **Status:** accepted
- **Date:** 2026-10-12
- **Decided by:** Kent C. Dodds (2026-10-12)
- **Amends:** [0001](./0001-no-package-versioning.md)

## Context

ADR 0001 declines user-facing package versioning and import pins. Runtime
resolves the current `published_commit`, and non-current published bundles are
pruned after 30 days. Static `kody:@` imports already snapshot dependency
commits at the dependent's publish time.

Internet-visible package apps (anonymous public serving) need a stronger
guarantee: the owner approves a capability set derived from a resolved
dependency tree, and that approved tree must keep serving while a newer publish
awaits re-approval. That conflicts with pruning non-current bundles at 30 days
and with reading "always current published_commit" as the only live pointer for
public serving.

## Decision

Keep 0001 for ordinary packages and private runs. Add a narrow exception for
**internet-visible** package apps only:

1. At capability approval (and whenever the approved fingerprint is accepted),
   record the resolved dependency snapshot (root + transitive `kody:@` commits)
   with the approval. Public serving uses that approved snapshot, not a floating
   latest tip, until a new approval matches a newer set.
2. Retain the approved published bundle(s) past the 30-day prune so a pending
   re-approval never takes a live public site offline.
3. Do **not** add user-facing semver, a versions UI, or import pin syntax in
   `kody.dependencies` / specifiers. Ordinary packages and private runs keep
   today's float-on-current / snapshot-at-publish behavior.

## Consequences

- 0001's "no pins" rule stays the default; this ADR is the only documented
  exception, scoped to internet-visible serving and retention of approved
  bundles.
- Follow-up implementation (transitive snapshot + retention) must link here and
  must not broaden pins to non-internet-visible packages.

## Forks

A fork does **not** inherit the origin's approval record. Credentials are
org-local: the forker must approve the capability set in their own org before
their copy can be internet-visible. The origin's approved capability set may be
shown as review context only.

## Non-goals (unchanged)

Visitor login/roles, third-party visitor auth, and cross-package image storage
remain future work and are out of scope for this amendment. Custom domains are
decided in [0070](./0070-package-app-custom-domains.md).
