# 0014 — Platform scopes resolve live in package imports

## Status

Accepted.

## Context

Built-in (platform) integrations pair naturally with official helper packages
(for example `@kody/github` alongside the `github` platform OAuth app), so
agents do not hand-roll provider glue. Before this decision, the only way for a
user to run another account's package code was `community_fork`: a copy into the
user's own scope. Copies have no upstream story — a bug fix in the official
package would require codemodding every fork — and shipping helpers as worker
source would put provider code on the deploy cadence while the providers
themselves are D1 rows.

Per-user isolation is the hard invariant: acting as another person user is
deliberately unrepresentable, and package imports resolve strictly against the
caller's `saved_packages`.

## Decision

`kody:@scope/name` static imports gain one narrow, structural exception: when
the caller has no package with that name and the scope username belongs to a
**platform account** (`users.account_type = 'platform'`, the same reserved,
never-logs-in accounts behind package scope grants), the import resolves
**live** from the platform account's current published version
(`resolvePlatformScopedPackageImport` in
`packages/worker/src/package-runtime/package-import-resolution.ts`).

Bounds that keep the isolation story intact:

- **Read-only source widening.** Platform resolution only changes whose
  _published_ source the bundler may read. Published platform package source is
  already public in spirit (community listings expose source to any forker);
  person-account scopes never resolve cross-user — the platform check is
  structural (`account_type`), not policy.
- **Caller runtime, caller boundaries.** Resolved modules execute in the calling
  user's runtime against the caller's secrets, storage grants, and entitlements
  — exactly as a fork would. Nothing runs "as" the platform account.
- **The caller's own copy always wins.** Forking a platform package to customize
  it keeps working unchanged.
- **Stateless in the caller.** Platform-owned dependency ids are excluded from
  `packageStorage()` grants (`platformOwned` on `BundleArtifactDependency`), so
  `packageStorage()` inside live platform code fails closed instead of opening a
  misleading empty caller-local bucket.
- **Static imports only.** The dynamic-import hydration lane persists rebuilt
  artifacts under the caller's identity, which must never happen for
  platform-owned sources; dynamic `import("kody:@kody/…")` reports a teaching
  error pointing at static imports.
- **Hidden or private means unresolvable.** A hidden or private platform package
  resolves only for its owner.
- **Versioning is unchanged.** Ad hoc execute rebundles per call and always sees
  the platform scope's current published version. Saved packages that import a
  platform package pin its snapshot at their own publish, exactly like
  caller-owned dependencies, and pick up updates on republish.

Community fork policy follows: `scanCrossScopeReferences` accepts platform
scopes as always-valid references (`allowedForeignScopes`), so forks keep
`@kody/...` imports instead of being told to rewrite them.

## Consequences

- Users get official helper packages with zero fork friction, and operator bug
  fixes reach every ad hoc caller immediately — no fleet codemods.
- The operator's platform packages become load-bearing supply chain for every
  user, which is the same trust users already extend to the worker itself on a
  hosted deployment; users who want insulation fork.
- Platform packages surface in ranked `search` alongside the caller's own
  packages: the search loader injects platform rows with a host-set
  `platformScope` marker, the package plugin's ownership tripwire admits exactly
  those marked rows (anything else foreign still fails the lane closed), and
  entity detail falls back to platform accounts when the caller owns no matching
  package. The caller's own copy of a name or kody id wins and replaces the
  platform row. Platform rows rank lexically only — the vector index is
  per-user, so platform packages have no vectors in the caller's namespace;
  revisit if lexical ranking proves too weak.
- Deferred: an optional pairing column linking a platform OAuth app to its
  recommended platform package.
