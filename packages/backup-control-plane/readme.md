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
transfer. On every execution of the retryable upload callback, the runtime polls
D1 with the cached bookmark and requires a complete response for that same
bookmark, obtaining a fresh signed URL; the upload stream-verifies exact byte
count and SHA-256 against R2 while writing. Finalization deliberately does
**not** poll D1 again: expired poll results can only be refreshed by starting a
new export of a _newer_ database state, whose bytes legitimately differ from the
stored object whenever production wrote anything in between (this exact mismatch
made roughly every other nightly backup fail terminally with
`existing-object-source-mismatch` before 2026-07-27). Instead, finalization
re-reads the stored object and requires its size, R2 ETag, and full SHA-256 to
match the durable upload-step result (`stored-object-mismatch` /
`stored-object-missing` fail closed), then signs and writes the manifest in the
same Workflow step. An existing manifest must match that object exactly.

While streaming the upload, the runtime also measures SQL statement lengths
(quote-aware semicolon splitting). D1's import path rejects statements above its
~100 KB statement limit with `statement too long: SQLITE_TOOBIG`, so an
oversized statement means the object is not restorable through the D1 import
API. The measurements are persisted as `<objectKey>.stats.json` next to the SQL
object and logged as `backup-sql-stats`; an oversized count above zero
additionally logs `backup-unrestorable-statements` with failure status. The
backup itself completes — application write paths bound row sizes (see
`packages/shared/src/backup-restore-safety.ts`), so a nonzero count indicates a
new unbounded write path that must be fixed.

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

## Deploy

GitHub Actions deploys this Worker to the DR Cloudflare account from
`.github/workflows/deploy.yml` (`deploy-backup-control-plane`) when
`packages/backup-control-plane/` or `packages/shared/src/backup-*` change on
`main`. Requires repository secrets `DR_DEPLOY_TOKEN` and
`DR_BACKUP_ACCOUNT_ID`. Manual/emergency:

```sh
CLOUDFLARE_ACCOUNT_ID=<DR_ACCOUNT_ID> \
  CLOUDFLARE_API_TOKEN=<DR_DEPLOY_TOKEN> \
  npm run backup:deploy -- --var "BUILD_COMMIT:$(git rev-parse HEAD)"
```

Worker secrets (`CLOUDFLARE_API_TOKEN`, `DRILL_API_TOKEN`, signing key, restore
secrets) are not synced by that job — set them once with Wrangler / the
Cloudflare dashboard.

## Integrity checks

The hourly freshness check compares the immutable object's R2 size and ETag to
the canonical manifest. Run a separate periodic restore drill that downloads the
object, verifies its SHA-256 against the manifest, and restores it into a
non-production D1 database. The metadata freshness check is not a replacement
for that deep checksum and restore drill.

## Mailbox legacy graph pre-drop approval

The dedicated `kody-mailbox-legacy-graph-pre-drop-backup` Workflow is the only
supported writer of `email_user_graph_drop_approval`. It accepts no source
identity, counts, object key, digest, or approval fields. Before triggering it,
deploy migration `0134-email-user-graph-drop-approval.sql`, deploy this control
plane, and retain the backup-control-plane deployment's
`adhocPolicyProof.readBackVerified: true` output when reconciliation credentials
are available. The live production `adhoc/` lock and lifecycle were manually
applied and read back as 35 days on 2026-08-03. Deployments with
`DR_BACKUP_ADMIN_TOKEN` reconcile and re-verify that policy; deployments without
the optional secret log a skip and continue deploying the backup Worker.
Pre-drop manifests record the fixed `retentionTier: "daily"` required by the
approval contract, but their SQL and manifest objects live under `adhoc/`.
Consequently, the 35-day `expire-adhoc-backups-after-35-days` lifecycle rule
applies; the daily-prefix lifecycle does not.

`verifyMailboxPreDropR2Policy` is the canonical trigger gate. Every pre-drop
Workflow creates a request-local probe and attempts an unconditional destructive
overwrite before starting the export. Approval proceeds only when live R2
rejects that overwrite as bucket-policy locked. Missing or ineffective policy
therefore fails before export or approval; deploy-time reconciliation only
improves drift detection.

