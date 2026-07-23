# Disaster recovery

This runbook defines the recovery design and operator procedure for Kody's
production data. The repository contains a code-complete D1 backup control
plane, destination-resource provisioner, isolated D1 restore-drill CLI, and
fail-closed readiness assessor. Code-complete means those implementations and
tests exist; it is not evidence that the DR account, bucket, credentials,
secrets, deployed Worker/Workflow, enabled schedule, alerts, evidence, or drills
are live. Complete and record every item in
[Live setup checklist](#live-setup-checklist) before declaring any readiness
level.

The implemented operator entry points are:

- `node tools/ci/backup-resources-cli.ts plan|apply` for the destination R2
  bucket, lifecycle, and lock policy;
- the dedicated `packages/backup-control-plane/wrangler.jsonc` Worker/Workflow;
- `node tools/disaster-recovery/d1-restore-drill-cli.ts` for a dry-run or
  explicitly executed isolated D1 drill;
- `node tools/disaster-recovery/canonical-readiness-cli.ts` for readiness
  evidence assessment.

Operators must stop if `--help`, accepted flags, or reviewed configuration
differs from this runbook. Never substitute
`tools/export-d1-remote-to-sqlite.sh`: that script is a developer convenience
for copying selected remote rows into a local database, not a backup, restore,
retention, integrity, or DR tool.

## Objectives and assumptions

Kody is one Cloudflare Worker with several independent persistence systems.
There is no provider-level, transactionally consistent snapshot across them. The
recovery unit is therefore a manifest-bound set of independently captured
stores, restored behind disabled ingress and reconciled before service resumes.
Every user-owned path remains scoped by stable `userId` during backup,
validation, and restore.

The initial planning objectives are:

| Scope                    |                                                      Recovery point objective (RPO) | Recovery time objective (RTO) | Qualification                                                        |
| ------------------------ | ----------------------------------------------------------------------------------: | ----------------------------: | -------------------------------------------------------------------- |
| D1-only logical recovery | 24 hours from retained export; use D1 Time Travel for a more recent point when safe |                       4 hours | Requires a successful isolated D1 restore drill                      |
| Canonical user data      |                                                                            24 hours |                      12 hours | Requires D1, canonical R2, Artifacts, and `StorageRunner` coverage   |
| Full service             |        24 hours for canonical data; derived and OAuth state may be newer or rebuilt |                      24 hours | Requires canonical readiness plus rebuild and reauthorization drills |

These are assumptions to benchmark and approve, not guarantees. Capacity,
database export blocking time, object count, Artifacts repository count,
`StorageRunner` count and size, provider quotas, and incident cause can make the
RTO longer. Record measured p50/p95 capture and restore times quarterly and
revise the objectives when the observed p95 consumes more than 80% of an
objective.

Retain immutable successful recovery sets as follows:

- one daily-tier set each Monday through Saturday UTC for **35 days**;
- one weekly-tier set each Sunday UTC for **400 days**;
- failed, incomplete, or unverified sets never advance freshness and never
  replace a successful key;
- a set becomes restorable only after its final manifest, hashes, counts, source
  identities, capture window, and component statuses are written.

The Sunday export is written directly under the immutable weekly prefix; it is
not a tag pointing to a daily object that expires at 35 days.

## Data architecture and recovery classification

### Canonical stores

- **D1 `APP_DB`** is the relational system of record: users and stable user ids,
  source and Artifacts pointers, jobs and schedules, memories, encrypted saved
  secrets, email metadata, R2 object keys, published bundle metadata, and
  application projections. Production is database name `kody`; identity checks
  use its Cloudflare database UUID, never its mutable display name alone.
- **R2 `EMAIL_BLOBS`** is canonical wherever D1 points to an object:
  - inbound raw MIME uses `email-raw:v1:{userId}/{messageId}`;
  - externally stored outbound attachments use
    `email-attachment:v1:{userId}/{messageId}/{attachmentId}`;
  - D1 `email_messages.raw_mime_key` and `email_attachments.storage_key` are the
    inventory. A D1 row without its referenced object is data loss. An
    unreferenced object is an orphan to quarantine and investigate, not proof
    that a row can be synthesized.
- **R2 `COMMUNITY_ASSETS` user avatars** are canonical binary data. Keys are
  `user-avatars/{stableUserId}/{sha256}.{png|jpg|webp}` and D1
  `users.avatar_key` is the reference. Accepted source images are 1 through
  1,000,000 bytes, PNG/JPEG/WebP, 64 through 4096 pixels per side, with at most
  a 3:1 aspect ratio.
- **Cloudflare Artifacts** repositories are canonical Git history for package,
  job, and other repo-backed sources. D1 `entity_sources` and `repo_sessions`
  contain repo pointers, but pointers are not repository backups. The production
  namespace defaults to `production`. Repository access uses short-lived,
  repo-scoped read or write tokens; Cloudflare control-plane API tokens are not
  Git credentials.
- **`StorageRunner` Durable Objects** contain canonical per-user application,
  job, service, execute, and package state. Names are derived from
  `JSON.stringify([userId, storageId])`; package storage ids are
  `package:{encodeURIComponent(packageId)}`, jobs use `job:{jobId}`, and execute
  storage uses `exec:{uuid}`. The export RPC pages at 250 entries by default and
  caps a page at 1,000 entries. It returns serialized key/value entries and an
  estimated SQLite byte size. A backup is incomplete if it cannot enumerate
  every durable storage id that policy says is retained. Cloudflare's current
  SQLite-backed Durable Object limit is 10 GB per object; the backup design must
  stream and bound memory below that provider ceiling.

Other Durable Object storage is either reconstructed from D1 or requires an
explicit component decision in the manifest. `JobManager` alarms are derived
from D1 job schedules. Connector/session/realtime state is not a substitute for
canonical settings or source history.

### Canonical automation boundary

The implemented scheduled control plane backs up **D1 only**. It does not read
source `EMAIL_BLOBS` or `COMMUNITY_ASSETS`, enumerate `StorageRunner`, or mirror
Artifacts. Until separate automation is implemented and live evidence exists,
the following are operator contracts and mandatory canonical-readiness failures:

- **`EMAIL_BLOBS`:** enumerate every D1 `raw_mime_key` and external attachment
  `storage_key`, copy every referenced object byte-for-byte with key and
  metadata using independently scoped source-read and destination-write
  credentials, then verify hashes and both missing-reference and orphan reports.
  Parsed D1 email rows are not a substitute.
- **User avatars in `COMMUNITY_ASSETS`:** enumerate non-null `users.avatar_key`,
  copy every referenced `user-avatars/` object byte-for-byte with metadata, and
  verify hash/reference parity. Do not count derived community icons as
  canonical avatar coverage.
- **`StorageRunner`:** produce a complete known-instance inventory, export and
  restore each `(userId, storageId)` object's key/value and SQLite
  representations including metadata/expiration, and prove round-trip parity.
  Generic D1 SQL cannot enumerate unknown Durable Object instances and cannot
  preserve alarm/runtime state. The current paged account-export RPC alone is
  not complete DR automation.
- **Artifacts:** enumerate every D1-referenced repository, mint one short-lived
  read token per repository, create a mirror containing every ref and complete
  Git history, store it in independently retained destination storage, then
  restore and verify refs/objects. A default-branch clone or working tree is not
  coverage.

No operator may create support, inventory, credential, contract, or drill
artifacts based only on this document. Each resource needs its own dated
attestation and locally verifiable evidence bytes.

### Derived or intentionally regenerated stores

- **Vectorize `CAPABILITY_VECTOR_INDEX`** is derived. Reindex static
  capabilities, D1 memories, D1 jobs, and saved packages after canonical stores
  are available.
- **KV `BUNDLE_ARTIFACTS_KV`** contains generated bundle artifacts, source and
  manifest snapshots, package retriever caches, community snapshots, and icon
  descriptors. Rebuild published package artifacts from restored Artifacts
  commits and D1 metadata; republish/reconstruct snapshots; allow ordinary
  caches to warm.
- **R2 `COMMUNITY_ASSETS` community icons** are derived. Keys are
  `community-icon:v1/{listingId}/{commit}/asset`; descriptors live in
  `BUNDLE_ARTIFACTS_KV`. Regenerate from the pinned or current Artifacts commit.
  Source and rendered icon limits are 2 MiB; raster dimensions are at most 4096
  per side and 16,777,216 pixels. Do not treat a restored descriptor without its
  matching object, or an object without an active D1 listing, as valid.
- **Durable Object alarms**, **Cloudflare Queues**, and **Workflow instances**
  are runtime delivery state, not canonical backups. Re-arm alarms from D1,
  recreate queue and dead-letter-queue resources from deployment configuration,
  and reconcile queued work from D1 idempotency/status records. Recreate
  `DYNAMIC_CALLABLE_WORKFLOWS` infrastructure; do not replay unknown in-flight
  workflow instances blindly.
- **OAuth `OAUTH_KV`**, active browser sessions, OAuth grants/tokens,
  third-party connector tokens, and provider consent are not portable recovery
  artifacts. Revoke or abandon old grants and require users to sign in and
  authorize OAuth and remote providers again.

Production queue names and binding names come from the deployed, reviewed
Wrangler configuration, not from this page. At the time of writing they include
email delivery and its DLQ, platform-feedback dispatch and its DLQ, and
community-activity dispatch and its DLQ.

## Roles and least privilege

No one credential may both destroy the source and erase the retained backup.

| Role                           | Minimum authority                                                                                                                  | Must not have                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| D1 backup runtime              | Source-account Account D1 Edit through one secret token; object read/write through its destination-account `BACKUP_BUCKET` binding | Provisioner token, application paths that mutate source D1, destination bucket/lifecycle/lock administration |
| Canonical backup operator      | Read canonical source R2 and Artifacts; enumerate/export approved Durable Objects; write independently retained copies             | Claiming the D1 control plane implements these transfers                                                     |
| Backup retention administrator | Configure destination R2 bucket locks and lifecycle; inspect retention                                                             | Source account access, backup object overwrite/delete during lock                                            |
| Restore operator               | Read retained objects and manifests; create isolated/new destination resources; import into the approved target                    | Retention-rule removal, unrestricted production source mutation                                              |
| Incident commander             | Approve recovery point, abort points, cutover, and exceptions                                                                      | Routine possession of data-plane secrets                                                                     |
| Security approver              | Verify source/destination identities, escrow fingerprint, credential separation, and audit record                                  | Routine backup execution                                                                                     |

Cloudflare grants Account D1 Edit account-wide, and the permission can mutate
D1. Cloudflare does not technically scope the token to one database or make it
read-only. The runtime's reviewed UUID/name allowlist and metadata checks reduce
operator mistakes, but they are application controls rather than credential
scope. This unavoidable blast radius makes credential separation especially
important.

Use account-scoped service identities, short expirations where supported, and
bucket/resource restrictions:

- source D1 runtime token: source-account Account D1 Edit, used only by the
  backup export runtime and stored in the backup Worker as
  `CLOUDFLARE_API_TOKEN`;
- source R2 S3 credentials: object read/list on only `kody-email-blobs` and
  `kody-community-assets`;
- destination R2 runtime access: only the dedicated Worker's `BACKUP_BUCKET`
  binding, limited by application policy to `daily/` and `weekly/`;
- destination provisioner token: destination-account Workers R2 Storage Write
  for bucket, lifecycle, and lock setup only; never install it as a Worker
  secret or runtime credential;
- restore credentials: created just in time, separately audited, and revoked
  after the drill or incident.

The source runtime token, destination R2 provisioner/lock-administration token,
and drill restore credentials must be three separate credentials. Do not add
destination or restore authority to the source runtime token.

Do not put token values, signed URLs, repo tokens, R2 secret access keys, or
decrypted user secrets in command lines, manifests, logs, tickets, or shell
history. Provide credentials through the approved secret broker or
process-scoped file descriptors. The commands below show names and fingerprints
only.

## Source identity and destination isolation

The checked-in, reviewed recovery configuration must allowlist immutable source
identity, including:

- source Cloudflare account id;
- production D1 database UUID and expected display name;
- R2 bucket names and, where the API exposes them, jurisdiction/account
  identity;
- Artifacts namespace and account id;
- Durable Object namespace/class identities and deployment environment;
- Worker name, production hostname, and expected deployment environment.

Before every capture or restore, resolve live resources and compare all fields
to the allowlist. Abort on a missing field, duplicate resource, unexpected
account, UUID mismatch, preview/test name, or name-only match. The backup
runtime enforces `SOURCE_ACCOUNT_ID` against `ALLOWED_SOURCE_ACCOUNT_IDS`,
`SOURCE_DATABASE_ID` against `ALLOWED_SOURCE_DATABASE_IDS`, then calls the
source account D1 metadata API and requires the configured UUID and name to
match its response before export. Print safe identifiers and token fingerprints,
never token values.

The durable destination must be in a different Cloudflare account (or an
approved non-Cloudflare object store) with credentials issued and controlled
independently of the production account. A second bucket in the production
account does not protect against account compromise.

The dedicated backup Worker, its Workflow, and `BACKUP_BUCKET` live in the
independently administered **DR Cloudflare account**. The Worker calls the
production/source account D1 API using the source-account Account D1 Edit token
stored as its `CLOUDFLARE_API_TOKEN` secret. On completion, it streams the
temporary signed D1 export response directly into its destination-account R2
binding; it does not stage the SQL in the source account.

Cloudflare does not provide a single native cross-account backup transaction for
D1, R2, Durable Objects, KV, and Artifacts. R2 has no S3 replication API;
Artifacts requires repo-by-repo Git access; Durable Objects require
application-level enumeration and export. Never copy the destination provisioner
token into the Worker, and never grant the source D1 token destination R2
administration.

Provision the destination with the implemented fail-safe planner. The
provisioner token is read from the named environment variable and redacted from
rendered output:

```sh
node tools/ci/backup-resources-cli.ts plan \
  --source-account-id "<SOURCE_ACCOUNT_ID>" \
  --destination-account-id "<DR_ACCOUNT_ID>" \
  --provisioner-token-env DR_R2_PROVISIONER_TOKEN \
  --bucket-name "<DR_BUCKET>" \
  --worker-name kody-production-d1-backups \
  --source-d1 "<SOURCE_D1_UUID>:kody" \
  --deny-production-resource kody-email-blobs \
  --deny-production-resource kody-community-assets

node tools/ci/backup-resources-cli.ts apply \
  --source-account-id "<SOURCE_ACCOUNT_ID>" \
  --destination-account-id "<DR_ACCOUNT_ID>" \
  --provisioner-token-env DR_R2_PROVISIONER_TOKEN \
  --bucket-name "<DR_BUCKET>" \
  --worker-name kody-production-d1-backups \
  --source-d1 "<SOURCE_D1_UUID>:kody" \
  --deny-production-resource kody-email-blobs \
  --deny-production-resource kody-community-assets
```

The source and destination account ids are both mandatory and must differ. The
provisioner token is accepted only from `CLOUDFLARE_API_TOKEN` or the
environment variable named by `--provisioner-token-env`; there is no
command-line token-value flag.

The provisioner creates the private-by-default bucket and converges lock and
lifecycle rules for `daily/` at 35 days and `weekly/` at 400 days. Public
`r2.dev` and custom-domain exposure still require a separate check because this
provisioner does not manage those APIs. It preserves unrelated lock and
lifecycle rules and managed rules with stronger retention, then reads all three
resources back and fails unless the effective policies contain the managed
minimums. Its provisioner token is sent only to the official Cloudflare API;
there is no operator endpoint override. R2 bucket locks prevent overwrite and
deletion and apply to existing as well as new objects. When lock rules overlap,
the longest retention wins. Locks take precedence over lifecycle deletion, and a
locked bucket cannot be emptied until lock rules are removed. Lifecycle deletion
is asynchronous (typically within 24 hours of expiry), so 35/400 days are
minimum retention rather than an exact deletion instant. The default
incomplete-multipart-upload lifecycle is not a backup retention policy. Use
unique set ids and never overwrite an object key. Retention is fixed by the
provisioned bucket policies; the backup runtime intentionally has no custom
retention input or deletion logic.

## Backup capture

### Benchmark gate before enabling a schedule

D1 export is not an online snapshot: while an export is running, D1 is
unavailable for other queries. The REST export is asynchronous, must be
continually polled or it cancels, and returns a signed SQL download URL valid
for one hour. A scheduler must not be enabled until a production-sized
controlled benchmark has:

1. passed source UUID/allowlist checks;
2. run in an approved maintenance window with user writes quiesced;
3. measured D1 unavailable time, total export time, signed-URL download time,
   upload time, SQL bytes, object counts, hashes, and application error rate;
4. demonstrated continuous polling with bounded retry/backoff and download
   completion inside the one-hour URL lifetime;
5. demonstrated cancellation/cleanup after a lost poller and no overlapping
   export;
6. restored the result into an isolated D1 database and passed integrity,
   migrations, row-count, user-isolation, and smoke checks;
7. fit within the approved backup window and consume no more than 80% of the
   D1-only RTO at measured p95;
8. received incident commander, data owner, and security sign-off.

The implemented path also has a hard size-support gate. The live source D1
`file_size` must be an integer strictly below `BACKUP_MAX_SOURCE_BYTES` before
the benchmark or a scheduled export can proceed. The checked-in default and
deployment ceiling are 4,500,000,000 bytes. Configuration may lower that value
but cannot raise it.

If the gate fails, keep scheduling disabled. Change the maintenance window,
capacity, or design and repeat the benchmark. Do not test export blocking for
the first time through an unattended production schedule. There is no benchmark
CLI in this slice: benchmark execution, evidence capture, and approval are an
explicit operator/change-management contract.

Scheduling is fail-closed and remains inert unless both
`ENABLE_PRODUCTION_D1_BACKUPS` and `BACKUP_BENCHMARK_APPROVED` are exactly the
lowercase string `"true"`. Keep both `"false"` through resource provisioning,
deployment dry-run, initial deployment, and benchmark. After approval, update
both reviewed variables in `packages/backup-control-plane/wrangler.jsonc` and
redeploy. Setting only one, using another capitalization, or invoking an
already-created Workflow while either is false does not run a backup.

### Dedicated Worker deployment

The checked-in Wrangler file contains inert flags and placeholder account,
database, bucket, and commit values. Replace every placeholder with reviewed
DR/source values while leaving both enable flags false. Authenticate Wrangler to
the **DR account**, not the source account, then run:

```sh
npm run typecheck --workspace @kody/backup-control-plane
npm test --workspace @kody/backup-control-plane
npx wrangler deploy --dry-run \
  --config packages/backup-control-plane/wrangler.jsonc

# Wrangler is authenticated to the DR account. The piped value is a separate
# source-account token whose only Cloudflare permission is Account D1 Edit.
printf '%s' "$SOURCE_D1_EDIT_TOKEN" | npx wrangler secret put \
  CLOUDFLARE_API_TOKEN \
  --config packages/backup-control-plane/wrangler.jsonc

npx wrangler deploy \
  --config packages/backup-control-plane/wrangler.jsonc
```

Never pass `DR_R2_PROVISIONER_TOKEN` to `wrangler secret put`; it exists only
for `backup-resources-cli.ts`. Inspect the dry-run binding so `BACKUP_BUCKET`
resolves to the destination bucket and the Workflow name is
`kody-production-d1-backup`. Verify public access is disabled. After the
benchmark and approvals, set both enable variables to `"true"`, repeat the
dry-run, and deploy once more.

### Daily and weekly procedure

The primary `02:15 UTC` trigger normally creates the day's Workflow. On hourly
freshness ticks in the bounded **02:45, 03:45, 04:45, and 05:45 UTC** retry
window, the Worker uses the same deterministic id and canonical 02:15 payload.
It creates a missing instance (for example, after a failed primary create),
restarts an `errored` or `terminated` instance, and leaves a queued, running,
paused, waiting, `waitingForPause`, or complete instance alone. Concurrent
creates converge through the deterministic id; an unknown status fails closed.
No missed instance is created outside the approved retry window. Freshness
inspection and catch-up/restart execute as independent settled lanes: a
transient D1 metadata error does not suppress the recovery attempt, but the
scheduled event still fails after both lanes finish so alerting is preserved.

Freshness checks the previous UTC day only before the 02:15 trigger. From 02:15
onward it requires the current day's manifest, so the 02:45 check cannot report
yesterday's healthy backup while today's backup is missing or failed.

Sunday UTC is the weekly boundary. Each day has one canonical manifest and one
or more immutable attempt objects:

- Sunday uses `weekly/d1/{databaseUuid}/{yyyy-mm-dd}/manifest.json`;
- every other UTC weekday uses
  `daily/d1/{databaseUuid}/{yyyy-mm-dd}/manifest.json`;
- after D1 export completes, its bookmark is UTF-8 encoded to lowercase hex and
  the SQL key is `{dayPrefix}/backup-{hexEncodedBookmark}.sql`.

There is no fixed-name SQL object, daily copy on Sunday, or post-capture
promotion step. Workflow instance id `d1-backup-{databaseUuid}-{yyyy-mm-dd}`
prevents duplicate day creation. Immutable R2 puts reject conflicting bytes. The
single day manifest selects the canonical SQL attempt by its exact
bookmark-derived `objectKey`.

A manifest-less attempt object is never trusted from R2 alone. The original
one-hour signed URL in the durable export step result is never used for
transfer. Every execution of the retryable upload callback polls D1 with the
cached bookmark and uses that callback-local fresh URL. Before the canonical day
manifest can be written, one retryable finalization step independently polls D1
with the cached bookmark, stream-compares byte count and SHA-256 with R2, and
writes the immutable manifest. Every upload or finalization callback retry
performs another export API poll; neither URL is cached in a separate Workflow
step. The response must be complete and return the exact cached bookmark.
Pending responses retry, while malformed responses and bookmark mismatches fail
closed. Workflow can cache finalization only after manifest creation; otherwise
replay re-runs the refresh and source verification. This also applies when
replay returns a cached upload-step result and skips its callback. Missing
signed-source context fails with `duplicate-object-manifest-missing`;
unavailable, truncated, oversized, or mismatched source leaves the object
quarantined and the manifest absent. Do not delete, replace, or bless that
object automatically.

For each run, the Workflow:

1. refuses to run unless both enable gates are true;
2. verifies configured account/database allowlists and the source D1 UUID/name
   through the source API, and requires the live D1 `file_size` to be strictly
   below the configured, non-raisable 4,500,000,000-byte ceiling;
3. starts D1 export with `output_format: "polling"` and durably polls every 15
   seconds for at most 120 polls, then derives the SQL object key from the
   completed export bookmark; exhausting the bound is a terminal, non-retryable
   Workflow failure so an approved scheduled restart begins with fresh step
   state and a new export instead of replaying the same cached polls;
4. marks export API Workflow step outputs sensitive so the signed URL is not
   logged;
5. in every upload callback execution, polls with the cached bookmark for a
   fresh signed response and streams it into the destination `BACKUP_BUCKET`,
   computing bytes, SHA-256, and R2 ETag; it requires a valid `Content-Length`,
   rejects a declared length at or above 5 GiB, and rejects a streamed
   byte-count mismatch. The same strictly-below-5-GiB limit is enforced when an
   immutable object already exists, so a pre-existing object at the limit cannot
   be resumed into a manifest;
6. in one retryable finalization step, polls the export API once per callback
   execution with the cached bookmark, requires the same completed bookmark,
   uses the newly returned signed URL to repeat source comparison whenever the
   canonical manifest is absent, and writes schema-version-1 immutable manifest
   metadata including source identity, D1 bookmark, timestamps, key, hash, ETag,
   build commit, and retention tier;
7. emits structured success/failure logs. The hourly freshness check validates
   live source identity and `file_size` against the same size ceiling before it
   validates the expected manifest identity, shape, maximum age (26 hours by
   default), and object existence, size, and ETag against the manifest.
   Freshness fails when the retained object is at or above 5 GiB, even when its
   size and ETag otherwise match the manifest.

Hourly freshness deliberately does not download and SHA-256 the SQL object.
Scheduled deep checksum/restore drills must read the retained bytes and verify
their SHA-256; those drills complement, rather than replace, hourly size/ETag
freshness.

The control plane does **not** quiesce application traffic or create a
maintenance window; D1 export still blocks source queries. The approved
benchmark and live operations plan must account for that outage. It also does
not capture canonical R2, `StorageRunner`, or Artifacts. Those remain separate
operator contracts and readiness failures until independently automated,
executed, and evidenced.

The low-level D1 contract the Worker wraps is:

```sh
curl --fail-with-body --request POST \
  "https://api.cloudflare.com/client/v4/accounts/<SOURCE_ACCOUNT_ID>/d1/database/<SOURCE_D1_UUID>/export" \
  --header "Authorization: Bearer <FROM_SECRET_BROKER>" \
  --header "Content-Type: application/json" \
  --data '{"output_format":"polling"}'

# Poll the same endpoint; <BOOKMARK> is safe recovery metadata, not a credential.
curl --fail-with-body --request POST \
  "https://api.cloudflare.com/client/v4/accounts/<SOURCE_ACCOUNT_ID>/d1/database/<SOURCE_D1_UUID>/export" \
  --header "Authorization: Bearer <FROM_SECRET_BROKER>" \
  --header "Content-Type: application/json" \
  --data '{"output_format":"polling","current_bookmark":"<BOOKMARK>"}'
```

Do not paste the completed response into logs because it contains `signed_url`.

## Freshness, integrity, and alerts

Continuously publish component-level age and last-result metrics. Page the
primary operator and incident commander when:

- the hourly `freshness-stale` event reports that the expected daily/weekly
  manifest is missing, older than `BACKUP_MAX_AGE_HOURS` (26 by default),
  identity-invalid, malformed, missing its R2 object, or inconsistent with the
  object's size/ETag;
- the live D1 `file_size` is missing or invalid, or reaches the configured
  ceiling on an export attempt or hourly freshness tick;
- an immutable bookmark-derived attempt object exists without the canonical day
  manifest; quarantine it and open an operator investigation rather than
  repairing or deleting it automatically;
- no complete Sunday UTC weekly set exists by 8 days (a separate operator
  metric; the implemented freshness check validates the latest expected day);
- D1, `EMAIL_BLOBS`, avatars, Artifacts, or `StorageRunner` is missing,
  incomplete, stale, or hash-invalid in the newest set;
- source identity or D1 UUID differs from the allowlist;
- export polling stalls, export overlap occurs, or D1 remains unavailable past
  the benchmarked window;
- signed-download streaming exceeds its 15-minute Workflow step timeout or the
  one-hour URL expires;
- destination write, retention lock, lifecycle, capacity, manifest signature, or
  credential checks fail;
- R2 inventory differs from D1 references, an Artifacts ref cannot be mirrored,
  or a `StorageRunner` inventory cannot be enumerated;
- a scheduled job is disabled unexpectedly or either enable gate drifts.

Open a ticket rather than page for lifecycle deletion lag inside Cloudflare's
documented asynchronous window, orphan objects that do not affect the current
set, or an expected derived-cache rebuild warning. Never report aggregate backup
success when a canonical component failed. Deep checksum drills must detect byte
corruption that hourly size/ETag checks cannot prove absent. Test alert delivery
monthly.

## D1 recovery contracts

Cloudflare D1 Time Travel is always on for production-backend databases and
retains up to 30 days on Workers Paid or 7 days on Workers Free. Confirm the
live plan and `version: production` with `d1 info`; do not assume 30 days. Time
Travel restore is destructive, overwrites the database in place, and cancels
in-flight queries and transactions. It cannot clone or fork a database. Capture
the pre-restore bookmark returned by the operation so the restore can be undone.
Use Time Travel only with explicit destructive approval and a frozen
application.

```sh
npx wrangler d1 info "<D1_NAME>" --remote
npx wrangler d1 time-travel info "<D1_NAME>" \
  --timestamp "<RFC3339_RECOVERY_TIME>"

# Destructive production action: requires incident commander approval.
npx wrangler d1 time-travel restore "<D1_NAME>" \
  --bookmark "<APPROVED_BOOKMARK>" --remote
```

For retained SQL exports, `wrangler d1 execute --file` accepts SQL, not a raw
SQLite file. Kody supports an import file only when it is **strictly below 5
GiB**: exactly 5 GiB is rejected, as is every larger file. Statement-safe split
restore is not implemented, so operators must not split bytes or statements and
feed the parts to this CLI. Export has limitations for virtual tables and
JavaScript numeric precision; inventory the schema and values during the
benchmark.

Multipart capture is also not implemented. Consequently, a 10 GB D1 database and
any logical SQL export at or above 5 GiB are unsupported and must remain **NOT
READY**, regardless of provider capacity. The source `file_size` ceiling of
4,500,000,000 bytes is a separate, lower pre-export gate and cannot be raised by
configuration, operator approval, or an incident exception.

### Mandatory isolated D1 drill

Never use Time Travel to make a drill copy. It has no clone operation. The
restore CLI accepts neither `--allowlist` nor any alternate trust-registry path,
target inventory, or target UUID. It always loads the sole restore trust
registry, `tools/disaster-recovery/trusted-d1-restore-identities.json`, whose
exact schema is:

```json
{
	"schemaVersion": 1,
	"productionSources": [
		{
			"accountId": "<PRODUCTION_ACCOUNT_ID>",
			"databaseId": "<PRODUCTION_D1_UUID>",
			"databaseName": "<PRODUCTION_D1_NAME>"
		}
	],
	"drillTargets": [
		{
			"accountId": "<DRILL_ACCOUNT_ID>",
			"databaseName": "<DRILL_DATABASE_NAME>"
		}
	]
}
```

Every registry account ID must be canonical 32-character lowercase hex, and
every `productionSources[].databaseId` must be a UUID. This prevents mixed-case
duplicate trust entries. Each drill target account must differ from every
checked production source account. Runtime account IDs and D1 UUIDs compare
case-insensitively to canonical registry entries, while database names remain
exact. The target name must also differ from the manifest's production database
name.

Both checked-in lists are intentionally empty until identities are approved in
code review. Therefore both dry-run and `--execute` currently fail closed before
target creation. The operator-supplied manifest SHA-256 proves the integrity of
the exact manifest bytes; it does not trust their asserted source identity. Only
an exact match against the checked-in `productionSources` list establishes
source trust.

```sh
node tools/disaster-recovery/d1-restore-drill-cli.ts \
  --manifest restore-manifest.json \
  --manifest-sha256 "<OPERATOR_SUPPLIED_MANIFEST_SHA256>" \
  --backup downloaded-export.sql \
  --baseline restore-baseline.json \
  --target-account-id "<CHECKED_DRILL_ACCOUNT_ID>" \
  --target-name "<CHECKED_DRILL_DATABASE_NAME>"

# After reviewing the dry-run plan, retrieve the target-account D1 Edit token
# into CLOUDFLARE_D1_DRILL_EDIT_TOKEN through the approved secret broker.
node tools/disaster-recovery/d1-restore-drill-cli.ts \
  --manifest restore-manifest.json \
  --manifest-sha256 "<OPERATOR_SUPPLIED_MANIFEST_SHA256>" \
  --backup downloaded-export.sql \
  --baseline restore-baseline.json \
  --target-account-id "<CHECKED_DRILL_ACCOUNT_ID>" \
  --target-name "<CHECKED_DRILL_DATABASE_NAME>" \
  --execute
```

The CLI verifies the exact manifest bytes against the separately supplied
manifest SHA-256 as an integrity check, independently verifies the manifest's
exact source identity against the checked-in trust registry, stats the SQL file,
rejects files at or above 5 GiB or with a manifest size mismatch, then computes
SHA-256 as a stream without retaining the dump in memory. It does not split
oversized dumps. It dry-runs by default and does not create a target. With
`--execute`, it requires `CLOUDFLARE_D1_DRILL_EDIT_TOKEN`, live-creates a new D1
database in the exact checked drill account with the exact checked drill name
immediately before import, and verifies Cloudflare's returned UUID, exact
requested name, and `created_at` against the creation window. It never creates a
target in any account listed in `productionSources`. New creation is the
empty/unbound proof. The drill-only token is passed to Wrangler as
`CLOUDFLARE_API_TOKEN` with the selected target account and is never printed.

After live creation, the CLI generates a temporary local Wrangler config whose
`D1_RESTORE_TARGET` binding contains the returned target UUID and exact target
name and whose `migrations_dir` points to `packages/worker/migrations`. Import,
baseline and post-forward checks, and forward migrations all address
`D1_RESTORE_TARGET` through that generated config; they do not rely on a
checked-in or name-only binding. The CLI removes the local temporary config in a
`finally` cleanup, but intentionally does not delete the live-created drill
target.

Execution imports, then checks D1's documented `PRAGMA quick_check`,
`PRAGMA foreign_key_check`, expected migration names, schema hash, sequences,
and representative two-user isolation baselines. It never deletes, binds, cuts
over, or modifies production.

Forward migrations are an inseparable pair of inputs:

```sh
node tools/disaster-recovery/d1-restore-drill-cli.ts \
  --manifest restore-manifest.json \
  --manifest-sha256 "<OPERATOR_SUPPLIED_MANIFEST_SHA256>" \
  --backup downloaded-export.sql \
  --baseline restore-baseline.json \
  --post-forward-baseline post-forward-baseline.json \
  --target-account-id "<CHECKED_DRILL_ACCOUNT_ID>" \
  --target-name "<CHECKED_FORWARD_DRILL_DATABASE_NAME>" \
  --apply-forward-migrations \
  --execute
```

`--apply-forward-migrations` without `--post-forward-baseline`, and a
post-forward baseline without the migration switch, both fail closed. Delete the
live-created drill target only through the separate approved operator cleanup
procedure, after evidence is retained and the approved cleanup window starts.

## Cross-store restore and abort points

Full recovery uses a new isolated service environment whenever the incident
allows it. Keep all public ingress, cron, queue consumers/producers, email
routing, and workflow starts disabled until cutover.

1. **Select and validate the set.** Verify manifest signatures/hashes, source
   UUID, capture window, component completeness, retention status, and incident
   safety. **Abort** if identity differs, any canonical component is absent, or
   the set predates an incompatible schema/code boundary.
2. **Provision empty infrastructure.** Deploy the compatible Worker revision and
   migrations/configuration to isolated destination resources without traffic.
   Configure secrets from escrow and provider consoles, not backup payloads.
   **Abort** on a resource collision, existing destination data, or binding to a
   source/production resource.
3. **Restore Artifacts first.** Recreate namespace/repositories, import all
   refs, and record old-to-new repo mapping if account-specific remotes or ids
   change. Verify Git connectivity and expected commits. **Abort** before D1
   import if any D1-referenced canonical repository or commit is unavailable.
4. **Restore canonical R2.** Copy `EMAIL_BLOBS` and user avatars, preserving
   bytes, content type, cache metadata where relevant, and keys. Verify hashes
   and D1-reference inventory against the selected manifest. **Abort** before D1
   import on missing referenced objects.
5. **Restore `StorageRunner`.** This requires a reviewed restore adapter/RPC
   that is not implemented in this slice. It must recreate each object using the
   same `(userId, storageId)` naming contract, page/checksum all entries, and
   verify key/value and SQLite byte/count summaries. Do not derive an object id
   from `storageId` without `userId`. **Abort** before D1 import on incomplete
   canonical object coverage.
6. **Import D1.** Import into the verified empty target, apply only the
   code-compatible migration state, rewrite account-specific Artifacts pointers
   only through a reviewed mapping, then run the isolated verification suite.
   **Abort** before any derived rebuild or traffic if integrity, foreign keys,
   counts, stable user ids, R2 references, or source ownership checks fail.
7. **Rebuild derived state.** Reindex Vectorize; rebuild published bundles,
   snapshots, and cache indexes in `BUNDLE_ARTIFACTS_KV`; regenerate community
   icons; recreate queues/DLQs/workflow bindings; resynchronize alarms from D1.
   **Abort** before traffic if a required package cannot load, jobs cannot be
   scheduled, or queue/workflow infrastructure is absent. Nonessential cache
   misses may warm after cutover only with explicit acceptance.
8. **Reauthorize identity and external systems.** Deploy new cookie/OAuth
   configuration, invalidate old sessions/grants, and require sign-in, OAuth,
   social login, remote connector, and third-party provider reauthorization.
   Validate inbound email routing and sending identities without replaying old
   queue messages. **Abort** if authorization can cross users or old credentials
   remain accepted unexpectedly.
9. **Read-only canary, then cutover.** Exercise health, login, account export,
   email reads, package/source reads, storage reads, and per-user isolation.
   Enable writes for named canaries, then traffic, queues, cron, email, and
   workflows in separate approved steps. At every step retain the prior routing
   target and a rollback deadline. **Abort/roll back** on integrity,
   authorization, sustained errors, or reconciliation drift.

Never resume writes to both old and restored environments. After the first write
to the restored environment, rollback requires a new data reconciliation
decision; DNS/route reversal alone can lose those writes.

### Derived rebuild procedures

Vectorize has one implemented bulk maintenance route. Invoke it only against the
isolated restored Worker after verifying its origin and binding identities:

```sh
curl --fail-with-body --request POST \
  "https://<RESTORED_ORIGIN>/__maintenance/reindex-capabilities" \
  --header "Authorization: Bearer <CAPABILITY_REINDEX_SECRET_FROM_BROKER>"
```

That route rebuilds static capabilities, memories, jobs, and saved packages and
attempts every phase before returning failure details. Treat any failed phase or
item as not ready. `POST /__maintenance/reindex-memories` and
`POST /__maintenance/reindex-jobs` exist for narrower repairs, authenticated by
`CAPABILITY_REINDEX_SECRET` and `JOB_REINDEX_SECRET` respectively; they are not
a substitute for the full route.

The remaining rebuilds are explicit manual contracts; this slice provides no DR
CLI for them:

- **`BUNDLE_ARTIFACTS_KV`:** enumerate every current D1 published-artifact
  target and restored Artifacts commit, then re-run the existing package
  publish/rebuild path for each target. Verify D1 `kv_key` rows resolve to
  destination KV bytes and dependencies. There is no bulk maintenance route.
- **Community icons:** enumerate active listing `pinnedCommit` and `iconCommit`
  pairs and request `GET /community/{listingId}/icon/{iconCommit}` for each
  allowed commit. The route lazily regenerates the KV descriptor and R2 output
  from restored Artifacts source. Verify the object and descriptor; a fallback
  response is not rebuild success.
- **Alarms:** enumerate every D1 job owner/schedule and invoke a reviewed
  `JobManager.syncAlarm` operator adapter per user, then compare persisted
  `next_run_at` with alarm evidence. No bulk HTTP maintenance route or DR
  adapter is implemented.
- **Queues and Workflows:** deploy the reviewed Wrangler producer, consumer,
  DLQ, and `DYNAMIC_CALLABLE_WORKFLOWS` configuration into the restore
  environment, then run delivery/idempotency canaries. Configuration cannot
  recover unknown in-flight queue messages or active Workflow instances.
- **OAuth:** do not copy `OAUTH_KV`, access tokens, or refresh tokens. Revoke or
  abandon old grants and require sign-in and provider/connector reauthorization.

Until each manual contract has complete inventory, credentials, execution, and
post-rebuild evidence, `canonical-readiness-cli.ts` correctly reports the
corresponding full-service resource as not ready.

## Secret escrow and reauthorization

`SECRET_STORE_KEY` derives the AES-GCM key that encrypts saved secret ciphertext
in D1. There is no legacy decryption fallback or key version in each ciphertext.
Restoring D1 without the exact key makes saved secrets unreadable.

The key value must live in an independently administered external secret escrow,
not in D1, R2 backup objects, manifests, repository files, CI logs, or operator
notes. The recovery manifest stores only a non-reversible fingerprint such as
`SHA-256("kody-secret-store-key-fingerprint-v1\0" || key)` and the escrow
record/version identifier. During restore, two authorized operators retrieve the
key directly into the destination secret manager, recompute the fingerprint,
compare it without printing the key, and run an approved decrypt canary.

Do not generate a replacement key for an old D1 export and call the restore
complete. If escrow recovery fails, saved secrets are unrecoverable; preserve
the ciphertext, mark canonical/full-service readiness failed, and require users
to replace secrets. Rotation requires decrypt/re-encrypt migration as described
in [Secret rotation](./secret-rotation.md).

`COOKIE_SECRET`, social-provider client secrets, Stripe credentials, maintenance
secrets, R2 credentials, Cloudflare API tokens, Artifacts tokens, and connector
credentials are restored or rotated from their owning secret systems. They are
not data-backup payloads. Users must reauthorize OAuth grants, third-party
integrations, and remote connectors after a full-service restore; do not attempt
to preserve provider refresh tokens as proof of readiness.

## Drill schedule and readiness levels

Run and retain evidence for:

- monthly manifest/hash restore-readiness checks and alert-delivery tests;
- monthly isolated D1 import drills, rotating retained daily and weekly sets;
- quarterly canonical-data drills covering D1, sampled then periodically full
  `EMAIL_BLOBS`/avatars, every referenced Artifacts repo, and every inventoried
  `StorageRunner`;
- semiannual full-service exercises through isolated canary, derived rebuild,
  OAuth reauthorization, alarm/queue/workflow recreation, and controlled
  cutover/rollback rehearsal;
- after material schema, storage-contract, account, encryption, provider API, or
  recovery-tool changes, an additional drill before readiness is reinstated.

Readiness is reported separately:

- **D1-only ready:** complete checksummed D1 SQL, schema/migration parity, a
  live source-size measurement strictly below the supported ceiling,
  foreign-key/`PRAGMA quick_check`/sequence checks, representative two-user
  isolation, and passing isolated import within RPO/RTO. Operational declaration
  also requires fresh backup/freshness evidence and alert delivery.
- **Canonical-data ready:** D1-only ready plus independently retained and
  verified canonical `EMAIL_BLOBS`, avatars, Artifacts, complete `StorageRunner`
  inventory/restore, and external `SECRET_STORE_KEY` source and destination
  fingerprint match with escrow custody and recovery-test evidence. D1
  ciphertext without the matching externally escrowed key is not canonical
  readiness.
- **Full-service ready:** canonical-data ready plus evidenced Vectorize,
  `BUNDLE_ARTIFACTS_KV`, community-icon, alarm, queue/workflow reconstruction,
  and per-user OAuth/provider reauthorization. These are derived/operational
  gates and never weaken the canonical-data requirements.

Report `not ready` if any required drill is overdue, newest set is stale,
credential or destination independence is unverified, an inventory is
unenumerable, or an RTO is missed. One level never implies the next.

## Live setup checklist

All boxes require dated evidence and an owner. Until then this runbook describes
the intended system only.

- [ ] Recovery owner, backup operator, retention administrator, restore
      operator, incident commander, security approver, and on-call escalation
      are named.
- [ ] RPO/RTO, maintenance window, data classification, budget, and regional or
      jurisdiction requirements are approved.
- [ ] The code-complete provisioner, backup package, restore drill, and
      readiness assessor pass tests at the deployment commit.
- [ ] Exact production `{accountId, databaseId, databaseName}` identities and
      distinct drill `{accountId, databaseName}` identities are approved by code
      review in `tools/disaster-recovery/trusted-d1-restore-identities.json`;
      until both lists are populated, restore dry-run and execution remain
      fail-closed.
- [ ] Production source account, D1 UUID, R2 buckets, Artifacts namespace,
      Durable Object namespaces/classes, Worker, hostname, and environment are
      allowlisted; preview/test identities are denylisted.
- [ ] A separately administered destination account/bucket exists with
      independently issued credentials and audited break-glass access.
- [ ] Provisioner plan/apply evidence names distinct source and destination
      account ids; the provisioner token came only from an approved environment
      variable and is absent from runtime.
- [ ] Daily 35-day and weekly 400-day R2 lock/lifecycle rules are installed,
      listed, tested against overwrite/delete, and monitored.
- [ ] Least-privilege source, scheduler, destination, restore, and retention
      credentials are brokered, fingerprinted, rotated, and tested without
      exposing values.
- [ ] `SECRET_STORE_KEY` is in external two-person escrow; only its domain-
      separated fingerprint and escrow version appear in manifests.
- [ ] Canonical R2 and every required `StorageRunner` can be completely
      enumerated, streamed, checksummed, and reconciled to D1.
- [ ] Every D1-referenced Artifacts repo and ref can be mirrored and restored
      with short-lived repo-scoped tokens.
- [ ] The blocking D1 export benchmark gate passed at production scale and an
      isolated import passed before schedule enablement; the live D1 `file_size`
      was strictly below 4,500,000,000 bytes, and over-ceiling `file_size` and
      at-or-above-5-GiB signed `Content-Length`, pre-existing-object, restore
      input, and freshness failures were tested.
- [ ] The dedicated Worker/Workflow is deployed in the DR account with the
      source Account D1 Edit secret and destination R2 binding; the provisioner
      token is absent from runtime.
- [ ] Both schedule gates remained false through benchmark and are true only in
      the approved deployment.
- [ ] The primary 02:15 UTC trigger, bounded 02:45–05:45 same-day
      create-or-restart catch-up checks, and hourly live-D1-size plus R2
      size/ETag freshness logs are live; catch-up uses the canonical 02:15
      payload and no missed Workflow is created outside the approved window.
- [ ] Each day has one canonical manifest selecting a bookmark-derived immutable
      SQL key; orphan-attempt quarantine and restarted-export/new-key behavior
      have tested alerts and operator procedures.
- [ ] Deep checksum drills verify SQL bytes against manifest SHA-256 on schedule
      and orphan-attempt-without-manifest alerts have a tested quarantine and
      investigation path.
- [ ] A fresh D1-only drill passed against a live-created isolated target, after
      exact checked source and drill-target identity matches, including the
      source-size ceiling, strictly-below-5-GiB restore input,
      `PRAGMA quick_check`, foreign keys, migration/schema parity, sequences,
      and representative two-user isolation; no checked production account was
      eligible for target creation.
- [ ] A fresh canonical-data drill passed.
- [ ] A fresh full-service drill passed, including OAuth reauthorization and
      derived reconstruction.
- [ ] Evidence location, audit retention, exception process, and runbook review
      date are recorded.
- [ ] Every readiness artifact is a dated, resource- and kind-specific local
      Ed25519 envelope whose exact bytes match its declared SHA-256; every URI
      is unique, every signature chains to a reviewed checked-in verifier key,
      and network evidence is rejected.
- [ ] Approved recovery-verifier public keys are present in
      `tools/disaster-recovery/trusted-readiness-public-keys.json`; each key was
      added through code review and its private key is controlled outside the
      repository.
- [ ] Evidence refresh automation respects the code-owned 35-day D1, 100-day
      canonical-data, and 200-day full-service maximum ages regardless of
      `expiresAt`.

Operator status command:

```sh
node tools/disaster-recovery/canonical-readiness-cli.ts \
  --evidence recovery-evidence.json
```

The evidence file is an array with exactly one dated index record per resource.
Each index record has an exact versioned shape and repeats the signed metadata
for every artifact:

```json
{
	"schemaVersion": 1,
	"resourceId": "APP_DB",
	"verifierIdentity": "<APPROVED_RECOVERY_VERIFIER_ID>",
	"changeId": "<CHANGE_ID>",
	"systemVersion": "<DEPLOYMENT_BUILD_OR_COMMIT>",
	"performedAt": "<UTC_ISO_TIMESTAMP_WITH_MILLISECONDS>",
	"expiresAt": "<LATER_UTC_ISO_TIMESTAMP_WITH_MILLISECONDS>",
	"artifacts": [
		{
			"kind": "d1-size-ceiling-check",
			"type": "application/vnd.kody.readiness-evidence+json",
			"uri": "evidence/app-db-size-ceiling.json",
			"sha256": "<LOWERCASE_SHA256_OF_EXACT_ENVELOPE_FILE_BYTES>",
			"sourceIdentity": {
				"accountId": "<SOURCE_ACCOUNT_ID>",
				"resourceId": "<SOURCE_D1_UUID>"
			},
			"destinationIdentity": null,
			"outcome": "passed",
			"verifierIdentity": "<APPROVED_RECOVERY_VERIFIER_ID>",
			"changeId": "<CHANGE_ID>",
			"systemVersion": "<DEPLOYMENT_BUILD_OR_COMMIT>",
			"performedAt": "<UTC_ISO_TIMESTAMP_WITH_MILLISECONDS>"
		}
	]
}
```

Use the resource-specific `requiredEvidenceKinds` in
`tools/disaster-recovery/canonical-readiness.ts`; the example is not a complete
`APP_DB` record. APP_DB requires `inventory`, `source-credential-check`,
`destination-credential-check`, `transfer-support-check`,
`contract-verification`, `d1-size-ceiling-check`, and `d1-restore-drill`. Every
other resource similarly requires all five common kinds plus its
resource-specific drill kinds. Records require nonempty verifier/change/build
identity, `performedAt` not in the future, and `expiresAt` later than both
`performedAt` and the assessment time. Unknown fields, resources, evidence
kinds, duplicate resources, duplicate evidence kinds, malformed dates, and
expired attestations fail the entire input closed.

Each artifact file is an exact, kind-specific signed envelope. For the APP_DB
source-size check, the exact content shape is:

```json
{
	"schemaVersion": 1,
	"content": {
		"changeId": "<CHANGE_ID>",
		"destinationIdentity": null,
		"details": {
			"ceilingBytes": 4500000000,
			"measuredBytes": 123456789,
			"monitoredAt": "<UTC_ISO_TIMESTAMP_WITH_MILLISECONDS>",
			"sourceAccountId": "<SOURCE_ACCOUNT_ID>",
			"sourceDatabaseUuid": "<SOURCE_D1_UUID>"
		},
		"kind": "d1-size-ceiling-check",
		"outcome": "passed",
		"performedAt": "<UTC_ISO_TIMESTAMP_WITH_MILLISECONDS>",
		"resourceId": "APP_DB",
		"sourceIdentity": {
			"accountId": "<SOURCE_ACCOUNT_ID>",
			"resourceId": "<SOURCE_D1_UUID>"
		},
		"systemVersion": "<DEPLOYMENT_BUILD_OR_COMMIT>",
		"uri": "evidence/app-db-size-ceiling.json",
		"verifierIdentity": "<APPROVED_RECOVERY_VERIFIER_ID>"
	},
	"signature": {
		"algorithm": "Ed25519",
		"keyId": "<REVIEWED_TRUSTED_KEY_ID>",
		"value": "<BASE64_64_BYTE_ED25519_SIGNATURE>"
	}
}
```

`ceilingBytes` must be positive and no greater than 4,500,000,000;
`measuredBytes` must be nonnegative and strictly less than `ceilingBytes`.
`monitoredAt` must equal `performedAt`, and the detail account id and database
UUID must equal `sourceIdentity`.

The required APP_DB restore-drill envelope uses the same outer shape and index
matching rules, with a non-null destination identity for the live-created drill
database. Its exact shape is:

```json
{
	"schemaVersion": 1,
	"content": {
		"changeId": "<CHANGE_ID>",
		"destinationIdentity": {
			"accountId": "<DRILL_ACCOUNT_ID>",
			"resourceId": "<LIVE_CREATED_DRILL_D1_UUID>"
		},
		"details": {
			"foreignKeyViolations": 0,
			"quickCheck": "ok",
			"restoredDatabaseUuid": "<LIVE_CREATED_DRILL_D1_UUID>"
		},
		"kind": "d1-restore-drill",
		"outcome": "passed",
		"performedAt": "<UTC_ISO_TIMESTAMP_WITH_MILLISECONDS>",
		"resourceId": "APP_DB",
		"sourceIdentity": {
			"accountId": "<SOURCE_ACCOUNT_ID>",
			"resourceId": "<SOURCE_D1_UUID>"
		},
		"systemVersion": "<DEPLOYMENT_BUILD_OR_COMMIT>",
		"uri": "evidence/app-db-restore-drill.json",
		"verifierIdentity": "<APPROVED_RECOVERY_VERIFIER_ID>"
	},
	"signature": {
		"algorithm": "Ed25519",
		"keyId": "<REVIEWED_TRUSTED_KEY_ID>",
		"value": "<BASE64_64_BYTE_ED25519_SIGNATURE>"
	}
}
```

The signed `restoredDatabaseUuid` must equal `destinationIdentity.resourceId`.
Both the destination account and destination resource must differ from their
source counterparts; a same-account drill or a reused source database UUID fails
readiness even with a valid signature.

Every APP_DB envelope requires `sourceIdentity.accountId` and each non-null
`destinationIdentity.accountId` to be a canonical Cloudflare account ID: exactly
32 lowercase ASCII hexadecimal characters. The parser does not trim or lowercase
these values. Leading, trailing, or internal whitespace, uppercase,
wrong-length, non-hex, and Unicode-lookalike account IDs fail before signature
verification can make the artifact eligible for readiness, even when all index
metadata and exact-byte digests match the re-signed envelope.

Every evidence kind has its own exact `details` keys, types, and passing
constraints in `EvidenceDetailsByKind` and `parseDetails`. Extra or missing
fields fail closed. `inventory`, `source-credential-check`, and
`d1-size-ceiling-check` require a null destination identity; all other kinds
require a non-null destination identity. The full signed content binds the
resource and kind, unique local URI, source and destination identities, literal
`"passed"` outcome, verifier, change, system/build version, and millisecond UTC
timestamp. Index metadata must match those signed fields exactly.

The Ed25519 signature covers canonical JSON containing only `schemaVersion` and
`content`; the envelope's `signature` field is excluded. The index SHA-256
covers the exact envelope file bytes.

Code also owns a non-configurable maximum age measured from `performedAt`,
independent of the supplied `expiresAt`:

- resources first required for `d1-only` (D1) expire after **35 days**;
- resources first required for `canonical-data` expire after **100 days**;
- resources first required for `full-service` expire after **200 days**.

An `expiresAt` farther in the future cannot extend these limits. Conversely,
`expiresAt` can make evidence expire sooner. For example, a full-service report
still requires APP_DB evidence no older than 35 days, canonical-store evidence
no older than 100 days, and derived/operational evidence no older than 200 days.

Every artifact URI must be unique across the whole evidence input and be a local
path (resolved relative to the evidence JSON) or a `file:` URL. The CLI opens
only files whose lexical and real paths remain inside the evidence directory,
blocking `..`, absolute/file-URL, and symlink escape. It hashes exact bytes,
parses the strict envelope, and verifies its Ed25519 signature. Missing,
unreadable, unsigned, unhashed, mismatched, or duplicate-URI files fail
readiness. `https:`, `s3:`, dashboard, ticket, and every other network URI are
rejected; download evidence to an immutable local file before assessment.

The only trust registry is the checked-in
`tools/disaster-recovery/trusted-readiness-public-keys.json`. It is
intentionally empty until recovery-verifier Ed25519 public keys are approved by
code review. The CLI accepts no alternate registry path or key flag. Synthetic
metadata, unsigned evidence, and evidence signed by an operator key that is not
in that checked-in registry cannot produce **READY**. With the registry empty,
every readiness level remains **NOT READY**.

The command prints `d1-only`, `canonical-data`, and `full-service` separately
and exits nonzero until full-service is proven.

## Explicit exclusions

This runbook does not claim or provide:

- continuous replication, zero RPO, zero downtime, or a cross-store atomic
  snapshot;
- proof that any backup job, destination, lock, lifecycle, alert, escrow,
  credential, deployment, evidence set, or drill is live merely because its
  implementation exists;
- D1 availability during export, or a non-destructive Time Travel clone;
- support for a live D1 `file_size` at or above the configurable-but-not-
  raisable 4,500,000,000-byte ceiling, or any signed export, pre-existing
  object, freshness result, or restore input at or above 5 GiB; exactly 5 GiB is
  rejected;
- any operator override that raises the 4,500,000,000-byte source ceiling;
  multipart D1 capture or statement-safe split restore; 10 GB D1 databases and
  logical exports at or above 5 GiB remain unsupported and **NOT READY**;
- import of a raw SQLite file;
- native cross-account replication for D1, R2, Durable Objects, Artifacts, KV,
  Queues, or Workflows;
- runtime-selectable/custom retention or application deletion of backup sets;
  retention is the fixed provisioned R2 lock/lifecycle policy;
- restore-drill import into an operator-supplied existing target UUID, use of
  `--allowlist`, or use of an alternate trust registry; execution creates a new
  database only for an exact account/name in the checked-in drill-target list
  and never in any account in the checked-in production-source list;
- implemented capture automation for canonical `EMAIL_BLOBS`, avatars,
  `StorageRunner`, or Artifacts in the D1 backup control plane;
- backup of Analytics Engine events, transient logs/traces, CDN caches,
  in-memory Durable Object state, active WebSockets/MCP sessions, unknown
  in-flight queue messages, or running Workflow instances;
- portable OAuth/browser sessions, provider grants, refresh tokens, or
  third-party authorization;
- backup of derived Vectorize entries, `BUNDLE_ARTIFACTS_KV`, community icon
  outputs, alarms, queues, or workflow runtime state when their documented
  rebuild path is used;
- plaintext export of saved user secrets or inclusion of
  `SECRET_STORE_KEY`/other credential values in backup media;
- recovery of unreferenced/orphaned objects as user data without a canonical
  owner/reference;
- protection from application-level corruption that predates every retained
  point, malicious source data, compromised code included in the restore, or
  provider-wide/account-wide failure beyond the independently retained copies;
- use of `tools/export-d1-remote-to-sqlite.sh` as a DR control.

## Provider references

Verify these contracts during every quarterly review because provider behavior
and CLI flags can change:

- [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [D1 export REST API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
- [R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [R2 CLI choices](https://developers.cloudflare.com/r2/get-started/cli/)
- [Artifacts authentication](https://developers.cloudflare.com/artifacts/guides/authentication/)
- [SQLite-backed Durable Object storage and PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
