# 0031: `kody.dependencies` is a name-to-`*` map; still no pins or live resolution

- **Status:** accepted
- **Date:** 2026-08-20

## Context

`package.json#kody.dependencies` was an array of scoped names. Agents already
write npm-style maps, and [0001](./0001-no-package-versioning.md) already named
this field as the future pin surface. Changing the array to a map without
changing resolution was the remaining question: should `*` mean live latest
(skip republishing dependents), and should other versions be legal?

Package storage is keyed by immutable `packageId`, not commit. Two pinned
versions of the same package would share one SQLite bucket. Live `*` would run
dependency code that publish checks never saw.

## Decision

`kody.dependencies` is a map of `"@scope/package": "*"`. `*` means the
dependency's latest published commit, captured when **this** package publishes.
Do not accept ranges, tags, or commit SHAs. Do not resolve static imports live
when a dependency publishes. Do not auto-republish dependents.

Legacy arrays are rejected at parse after fleet apply of
`0005-kody-dependencies-to-wildcard-map`.

## Consequences

The published bundle remains the lock. Execute and `packages.invoke` stay the
live paths. Freeze by forking under another name (new `packageId`, new bucket),
not by pinning a version onto shared storage.

Revisit only if a concrete consumer needs a pin that a fork cannot serve, and
then prefer commit-SHA values in this map (0001) after deciding how those
commits share `packageStorage()`.
