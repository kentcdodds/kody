# 0001: No user-facing package versioning or import pins

- **Status:** accepted
- **Date:** 2026-07-31

## Context

Every saved package is a real git repo on Cloudflare Artifacts with full commit
history, publish notes (readable via `repo_show_publish_note`), and a clonable
remote (`package_get_git_remote`). Runtime surfaces — `packages.invoke`,
package-owned jobs, apps, services, and webhooks — always resolve the package's
current `entity_sources.published_commit`, and published bundles for non-current
commits are pruned after 30 days. Static cross-package imports
(`kody:@scope/pkg/export`) snapshot the dependency's published commit at the
dependent's publish time and refresh only when the dependent republishes; the
platform never auto-republishes dependents.

The question: should packages get product-level versioning (semver releases, a
versions UI, runnable old versions), and should cross-package imports support an
explicit version/tag/commit pin?

## Decision

No to both. History, diffing, and rollback are served by the package's git repo.
Cross-package imports keep the implicit "snapshot at publish, refresh on
republish" contract, with no pin syntax in specifiers or
`package.json#kody.dependencies`.

Rationale: the consumer of a personal package is almost always its own author,
so there is no downstream consumer needing a semver stability contract; the one
cross-user surface (community forks) already pins by commit
(`community_listings.pinned_commit`, `community_forks.origin_commit`); and
pinned old versions would escape fleet package codemods, which keep published
trees healthy precisely because platform APIs evolve.

## Consequences

- Runtime resolution stays single-pointer (current published commit), and
  published-bundle retention stays at 30 days for non-current commits.
- Users who want stability can tag commits in their package repo (labels for
  humans, never read by the platform), hold off republishing a dependent until
  ready, or fork a dependency into a frozen copy under another name.
- Surfacing what already exists — a publish-history view backed by `git log`
  plus publish notes, or a one-click "revert to this publish" — remains open and
  cheap; it is UX over existing plumbing, not a versioning system.
- If real demand for import pins appears, the preferred shape is commit-SHA pins
  declared in `package.json#kody.dependencies` (not new specifier grammar),
  resolved by rebuilding from Artifacts at that commit, with a staleness warning
  in repo checks.
