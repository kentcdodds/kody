# 0025: No package services primitive

- **Status:** accepted
- **Date:** 2026-08-19

## Context

Durable Object outbound sockets do not make a Durable Object a process
supervisor. The package services primitive attempted to host long-running
daemons in `PackageServiceInstance`, but it could not provide the process-level
reliability available from a platform such as Fly.

A fleet check found zero running services across 62 users. Only Kent had
historical `service_runtime` usage from an experiment.

## Decision

Delete the package services primitive, including `kody.services`, the services
MCP domain, and `PackageServiceInstance`.

Long-running daemons run in an external process environment such as Fly.
Exclusive or cancellable background work uses jobs or workflows.

## Consequences

Kody does not supervise persistent package processes or expose package-service
lifecycle APIs. Packages continue to provide apps, exports, jobs, workflows,
subscriptions, and package-owned storage.

Integrations that require a continuously connected daemon need an external
deployment and communicate with Kody through supported integration surfaces.

Leftover `kind = 'service'` `user_storage_buckets` rows stay until the
`storage_bucket_estimate_backfill` lane clears the matching StorageRunner
Durable Objects and then deletes the inventory. Account export and deletion keep
discovering those storage ids until that purge succeeds.

Deleting `PackageServiceInstance` on production `kody-runtime` is two deploys.
The class arrived through a `transferred_classes` migration, so Cloudflare still
has a remote binding after the source binding is gone. A same-deploy
`deleted_classes` migration fails with error 10061. Drop the remote binding
first, then apply top-level runtime-worker tag `v2` `deleted_classes`. The
`tools/ci/do-deletion-allowlist.json` entry for that tag stays for preview `v2`
and is the same contract the follow-up reuses. Preview keeps `v2` because a
fresh worker applies `v1` `new_sqlite_classes` and cannot create an unexported
class (error 10070).
