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

Leftover `kind = 'service'` `user_storage_buckets` rows stayed until the
`storage_bucket_estimate_backfill` lane cleared the matching StorageRunner
Durable Objects and then deleted the inventory. Production `APP_DB` had zero
leftover rows on 2026-08-19. #1565 removes the purge lane and tightens the live
CHECK so `'service'` cannot return.

Deleting `PackageServiceInstance` on production `kody-runtime` required two
deploys after #1552. The class arrived through a `transferred_classes`
migration, so Cloudflare still had a remote binding and existing objects after
the source binding was gone. A same-deploy `deleted_classes` migration failed
with error 10061 (#1552 deploy). Dropping the binding without exporting the
class failed with error 10064 (#1558). #1559 exported a stub and dropped the
remote binding. #1560 applied runtime-worker tag `v2` `deleted_classes` and
removed the stub. Preview `deleted_classes` requires a previous script version
that exported the class (error 10074); a first preview deploy applies `v1`
`new_sqlite_classes` and `v2` `deleted_classes` together so create and delete
elide.
