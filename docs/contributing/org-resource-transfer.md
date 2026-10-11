# Org resource transfer

`adminOrgResourceTransfer` moves every resource one org owns to another org:
packages, repos, sources, secrets, values, integrations, BYO OAuth apps, MCP
servers, webhooks, package jobs, package storage, and memories. Use it when an
owner approves consolidating a personal org into a team org, or the reverse.

It is an admin capability. It is destructive, audited on both orgs, and runs
only through `execute`; never call it from package or user code.

```ts
await kody.adminOrgResourceTransfer({
	fromOrgId: 'org_source',
	toOrgId: 'org_target',
	mode: 'dry-run', // then 'apply'
	skipOrphans: false,
})
```

The engine lives in `packages/worker/src/org-transfer/`.

## What moves and what stays

`packages/worker/src/org-transfer/tables.ts` classifies every owner-keyed APP_DB
table as `move` (with how) or `keep` (with why). A test fails when an account
data target is missing from that map, so a new owner-keyed table needs a
deliberate decision.

These stay with the source org:

- Email inboxes, addresses, sender identities, and notification destinations.
- Usage, credit, and billing history, `RunLog`, and `UserMeter`.
- Person-owned rows (logins, passkeys, API tokens, OAuth clients).
- Org structure (memberships, invites, teams, handles, limits).
- Codemod run history and live MCP sessions.
- Session-scoped secret and value buckets.

Packages are renamed to `@<target slug>/<kody id>` in the registry. Their
sources still say the old scope, so run codemod
[`0011-owner-scope-follows-registry`](./package-codemods.md#0011-owner-scope-follows-registry)
after the transfer.

## Dry-run

Dry-run reads both orgs and returns a summary of counts and names only: package
renames, repos, secret and value names with their scope, integrations, OAuth
apps, MCP servers, webhooks, jobs, storages to copy, orphans, clashes, blockers,
and warnings. It never returns row values.

Apply refuses when the plan has any of these:

- Clashes: the target already has a package, repo, secret, value, integration,
  OAuth app, MCP server, or webhook with the same identity.
- Blockers: legacy (non-package) jobs, resource grants naming source-org
  subjects, trigger enablements by someone outside the target org, or an
  integration whose OAuth app is not live.
- Orphans, unless `skipOrphans: true`.

Both orgs must be live (not deleting, deleted, or suspended), and they must
differ.

## Orphans

An orphan is a row whose parent no longer exists, such as an `entity_sources`
row for a deleted package or a webhook endpoint whose package is gone. With
`skipOrphans: true` the transfer does not move orphans; it cleans them up in the
source org instead. Orphan webhooks and community listings are soft-deleted and
other orphan rows deleted in the same D1 batch. After commit, orphan sources are
deleted with their Artifacts repos, and orphan storage buckets are cleared on
their StorageRunner and then deleted, like package delete. A soft-deleted bucket
would keep its `(user_id, storage_id)` key and block a later transfer back.

## Apply

Apply holds the account write lease on both orgs (taken in id order) for the
whole run, re-plans under the lease, and refuses on anything the dry-run would
refuse. Then, in order:

1. Re-seal every encrypted column under the target owner's key context: secret
   and value entries, integration access and refresh tokens, OAuth app client
   secrets, and webhook URLs and HMAC secrets. Each value is decrypted and
   checked after re-sealing.
2. Write a backup of every affected row (ciphertext included) to the
   `OPERATOR_BACKUPS` R2 bucket. Apply fails closed when the binding is missing.
3. Copy OAuth app logos under the target owner.
4. Copy StorageRunner SQL for every moved package, job, and storage bucket, and
   verify row counts per table.
5. Move McpClientHub connections (tokens included) from the source hub to the
   target hub.
6. Re-point package jobs in the jobs worker.
7. Commit every APP_DB change in one D1 batch, with an
   `org.resources_transferred_out` / `org.resources_transferred_in` audit event
   on each org and an `access_epoch` bump on both.

If any step before the batch commits fails, completed steps are undone in
reverse order. If an undo step also fails, the error names it and the backup key
so an operator can finish by hand.

After commit, best-effort cleanup runs: source storage and hub servers are
cleared, old logos deleted, orphans cleaned, repo sessions on moved sources
discarded, package, memory, and job vectors reindexed under the target, and the
retriever, skills, subscription, invoke-contract, and community caches
refreshed. Failures there come back as `post_commit_warnings`, and `leftovers`
counts any rows still pointing at the source.

The result has the dry-run summary plus `backup_key`, `storage_copies`,
`leftovers`, and `post_commit_warnings`.

## Secret values

Secret values, tokens, and client secrets stay inside the worker. They are never
returned, logged, or included in error messages, and they never enter package or
user code. Decrypt failures use the generic secret errors.
`packages/worker/src/org-transfer/reencrypt.ts` is the only transfer module
allowed to touch the credential crypto boundary.

## Backups

Backups live at
`org-resource-transfers/<fromOrgId>/<toOrgId>/<stamp>-<uuid>.json` in
`OPERATOR_BACKUPS`. They hold row data with encrypted columns still sealed under
the source key context, so restoring means writing those rows back as they were.
Account deletion and org hard purge delete every backup that names the owner as
source or target. Account export skips them because the owner already exports
the same rows from D1.

McpClientHub connections move DO to DO in memory and are not in the backup. If
an undo runs after the target hub imported a connection, the upstream may
already have rotated its refresh token; reconnect that server if it fails.

## Production runbook

1. Confirm the owner's approval and both org ids.
2. Dry-run. Resolve clashes and blockers with the owner; decide on orphans.
3. Apply, and record `backup_key` in the operator log.
4. Check `leftovers` is empty and review `post_commit_warnings`.
5. Run codemod `0011-owner-scope-follows-registry` dry-run, then apply, with
   `userIds` set to the target org id.
6. Spot-check that a moved package runs, its secrets resolve, and its storage
   reads back.

## Related

- [Package codemods](./package-codemods.md)
- [Data storage](./architecture/data-storage.md)
- [Disaster recovery](./disaster-recovery.md)
- [Account write lease repair](./account-write-lease-repair.md)
