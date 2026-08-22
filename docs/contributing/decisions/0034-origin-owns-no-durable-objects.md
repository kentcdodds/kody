# 0034: Origin owns no Durable Object classes

- **Status:** accepted
- **Date:** 2026-08-22

## Context

[0016](./0016-mono-worker-extraction.md) extracted the package-runtime and jobs
lanes and left Remix, blog, official guides, MCP HTTP, OAuth, inbound email, and
the remaining Durable Object classes on the origin `kody` script. Cloudflare
assigns Durable Object instances a Worker version: any `wrangler deploy` of the
script that **owns** those classes resets them
(`Durable Object reset because its code was updated`), including uploads that
only change static assets or markdown imported into the bundle.

Blog posts, official guides (`docs/guides/`), and Remix UI change more often
than MCP or Durable Object code. Shipping those from the DO-owning script resets
live MCP sessions, mailboxes, repo sessions, and other platform objects for a
content edit.

A second origin-facing content worker (`kody-app`) that forwards every page
would pay a second ~27MB bundle and a hop on every request, then still need this
same Durable Object transfer later. Do not land that shape.

## Decision

The origin-facing `kody` script owns **zero** Durable Object classes. Extract
the remaining platform classes onto `kody-platform`
(`packages/platform-worker/`): `MCP`, `McpClientHub`, `OAuthPurgeCoordinator`,
`UserMeter`, `Mailbox`, `RepoSession`, `RepoSessionIndex`, and
`StripePlanRefresh`. Leave `StorageRunner`, `RunLog`, and
`PackageRealtimeSession` on `kody-runtime`.

MCP HTTP, OAuth, inbound email, queues, and Remix stay on origin. Origin and
runtime bind the platform classes cross-script. Do not put platform classes on
runtime (untrusted package code) or jobs (different data seam).

`transferred_classes` is a one-shot cutover, not a soak. Preview uses
`new_sqlite_classes` (fresh workers). Production applies the transfer while
origin still exports the classes, then origin deploys with
`script_name: "kody-platform"`. Never `deleted_classes` for transferred classes.

Content/UI-only production deploys upload origin only.

## Consequences

Content/UI-only production deploys no longer reset platform or runtime Durable
Objects. Cost: another wrangler config, preview bootstrap ordering, and a
one-shot production transfer with a short in-flight RPC error window. See the
[platform worker migration runbook](../architecture/platform-worker-migration-runbook.md).
