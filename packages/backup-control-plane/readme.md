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
same object before constructing the absent canonical manifest. The original
one-hour signed URL returned by the durable export step is never used for
transfer. On every execution of both the retryable upload callback and the
retryable finalization callback, the runtime polls D1 with the cached bookmark
and requires a complete response for that same bookmark, obtaining a fresh
signed URL. Finalization then stream-compares exact byte count and SHA-256 with
R2. Pending refreshes retry; malformed responses and bookmark mismatches fail
closed. The final refresh, comparison, and immutable manifest write remain in
one Workflow step, so a callback retry performs another export API poll instead
of reusing a separately cached URL. This also applies when replay returns a
cached upload-step result and skips its callback. Without signed-source context
it fails with `duplicate-object-manifest-missing`. An existing manifest must
also match that object exactly.

Every canonical manifest uses schema v2 and is an Ed25519-signed envelope. Its
signature covers deterministic canonical JSON for the SQL key, bytes, SHA-256,
R2 ETag, source account/name and D1 UUID/name, bookmark and export timestamps,
build commit, retention tier, trusted restore-baseline id/digest, algorithm, and
key id. Exact envelope bytes are written only after signed-source comparison and
signing succeed. Signing failure may leave SQL for safe retry, but no manifest.

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
`file_size` to be a positive safe integer strictly below
`BACKUP_MAX_SOURCE_BYTES`. A zero live size fails retryably before export
readiness so a later scheduled retry or restart can recover once metadata is
positive. The checked-in default and deployment value are 4,500,000,000 bytes,
below R2's 5-GiB single-object limit. Configuration may lower this ceiling but
cannot raise it. Reaching the ceiling fails export readiness and hourly
observability before an export starts. The signed export download is
independently rejected if its `Content-Length` is zero or at or above 5 GiB.
Zero-byte rejection is retryable: the upload callback refreshes the bookmark URL
and retries without storing or manifesting the empty response.

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

Set `BACKUP_MANIFEST_SIGNING_KEY_ID`,
`BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64`,
`TRUSTED_RESTORE_BASELINE_ID`, and `TRUSTED_RESTORE_BASELINE_SHA256` as reviewed
non-secret vars. The verifying key is the base64-encoded Ed25519 SPKI public
key; hourly freshness verifies the canonical manifest payload against it and
treats invalid signatures or key configuration as stale. Set
`BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64` only as a Worker secret; it
is base64-encoded Ed25519 PKCS#8 private key material and must never appear in
Wrangler config, logs, manifests, evidence, or signed URLs.

The 02:15 UTC trigger normally creates the day's deterministic instance.
Freshness uses the previous UTC day before 02:15 and the current day from 02:15
onward, so the 02:45 tick cannot report yesterday as success for a failed
current backup. Freshness ticks from 02:45 through 05:45 UTC use the same
deterministic id and canonical 02:15 payload to create a missed instance or
restart an errored or terminated instance. Active and complete instances are
left alone, and no retry tick outside that bounded window creates an instance.
Freshness inspection and enqueue/restart run as independent settled lanes, so a
transient D1 metadata failure cannot skip the approved-window recovery attempt;
the scheduled event still fails afterward to preserve alerting. Exhausting the
120-poll export window is terminal for that Workflow execution; the next
approved tick restarts it with fresh Workflow step state and a new export rather
than replaying the cached pending poll sequence.

## Integrity checks

The hourly freshness check compares the immutable object's R2 size and ETag to
the canonical manifest. Run a separate periodic restore drill that downloads the
object, verifies its SHA-256 against the manifest, and restores it into a
non-production D1 database. The metadata freshness check is not a replacement
for that deep checksum and restore drill.
