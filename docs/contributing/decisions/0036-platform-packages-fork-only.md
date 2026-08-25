# 0036 — Person accounts do not run official platform packages

- **Status:** accepted
- **Date:** 2026-08-24

## Context

[0014](./0014-platform-live-packages.md) let every caller resolve public
`@kody/*` (and other platform-account) packages live.
[0035](./0035-platform-packages-execute-only.md) stopped saved person-account
packages from depending on those scopes, but left ad hoc execute able to import
and `packages.invoke` them. That leftover path gave official exports a public
execute API with no versioning ([0001](./0001-no-package-versioning.md),
[0031](./0031-kody-dependencies-wildcard-map.md)), and `packages.invoke` of a
platform target wrote caller-local `packageStorage()` under the official UUID —
a bucket the caller does not own and official jobs cannot read.

Official listings that persist (`@kody/notify`, `@kody/planetscale`) already
tell agents to fork. Stateless helpers do not justify a second live-resolution
lane.

## Decision

Person accounts do not run official platform packages.

- Ad hoc `execute` must not statically import or `packages.invoke` a platform
  scope. The bundler and invoke contract fail closed with a `community_fork`
  teaching error.
- Saved person-account packages still must not statically import, declare, or
  `packages.invoke` a platform scope (0035's saved-package half, unchanged).
- To use an official helper, `community_fork` into the caller's scope and import
  or invoke that copy.
- Platform-account packages may still compose with each other when the operator
  publishes them.

## Consequences

`@kody/*` is catalog and fork source. The copy in the caller's scope is what
runs, owns `packageStorage()`, and can grow jobs or apps. Operator bugfixes
reach a person only when they re-fork or edit their copy.

Revisit only if official packages grow a real versioning contract that 0001 and
0031 still refuse, or a non-fork install primitive that is not live source
resolution.
