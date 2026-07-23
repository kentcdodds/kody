# Production D1 backup control plane

This package is a dedicated scheduled Worker and Workflow. It is intentionally
separate from application cron and does not use `DynamicCallableWorkflow`.

## Retention prefixes

The schedule and key policy use UTC exclusively:

- Sunday UTC backups use `weekly/d1/<database-uuid>/<yyyy-mm-dd>/...` and the
  manifest retention tier `weekly`.
- All other UTC weekdays use `daily/d1/<database-uuid>/<yyyy-mm-dd>/...` and
  retention tier `daily`.

Each export object is immutable and bookmark-derived:
`<tier>/d1/<database-uuid>/<yyyy-mm-dd>/backup-<encoded-bookmark>.sql`. The day
has one canonical immutable `manifest.json`, which records the selected object
key. If a process crashes after writing SQL but before its manifest, a later
Workflow-step retry reuses the cached export bookmark and therefore inspects the
same object before constructing the absent canonical manifest. Before an
existing object can be reused, the retry re-fetches the same signed export and
stream-compares its exact byte count and SHA-256 with R2. The finalization step
repeats that comparison whenever the manifest is absent and writes the immutable
manifest in the same retryable Workflow step, even when replay returns a cached
upload-step result and skips its callback. Without signed-source context it
fails with `duplicate-object-manifest-missing`. An existing manifest must also
match that object exactly.

Configure the production R2 bucket lifecycle by these immutable prefixes:

- `daily/`: expire after approximately 35 days.
- `weekly/`: expire after approximately 400 days.

R2 lifecycle rules are bucket configuration and are deliberately not encoded as
application deletion logic. Before deployment, replace every placeholder in
`wrangler.jsonc`, create those lifecycle rules, provide the API token as a
secret, and set both enable variables to exactly `true` only after the export
benchmark is approved.

Workflow instance retention is omitted intentionally so Cloudflare applies the
maximum available to the account (currently up to 30 days on paid plans and
three days on free plans). This is separate from R2 backup retention.

## Source size ceiling

This runtime does not support a 10-GB D1 database. Before every export and on
every hourly freshness tick, it queries live D1 metadata and requires
`file_size` to be an integer strictly below `BACKUP_MAX_SOURCE_BYTES`. The
checked-in default and deployment value are 4,500,000,000 bytes, below R2's
5-GiB single-object limit. Configuration may lower this ceiling but cannot raise
it. Reaching the ceiling fails export readiness and hourly observability before
an export starts. The signed export download is independently rejected if its
`Content-Length` exceeds 5 GiB.

Multipart capture and statement-safe split restore are not implemented. A
database or logical SQL export above these limits is unsupported and cannot be
reported ready.

## Credential contract

The source export token requires Cloudflare Account D1 Edit. Cloudflare grants
that permission account-wide and it can mutate D1; the Worker's application
UUID/name allowlist reduces operator mistakes but does not technically scope the
token to one database or make it read-only.

Keep the source runtime token separate from destination R2 provisioning and
lock-administration credentials and from drill restore credentials. The Worker
receives only the source token as `CLOUDFLARE_API_TOKEN` and destination object
read/write access through `BACKUP_BUCKET`; it must not receive either
administrative or restore credential.

The 02:15 UTC trigger is the only path that creates an instance. Freshness uses
the previous UTC day before 02:15 and the current day from 02:15 onward, so the
02:45 tick cannot report yesterday as success for a failed current backup.
Freshness ticks from 02:45 through 05:45 UTC may restart that day's existing
errored or terminated deterministic instance. They never create a missing
instance; active and complete instances are left alone.

## Integrity checks

The hourly freshness check compares the immutable object's R2 size and ETag to
the canonical manifest. Run a separate periodic restore drill that downloads the
object, verifies its SHA-256 against the manifest, and restores it into a
non-production D1 database. The metadata freshness check is not a replacement
for that deep checksum and restore drill.
