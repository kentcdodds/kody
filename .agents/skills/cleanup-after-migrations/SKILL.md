---
name: cleanup-after-migrations
description: >
  Clean up leftover code, schema, shims, dual-writes, compatibility aliases,
  feature flags, and docs after a migration or similar change. Use when you
  introduce transitional leftovers, leave a deprecated path, need a soak or
  follow-up migration before dropping something, or are finishing a migration
  runbook. Remove the leftover in the same change when it is safe; otherwise
  open a GitHub issue so it is not forgotten.
---

# Cleanup after migrations

Read
[`docs/contributing/cleanup-after-migrations.md`](../../../docs/contributing/cleanup-after-migrations.md).
Do not leave untracked cruft.

## Decision

1. **Do it now** when the leftover is safe to drop with this change.
2. **Open a GitHub issue** when it must wait on a later migration, a second
   deploy, a soak or metrics gate, a fleet apply, or another cutover.

A runbook or `TODO` is not the tracker. The issue is.

Search open `Cleanup:` issues first. Title:
`Cleanup: <what to remove> after <gate>`. Label: `improvement`. Link the issue
from the introducing PR.

```markdown
## Leftover

What to delete or stop serving.

## Why it waits

The gate.

## Ready when

A falsifiable criterion (not a calendar date alone).

## How to verify

Commands, queries, or deploy evidence.

## Introduced by

PR that added the leftover.
```

```bash
gh issue create --title "Cleanup: … after …" --label improvement --body-file -
```

Or `kody:@kentcdodds/github/request` `POST /repos/kentcdodds/kody/issues`.

Soak or calendar gates also get a scheduled wake (`execute` +
`workflows.create({ runAt, idempotencyKey })`) per
[ship-pr](../ship-pr/SKILL.md). Close the issue when the cleanup lands.
