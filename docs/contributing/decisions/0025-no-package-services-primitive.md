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