Create a UUID request id, a fresh 16-byte lowercase hexadecimal nonce, and one
canonical UTC timestamp. The Workflow instance id is exactly
`mailbox-pre-drop-<requestId>`; params with extra keys, a mismatched id, or a
`requestedAt` more than 15 minutes before Workflow creation are rejected. The
timestamp must not be in the future. Keying the instance only by request id
means a retry cannot substitute a different nonce or produce different bytes.
Using a Cloudflare API token accepted for Workers Scripts Write, trigger:

```http
POST https://api.cloudflare.com/client/v4/accounts/<DR_ACCOUNT_ID>/workflows/kody-mailbox-legacy-graph-pre-drop-backup/instances
Authorization: Bearer <WORKFLOWS_API_TOKEN>
Content-Type: application/json

{
  "instance_id": "mailbox-pre-drop-11111111-1111-4111-8111-111111111111",
  "params": {
    "requestId": "11111111-1111-4111-8111-111111111111",
    "nonce": "0123456789abcdef0123456789abcdef",
    "requestedAt": "2026-08-03T16:45:00.000Z"
  }
}
```

The REST API names the custom id field `instance_id` and requires `params` to be
the three-key JSON object shown above. Do not encode `params` as a string. The
failed first string-param instance issued no approval and is irrelevant. Do not
use the binding API's `{ id, params }` shape in this REST request.

The authenticated control-plane UI action
`POST /actions/mailbox-pre-drop-backup` generates those three values server-side
as an alternative. It does not accept backup evidence from the request.

Poll the same instance through the Workflow API:

```http
GET https://api.cloudflare.com/client/v4/accounts/<DR_ACCOUNT_ID>/workflows/kody-mailbox-legacy-graph-pre-drop-backup/instances/<INSTANCE_ID>
Authorization: Bearer <WORKFLOWS_API_TOKEN>
```

Wait for `result.status: "complete"`. `result.output` is the Workflow receipt
(the REST response may expose the structured output as a JSON-encoded string).
It contains `requestId`, `nonce`, immutable `manifestKey` and `sqlObjectKey`,
SQL bytes/SHA-256/R2 ETag, manifest key id and signature SHA-256,
source/export/build/baseline provenance, the frozen-authority timestamp and
original marker owner count, the current exact
owner/thread/message/attachment/event counts, and
`verifiedAt`/`expiresAt`/`issuedBy`. It contains no signed URL or secret.
`expiresAt` is exactly two hours after `verifiedAt`.

The Workflow verifies the configured production D1 identity and health gates,
captures exact USER graph counts, creates a request-unique immutable SQL object
and standard signed v2 manifest under
`adhoc/mailbox-drop/d1/<database>/<timestamp>-<nonce>-<requestId>/`, then
requires the marker and counts to remain unchanged. It re-reads canonical
manifest bytes and all SQL bytes from R2, verifies size, ETag, SHA-256, and the
Ed25519 signature with the configured public key, and only then atomically
UPSERTs the singleton approval while rechecking the database gates and exact
counts in the same D1 statement.

Do not use direct SQL to manufacture or update approval evidence. A duplicate
create or restart with the same request-id-derived instance id is the idempotent
retry path; reuse the exact params. The request has one deterministic
`backup-request.sql` key, so a retry that observes different export bytes fails
against the immutable object instead of approving them. After such an immutable
object mismatch, abandon that instance and create a fresh request id, nonce,
timestamp, and Workflow instance; never retry the request id with changed
parameters. Different same-day request ids intentionally produce distinct
prefixes and bytes.

The unchanged marker and exact counts are a valid backup-snapshot invariant only
because the frozen USER D1 boundary rejects live reads and writes, runtime
authority checks reject legacy USER graph mutation paths, and the sole
post-freeze privacy cleanup marker permits `SELECT`/`DELETE` but rejects
`INSERT`/`UPDATE`. A deletion therefore changes at least one exact count and
fails postflight; the atomic approval statement rechecks the marker, health
gates, and all counts. The destructive consumer must still compare every
approval count to its own immediate full-row parity query before dropping any
table. The remaining operational risks are the production-account D1 Edit
token's broad Cloudflare scope and Workflow/R2/D1 availability during the
two-hour window. This change does not authorize or perform a destructive drop.
