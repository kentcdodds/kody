# 0035 — Platform packages are execute-only

- **Status:** superseded by [0036](./0036-platform-packages-fork-only.md)
- **Date:** 2026-08-23

## Context

[0014](./0014-platform-live-packages.md) let every caller resolve public
`@kody/*` (and other platform-account) packages live, including saved packages
that statically imported or `packages.invoke`d them. That made official package
exports a public API the operator had to keep stable: no semver
([0001](./0001-no-package-versioning.md)), no pins
([0031](./0031-kody-dependencies-wildcard-map.md)), and `packages.invoke` of a
platform target is live on every job run.

Ad hoc execute is ephemeral. Agents rewrite. Saved packages, jobs, and apps are
durable products.

## Decision

Official platform packages are **execute-only**.

- Ad hoc `execute` may statically import or `packages.invoke` a public platform
  scope. The modules still run in the caller's runtime against the caller's
  secrets.
- Saved **person-account** packages must not statically import, declare, or
  `packages.invoke` a platform scope. Publish checks fail. Package, job, and app
  runtimes fail closed. Already-published person-package artifacts that recorded
  `platformOwned` dependencies fail at run time. No compatibility lane.
- To use official helpers in a durable package, `community_fork` into the
  caller's scope and depend on that copy. Fork rewrite maps same-package
  `@kody/name` self-imports onto the new owner; remaining `@kody/other`
  references stay foreign and must be forked too.
- Platform-account packages may still compose with each other when the operator
  publishes them.

## Consequences

The operator can change official package exports without a fleet of user-package
republishes. Agents still get live helpers in execute. Users who want insulation
or durability own a fork.

This record does not change the 0014 `packageStorage()` grant exclusion for
platform-owned static dependencies. That follow-up is
[packageStorage on official static imports](../package-storage-static-imports.md).

Revisit only if official packages grow a real versioning contract that 0001 and
0031 still refuse.
