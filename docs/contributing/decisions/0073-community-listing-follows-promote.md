# 0073: Community listing pin follows promote

- **Status:** accepted
- **Date:** 2026-10-14
- **Supersedes:** the intentional non-follow note in
  [community packages](../../use/community-packages.md) (pre-auto-follow)

## Context

Public packages had three tips: default-branch HEAD, runtime `published_commit`,
and community listing `pinned_commit`. Promote moved only the runtime; owners
had to call `communityPublish` or click **Update public listing** to advance the
catalog. That separate step was easy to miss (feedback on `@danj/hey-email`
staying on 1.4.0 after promoting 1.5.0), and the **HEAD ahead of published**
affordance never looked like a clear publish control.

## Decision

Once an active community listing exists, every successful package finalize that
advances `published_commit` best-effort syncs the listing pin (and catalog
snapshot) to that commit. First-time listing / unlist stay explicit visibility
actions (`packageUpdate` / `communityPublish` / Settings visibility). A
scheduled `community_listing_behind_backfill` lane retries rows that drifted
before auto-follow or whose sync failed.

The package Settings **Publishing** panel is the one owner surface for live
version, audience (private / organization / public), unpublished changes, and
the primary publish/promote CTA. There is no manual **Update public listing**
control.

## Consequences

Forkers receive `community.fork.upstream_updated` when an active listing pin
moves with promote. Agents no longer need a second `communityPublish` after
promote for catalog freshness. The profile **Needs republish** filter remains
only as a sync-lag signal.
