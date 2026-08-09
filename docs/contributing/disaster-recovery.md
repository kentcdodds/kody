# Disaster recovery

Solo-operator runbook for Kody production data. One operator (Kent) owns
enablement, escrow, drills, and restore. The engineering invariants stay
fail-closed: immutable R2 objects, Ed25519-signed manifests, checked-in trust
registries populated only via code review, source/drill identity allowlists, D1
size ceilings, and drill-before-production-restore.

This document describes the designed end state. Treat every checklist item as
unproven until you have live evidence for that item (see the
[live evidence log](#live-evidence-log)). Code-complete packages are not proof
that the DR account, bucket locks, secrets, schedules, Access policy, or escrow
blob are live.

Primary operator surface:

- Admin UI on the backup control-plane Worker (Cloudflare Zero Trust Access +
  in-worker JWT verification) for dashboard, run-backup-now, seal-day, isolated
  restore drill, and graduated production restore.
- Offline CLIs under `tools/disaster-recovery/` when the UI is unavailable (see
  [Offline CLI fallback](#offline-cli-fallback)).
- Destination provisioner: `node tools/ci/backup-resources-cli.ts plan|apply`.

Do not use `tools/export-d1-remote-to-sqlite.sh` as a backup or restore tool.

## Prevention

### Deploy guardrails

`npm run deploy-guardrails:check` protects the reviewed Durable Object migration
and binding baseline in `tools/ci/durable-object-baseline.json`. Every
`deleted_classes` migration must exactly match
`tools/ci/do-deletion-allowlist.json`; changing that allowlist is the explicit
code-review gate for destructive class deletion. The same check rejects removal
or renaming of protected `new_sqlite_classes` tags, changes to protected
Wrangler binding identities (`name`, `class_name`, `script_name`, or
`environment`), and destructive Cloudflare CLI deletion commands in GitHub
workflows unless the job is operator-triggered with `workflow_dispatch`.

## Live evidence log

First-proven dates for each lane (newest first). Re-prove and update after
material schema/storage/pipeline changes; a lane is only as trusted as its most
recent evidence.

| Date (UTC) | Lane proven                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-07 | First stranded staging day recovered and sealed (`daily/full/2026-08-07/manifest.json`, sealedAt 2026-08-07T19:45:16Z, 341 sealed objects). The night ran out of window mid-`artifacts` (progress revision 714, no summary; 06:15 watchdog paged correctly). Recovery resumed the existing `exporter/progress.json` (no staged work purged), staged the ~20 remaining snapshots, wrote `exporter/summary.json` at 19:05:29Z, and the unchanged hourly control-plane seal picked the day up at 19:45. Motivated the daytime catch-up lane and `POST /__maintenance/dr-export` ([#1287](https://github.com/kentcdodds/kody/pull/1287); [#1223](https://github.com/kentcdodds/kody/issues/1223)). |
| 2026-08-07 | Offline escrow unseal smoke test proven with the real `SECRET_ESCROW_PASSPHRASE` against `escrow/secret-store-key.v1.json` ([#1091](https://github.com/kentcdodds/kody/issues/1091)): recovered key matched production `SECRET_STORE_KEY`; wrong passphrase failed cleanly (auth-tag error, no partial output).                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-07-28 | Isolated restore drill green through the product UI against a sealed day (`PRAGMA quick_check` ok, table counts plausible, temp database cleaned up). Required [#1002](https://github.com/kentcdodds/kody/pull/1002): presigned D1 import uploads reject chunked bodies with HTTP 411, so stream uploads go through `FixedLengthStream`.                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-28 | First sealed full-backup day (`daily/full/2026-07-28/manifest.json`). Required [#1000](https://github.com/kentcdodds/kody/pull/1000): bucket-lock rules reject puts on existing keys with error 10069 before conditionals are evaluated, and exporter resume became identity-driven after mid-window inventory drift produced duplicate storage-index entries.                                                                                                                                                                                                                                                                                                                                 |
| 2026-07-28 | First completed staging run (`staging/2026-07-28/exporter/summary.json`; 186 storage dumps, R2 indexes, artifacts index).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-07-26 | First verified nightly D1 export (signed manifest, stored-object digest verified; ~118 MB).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Still unproven live: graduated production restore into the production database
(drill-level evidence only; it shares the `FixedLengthStream` upload path), and
`weekly/` retention aging through its lifecycle.

## Objectives

| Scope                 | RPO    | Notes                                                                                                                                        |
| --------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| All canonical stores  | 24h    | D1, per-user Mailbox graphs, StorageRunner dumps, `EMAIL_BLOBS` / `COMMUNITY_ASSETS` blobs, published package/job source snapshots           |
| Selected RunLog state | 24h    | Never-pruned job observability, package-run success counters, and activation milestones; run history and correctness ledgers remain excluded |
| D1 freshness          | hourly | Control-plane size/ETag freshness; deep checksum via drill                                                                                   |

RTO is whatever the operator can achieve with the UI restore workflow after a
successful sealed-day drill. There is no provider-level cross-store atomic
snapshot. Current production D1 is ~117 MB — far below the 4.5 GB export ceiling
(`BACKUP_MAX_SOURCE_BYTES`, not raisable above 4,500,000,000).

Retention (UTC):

- `daily/` — ~35 days (immutable lock + lifecycle)
- `weekly/` — ~400 days (Sunday UTC D1 exports under `weekly/d1/...`)
- `blobs/sha256/` — long-retention content-addressed store shared across days
- Failed or incomplete sets never replace a sealed day

## Architecture

Two cooperating writers share one locked bucket in the independently
administered **DR (“KCD”) Cloudflare account**:

```text
Production worker (source account)          Backup control plane (DR account)
───────────────────────────────             ────────────────────────────────
Nightly */5 ticks 00:30–06:10 UTC           02:15 UTC: D1 export Workflow
  stage Mailbox / selected RunLog state
  / StorageRunner / R2 / artifacts      →   Hourly: D1 freshness + catch-up
  into staging/{day}/...                    Hourly: seal complete days
Daytime */15 ticks: staging catch-up        Admin UI: drill / production restore
  resume a stranded day (≤2 days back)
06:15 UTC: staging watchdog → Sentry
```

### What intentionally lives on the DR (KCD) account

The DR (“KCD”) Cloudflare account (`a41d50ecaf0ae0f86dd1824ef6729cb2`) is the
old pre-migration production account, kept as the independently administered DR
destination. Production runs on the Kody account
(`a99ee2e72728dd52902ef288b7b1447d`). Future account cleanups must not delete
the kody-named resources below — they are intentional cross-account leftovers.

**DR / backup stack (this runbook):**

- Worker `kody-production-d1-backups` (hourly + nightly crons)
- Workflows `kody-production-d1-backup` and `kody-production-dr-restore`
- Locked R2 bucket `kody-production-backups`
- Custom domain `kody-dr.kentcdodds.com`

**Personal journaling package data** (not platform infrastructure; reached via
API tokens from Kent's personal Kody packages, not Worker bindings):

- D1 `kody-journals`
- Vectorize index `kody-journals`
- R2 buckets `kody-journals` and `kody-journals-backup`

**AI Gateway `kody`** — still used by personal package jobs against that
account's Workers AI. The platform's own `AI_GATEWAY_ID` routes through the
same-named gateway on the production (Kody) account via the Workers AI binding,
which is account-scoped; the two gateways are independent.

A 2026-07-29 cleanup ([#656](https://github.com/kentcdodds/kody/issues/656);
[full audit and deletion record](https://github.com/kentcdodds/kody/issues/656#issuecomment-5122327193))
removed the last orphaned platform leftovers on the KCD account (stale
`kody-capabilities-prod` / `kody-capabilities-preview` Vectorize indexes; the
old production workers, KV namespaces, preview D1, and the `heykody.dev` zone
were already gone or moved).

### Bucket layout

Contract: `packages/shared/src/backup-staging.ts`.

| Prefix                          | Mutability       | Contents                                                                                                  |
| ------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| `daily/d1/...`, `weekly/d1/...` | Immutable        | Signed D1 SQL + schema-v2 D1 manifests                                                                    |
| `staging/{day}/...`             | Mutable          | Production exporter cursor progress, chunked phase output, indexes, NDJSON dumps, `exporter/summary.json` |
| `daily/full/{day}/...`          | Immutable        | Sealed copy of staged indexes/dumps + Ed25519 full-backup manifest                                        |
| `blobs/sha256/{hash}`           | Immutable        | Deduplicated email MIME, community assets, published source snapshots                                     |
| `escrow/`                       | Operator-managed | Sealed `SECRET_STORE_KEY` blob (`escrow/secret-store-key.v1.json`)                                        |

### Capture lanes

1. **D1 (control plane)** — Dedicated Worker/Workflow in
   `packages/backup-control-plane/` calls the production-account D1 export API
   with `CLOUDFLARE_API_TOKEN` (Account D1 Edit), streams SQL into the DR
   bucket, and writes an Ed25519-signed schema-v2 manifest. Gates:
   `ENABLE_PRODUCTION_D1_BACKUPS` and `BACKUP_BENCHMARK_APPROVED` must both be
   exactly `"true"`. Schedule stays inert otherwise.
2. **Other canonical stores (production worker)** — When
   `DR_EXPORT_ENABLED=true` and DR S3 credentials are set, nightly ticks
   (`packages/worker/src/dr/exporter.ts`) stage:
   - **Mailbox** — owner inventory from D1 `users.stable_user_id`, with one
     keyset-paged `Mailbox.exportMailbox` NDJSON dump per owner and a
     checksummed mailbox index. Mailbox is the sole authority for USER email
     threads, messages, attachments, and delivery-event metadata; raw MIME and
     external attachment bytes remain in `EMAIL_BLOBS` and are captured by the
     R2 lane.
   - **Selected RunLog state** — the same owner inventory, with `exportRuns`
     started at its `job-run-observability:` cursor so only the never-pruned
     `job_run_observability`, `package_run_successes`, and
     `activation_milestones` tables are staged. Retained run/log history,
     invocation-ledger rows, and workflow projections are deliberately skipped.
   - **StorageRunner** — platform-wide inventory from D1, NDJSON dump per
     storage identity via `exportStorage`
   - **R2** — `EMAIL_BLOBS` and `COMMUNITY_ASSETS` listed and copied into
     `blobs/sha256/{hash}` with per-bucket NDJSON indexes (objects above 25 MiB
     are skipped with a warning in the staging summary; the same summary also
     warns when a `StorageRunner` dump exceeds the 16 MiB buffer ceiling and is
     skipped — review dashboard warnings before treating a sealed day as
     complete). An object whose key, size, ETag, and uploaded timestamp match
     the latest retained sealed-day index reuses that index entry and
     content-addressed blob without downloading or hashing the source object.
     Missing, malformed, or checksum-mismatched sealed indexes fall back to the
     full download and hash path.
   - **Published artifacts** — `BUNDLE_ARTIFACTS_KV` published source snapshots
     for rows in `entity_sources` with a `published_commit`
   - **Stranded-day catch-up** — a night with more staging work than the
     00:30–06:10 window can hold ends with `exporter/progress.json` but no
     `exporter/summary.json` (a _stranded day_; first hit live on 2026-08-07).
     Outside the nightly window, one tick every 15 minutes scans today plus the
     previous 2 days for progress-without-summary and resumes the most recent
     stranded day under the normal ~20 s budget and progress lease until its
     summary is written. Catch-up is resume-only: a day that never staged
     progress is not started fresh (its dumps would contain current data, not
     that day's). Data staged during catch-up is read at resume time; a slightly
     newer dump is preferred over an unsealable day.
   - **Resumable phase state** — `exporter/progress.json` contains phase
     cursors, counters, bounded index-entry tails, and conditional-write
     revision data. Mailbox, selected RunLog, and StorageRunner dump pages plus
     all phase index entries are written under `exporter/chunks/` as bounded
     NDJSON objects. Finalization reads those chunks and emits the stable
     mailbox, RunLog, storage, R2, and artifact index contracts referenced by
     `exporter/summary.json`. Chunk objects are content-addressed linked lists
     whose head keys and counts live in progress. Stale writers can therefore
     leave only unreferenced chunks; they cannot overwrite chunks selected by a
     newer lease. Progress updates retain `If-Match` ownership semantics.
     Canonical per-day dumps, indexes, and the completion summary are
     create-only; a resumed writer adopts an already completed object instead of
     replacing it. Per-owner Mailbox and RunLog dumps use the same 16 MiB
     admission ceiling and summary-warning behavior as StorageRunner dumps.
3. **Seal** — Control plane verifies staged checksums against
   `staging/{day}/exporter/summary.json`, requires a verified same-day D1
   manifest, copies staged files under `daily/full/{day}/...`, and signs a
   full-backup manifest (`packages/shared/src/backup-full-manifest.ts`). Hourly
   freshness also attempts to seal the last three complete days; the UI can seal
   a day on demand.

### Restore-safe row sizes

D1's import path rejects individual SQL statements above its ~100 KB
statement-length limit (`statement too long: SQLITE_TOOBIG`), and D1 exports
write one INSERT per row — so a single oversized row makes the whole D1 backup
un-importable. This is not hypothetical: drills of the 2026-07-26 production
export failed on oversized `package_invocations.response_json` rows until the
rows were bounded.

- Write paths bound large text columns via
  `packages/shared/src/backup-restore-safety.ts` (64 KiB per column):
  package-invocation replay caches are dropped when oversized, stored email
  bodies are truncated (raw MIME in R2 stays canonical), and `value_set` rejects
  oversized values (use durable storage instead).
- The control plane measures statement lengths while streaming every export and
  writes `<objectKey>.stats.json` beside the SQL. A nonzero
  `oversizedStatementCount` logs `backup-unrestorable-statements` (failure
  status): the backup completes, but treat that day as unrestorable via the
  import API and fix the offending write path.

`TRUSTED_RESTORE_BASELINE_SHA256` is the SHA-256 of the JSON array of sorted
migration filenames at the deployment commit; recompute when adding a migration:

```sh
node -e "const fs=require('node:fs'),{createHash}=require('node:crypto');console.log(createHash('sha256').update(JSON.stringify(fs.readdirSync('packages/worker/migrations').filter(f=>f.endsWith('.sql')).sort())).digest('hex'))"
```

### Derived and accepted-loss stores

Restore rebuilds the derived stores below; do not treat them as recovery media:

- Vectorize (`CAPABILITY_VECTOR_INDEX`) — reindex
- OAuth KV / browser sessions / provider tokens — users reconnect
- Queues, Workflow instances, Durable Object alarms — recreate from config + D1
- Derived community icons and ordinary KV caches
- **UserMeter** — daily entitlement counters self-prune and can be
  re-established by traffic; authoritative storage-byte state is corrected by
  the revision-guarded physical-storage reconciliation lane. Package-service
  running state is ephemeral and services must be restarted/reconciled after an
  incident. Losing UserMeter state can temporarily undercount usage or require
  service restart, but it does not lose stored user content; this is accepted
  rather than adding a nightly UserMeter dump lane.
- **RunLog run history** — per-user runs and console lines have ~30-day
  self-enforced retention and remain accepted observability loss. Account
  export/deletion still cover them for user-facing portability and purge.
  Nightly DR starts `exportRuns` at `job-run-observability:` and therefore
  captures only job observability, package-run success counters, and activation
  milestones.

  **Known risk — keyed invocation idempotency ledger:** the same `RunLog` DO
  also holds the keyed package-invocation idempotency ledger (claims + 90-day
  terminal replay responses). There is no D1 `package_invocations` table; the DO
  is the only store. Losing the DO therefore loses idempotency/replay state, not
  just observability: webhook providers and other keyed callers that retry
  deliveries would **re-execute** invocations whose keys were already terminal,
  and in-flight replays would return fresh executions instead of stored
  responses. This is accepted with eyes open: lost rows are gone — later traffic
  re-establishes claims only for keys used after the loss, it does not restore
  protection for keys used before it. The blast radius is duplicate side effects
  (a loss of correctness state) bounded by the 90-day retention window; no
  stored user content is lost. The DO ledger is not part of DR media, and D1
  backups do not carry any invocation ledger.

- **RunLog workflow projections** — correctness projections are also before the
  selective export cursor and remain excluded. Incident handling must treat
  in-flight workflow state as lost and restart or reconcile affected workflows.
- **`AUDIT_DB`** — the separate D1 database containing hashed security audit
  events with 180-day retention has no cross-account backup lane. This is
  **accepted-unprotected** operator/security evidence, not user content
  (confirmed 2026-08-07): losing the retained audit trail in a DR account-loss
  event is acceptable; new events accumulate again after restore. Revisit only
  if forensics retention across account loss becomes a requirement.

### Honest gaps

- **Artifacts Git history** is not mirrored. Only published source snapshots in
  `BUNDLE_ARTIFACTS_KV` are staged. Full repo history is not restorable from
  backup media.
- **Unpublished / in-progress repo-session work** is not exported.
- **Mailbox restore is manual.** Staging and sealing protect the authoritative
  graph and verify every owner dump against the mailbox index, but the normal
  production restore handler does not yet import Mailbox rows. Automated,
  resumable Mailbox re-import is tracked as a follow-up under
  [#1223](https://github.com/kentcdodds/kody/issues/1223).
- **StorageRunner restore is replace-per-bucket** (`importStorage` mode
  `replace`): each inventoried storage id is cleared and rewritten from the
  sealed dump. Storage ids absent from the inventory are not deleted by restore.
- R2 restore puts sealed objects back by key; it does not sweep orphans that
  appeared after the sealed day.
- **StorageRunner inventory** unions authoritative D1 sources: `jobs`,
  `archived_job_artifacts`, the `user_storage_buckets` registry (including
  ad-hoc / execute buckets), and `package_service_states` (projected service
  storage ids). Platform DR has only a `D1Database`, so it does **not** walk
  package manifests. A service whose Durable Object never projected into
  `package_service_states` is therefore absent from sealed-day inventory until
  it heartbeats or transitions; account deletion/export cover those via manifest
  enumeration. Buckets known only inside a user's `RunLog` (and never registered
  in `user_storage_buckets` or an entity table) remain outside DR inventory by
  design; the selective RunLog lane does not export run-associated storage ids.

## Credentials and Access

No single credential should both erase production and erase the retained backup.

| Credential                   | Where                                                                                       | Purpose                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Source Account D1 Edit token | Control-plane secret `CLOUDFLARE_API_TOKEN`                                                 | D1 export + production D1 import                               |
| DR R2 provisioner token      | Operator env only (`backup-resources-cli`)                                                  | Bucket / lock / lifecycle setup — never a Worker secret        |
| Production → DR S3 keys      | Production Worker secrets `DR_BACKUP_ACCESS_KEY_ID` / `DR_BACKUP_SECRET_ACCESS_KEY`         | Stage into the DR bucket                                       |
| Drill D1 Edit token          | Control-plane secret `DRILL_API_TOKEN`                                                      | Create/import/query/delete drill D1 in `DRILL_ACCOUNT_ID` only |
| Restore confirm HMAC         | Control-plane secret `RESTORE_CONFIRM_SECRET`                                               | Short-lived (10 min) prepare→execute token                     |
| Production restore bearer    | Both sides: `DR_RESTORE_SECRET`                                                             | Control plane → `POST /__maintenance/dr-restore`               |
| Manifest signing key         | Control-plane secret `BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64`                     | Sign D1 + full manifests                                       |
| Escrow passphrase            | Operator password manager only (`SECRET_ESCROW_PASSPHRASE` in GitHub for the seal workflow) | Unseal `SECRET_STORE_KEY`                                      |

Admin UI auth is dual-layer:

1. Cloudflare Zero Trust Access in front of the control-plane Worker (policy
   pinned to `me@kentcdodds.com`).
2. In-worker verification of `Cf-Access-Jwt-Assertion` against the team JWKS,
   requiring `ACCESS_TEAM_DOMAIN`, `ACCESS_APP_AUD`, and `ACCESS_ALLOWED_EMAIL`
   (same allowlisted address). Mutating POSTs also require
   `Sec-Fetch-Site: same-origin`.

The control-plane Worker deploys to the DR account from GitHub Actions
(`.github/workflows/deploy.yml` → `deploy-backup-control-plane`) using
`DR_DEPLOY_TOKEN`, when `packages/backup-control-plane/` or shared backup
contracts change on `main` (or on manual `workflow_dispatch`). Local Wrangler
against the DR account remains available for emergencies
(`npm run backup:deploy`). Production restore requires the DR Worker to hold the
production-account D1 token as above; Access + JWT guard every UI action that
could use it.

## Secret escrow

`SECRET_STORE_KEY` is the AES-GCM KEK for saved secrets in D1. Restoring D1
without the exact key makes ciphertext unreadable. The plaintext key lives in
GitHub Actions secrets and the deployed production Worker; it must also be
recoverable if those are lost.

Escrow model (solo):

1. Operator passphrase lives only in the personal password manager (also stored
   as GitHub secret `SECRET_ESCROW_PASSPHRASE` for the seal workflow).
2. Manual `workflow_dispatch` of `.github/workflows/dr-escrow.yml` seals the key
   with PBKDF2-SHA-256 (600k iterations) + AES-256-GCM and uploads
   `escrow/secret-store-key.v1.json` to the DR bucket
   (`tools/disaster-recovery/seal-escrow.ts`). The escrow object is write-once;
   after a `SECRET_STORE_KEY` rotation, bump `ESCROW_KEY_VERSION` (for example
   `v2`) when re-sealing — see [Secret rotation](./secret-rotation.md).
3. Dashboard presence does not prove that the passphrase recovers the key. Copy
   the sealed blob to an offline environment and run:

   ```sh
   node tools/disaster-recovery/unseal-escrow.ts \
     --input /secure/input/secret-store-key.v1.json \
     --output /secure/output/secret-store-key
   ```

   The tool reads `SECRET_ESCROW_PASSPHRASE` or prompts without echo. It creates
   the output with mode `0600`, refuses repository paths and existing files, and
   emits no secret metadata. The output parent directory must already exist.
   `ESCROW_INPUT_PATH` and `ESCROW_OUTPUT_PATH` are the environment equivalents
   of the two flags. Omit `--output` only when writing the recovered key
   directly to stdout is intentional. To read from the DR bucket instead of a
   local file, omit `--input`, set the DR bucket credentials, and select the
   sealed object with `ESCROW_KEY_VERSION` (default `v1`).

Never put the plaintext key or passphrase in manifests, tickets, logs, or the
backup SQL. See [Secret rotation](./secret-rotation.md).

## Admin UI

Routes (all require Access JWT):

| Method | Path                       | Action                                                                                                                             |
| ------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/`                        | Dashboard: enable gates, source identity, live D1 size, escrow presence, 14-day D1/staging/seal status with signature verification |
| `POST` | `/actions/run-backup`      | Enqueue today's D1 backup Workflow (respects enable gates)                                                                         |
| `POST` | `/actions/seal-day`        | Verify staging + D1 manifest and seal `daily/full/{day}/...`                                                                       |
| `POST` | `/actions/run-drill`       | Isolated restore drill (fresh D1 in `DRILL_ACCOUNT_ID`, never production)                                                          |
| `POST` | `/actions/restore/prepare` | Validate sealed day; issue 10-minute HMAC confirm token                                                                            |
| `POST` | `/actions/restore/execute` | Require typed exact `SOURCE_DATABASE_NAME` + valid token; start restore Workflow                                                   |
| `GET`  | `/restore-status?id=...`   | Poll restore Workflow status                                                                                                       |

### Isolated restore drill

Creates `kody-dr-drill-{day}-{hex}` in `DRILL_ACCOUNT_ID` (must differ from
`SOURCE_ACCOUNT_ID`), imports the day's signed D1 SQL, runs
`PRAGMA quick_check`, samples table counts, then deletes the drill database on
success (keeps it on failure for inspection). This path does not restore
StorageRunner/R2/artifacts into production.

D1 remote import enforces foreign keys while applying `CREATE TABLE`, but
Cloudflare exports are not topologically ordered. Before upload, the control
plane verifies the unmodified SQL MD5 against the signed manifest R2 ETag, then
prefixes `PRAGMA foreign_keys=OFF;` and uses the prepared body's MD5 for the D1
import init/ingest etag. Without that prelude, drills fail with errors like
`no such table: main.users`.

### Graduated production restore

1. **Prepare** — sealed full manifest + D1 manifest signatures must verify; UI
   shows SQL key/bytes/sha256 and a short-lived confirm token.
2. **Execute** — operator types the exact production database name; Workflow
   `kody-production-dr-restore` imports SQL into production D1 via the
   Cloudflare API, then loops chunked
   `POST {PRIMARY_WORKER_ORIGIN}/__maintenance/dr-restore` with
   `Authorization: Bearer {DR_RESTORE_SECRET}` until the production worker
   reports `done` (StorageRunner replace, R2 put, published snapshot KV put).
3. **Mailbox re-import** — with ingress still disabled, run the automated
   Mailbox importer below for the intended owners. Do not re-enable ingress
   unless its final response has both `"done": true` and `"verified": true`.

Disable ingress / put the app in maintenance before execute. After restore:
reindex Vectorize, re-arm jobs/alarms from D1, recreate queues from Wrangler
config, and expect users to reauthorize OAuth and remote connectors.

### Durable Object point-in-time recovery

Use Durable Object (DO) PITR for an application bug or corruption inside one
**surviving** SQLite-backed object. It restores that object's complete SQLite
database, including SQL tables and key-value storage, to an approximate point
within Cloudflare's rolling 30-day history. It is not a replacement for sealed
backups: if an object or its class was deleted, use backup media where that
class is covered. Deleting a Durable Object class destroys its PITR history and
makes this procedure impossible.

The operator endpoint is production-only infrastructure, is not registered on
user, MCP, or package surfaces, and reuses `DR_RESTORE_SECRET`. Disable ingress
or otherwise stop writes to the affected user before recovery. Supply the user's
exact `stable_user_id`, not username, email, or a D1 numeric id. Valid `kind`
values are `mailbox`, `run-log`, `user-meter`, and `storage-runner`;
`storage-runner` also requires its exact storage id.

1. Resolve a bookmark for the incident timestamp. Cloudflare returns the
   bookmark nearest that time:

   ```sh
   USER_ID='EXACT_STABLE_USER_ID'
   INCIDENT_AT='YYYY-MM-DDTHH:MM:SSZ'
   INCIDENT_TIMESTAMP_MS="$(
     node -e 'const ms=Date.parse(process.argv[1]);if(!Number.isFinite(ms))process.exit(1);console.log(ms)' \
       "$INCIDENT_AT"
   )"
   curl --fail-with-body \
     --request POST "$PRIMARY_WORKER_ORIGIN/__maintenance/do-pitr" \
     --header "Authorization: Bearer $DR_RESTORE_SECRET" \
     --header "Content-Type: application/json" \
     --data @- <<JSON
     {
       "operation": "get-recovery-bookmark",
       "kind": "mailbox",
       "userId": "$USER_ID",
       "timestampMs": $INCIDENT_TIMESTAMP_MS
     }
   JSON
   ```

   For StorageRunner, add `"storageId": "EXACT_STORAGE_ID"`. Keep the returned
   `bookmark` in the incident record and inspect it before the destructive step.

2. Schedule the restore. The object logs the undo bookmark as a structured
   `do-pitr-restore-scheduled` event, returns it as `undoBookmark`, and resets
   immediately so the next object session applies the restore:

   ```sh
   BOOKMARK='BOOKMARK_FROM_STEP_1'
   curl --fail-with-body \
     --request POST "$PRIMARY_WORKER_ORIGIN/__maintenance/do-pitr" \
     --header "Authorization: Bearer $DR_RESTORE_SECRET" \
     --header "Content-Type: application/json" \
     --data @- <<JSON
     {
       "operation": "restore-to-bookmark",
       "kind": "mailbox",
       "userId": "$USER_ID",
       "bookmark": "$BOOKMARK"
     }
   JSON
   ```

   Copy `undoBookmark` immediately and verify the affected object's state before
   restoring ingress. The operator log (`event=do-pitr-operator-restore`)
   includes the operation id, exact object identity, target bookmark, and undo
   bookmark. PITR is unavailable in local development and Workers unit-test
   emulation; the endpoint reports `pitr-unavailable` there.

3. To undo the recovery, repeat step 2 against the same exact object identity,
   using the saved `undoBookmark` as `bookmark`. The undo itself returns a new
   undo bookmark; retain that handle too. Do not assume logs from the restored
   object's own historical storage contain the handle—the structured platform
   log and the operator response are the recovery record.

### Automated Mailbox re-import

`POST /__maintenance/dr-mailbox-import` is the normal recovery path after
object/class/account loss. It is `DR_RESTORE_SECRET`-gated, verifies the sealed
full-manifest signature, verifies the mailbox index bytes and SHA-256, and
verifies each selected owner dump's bytes and SHA-256 before writing that owner.
Each tick writes parent threads, then messages with attachments through
`upsertMessageGraph`, then delivery events through `upsertDeliveryEvents`.
Returned cursors are authenticated and bound to the day, owner selection,
conflict policy, and drill flag; repeat the same request with `cursor` until
`done`.

Keep ingress disabled and complete the signed D1 plus R2 restore first. Select
specific stable owner ids with an array, or explicitly select every index owner
with `"all-from-index"`:

```sh
set -euo pipefail

DAY='YYYY-MM-DD'
CURSOR=''
while :; do
  BODY="$(
    DAY="$DAY" CURSOR="$CURSOR" node -e '
      const body = {
        day: process.env.DAY,
        owners: "all-from-index",
        conflictPolicy: "refuse",
      }
      if (process.env.CURSOR) body.cursor = process.env.CURSOR
      process.stdout.write(JSON.stringify(body))
    '
  )"
  if ! RESPONSE="$(
    curl --fail-with-body --silent --show-error \
      --request POST "$PRIMARY_WORKER_ORIGIN/__maintenance/dr-mailbox-import" \
      --header "Authorization: Bearer $DR_RESTORE_SECRET" \
      --header "Content-Type: application/json" \
      --data "$BODY"
  )"; then
    printf 'mailbox import request failed; stopping\n%s\n' "$RESPONSE" >&2
    exit 1
  fi
  printf '%s\n' "$RESPONSE"
  DONE="$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x.done===true))' "$RESPONSE")"
  if [ "$DONE" = true ]; then
    break
  fi
  if ! CURSOR="$(node -e 'const x=JSON.parse(process.argv[1]);if(!x.nextCursor)process.exit(1);process.stdout.write(x.nextCursor)' "$RESPONSE")"; then
    printf 'response is not done and has no nextCursor; stopping\n' >&2
    exit 1
  fi
done
```

The default conflict policy refuses an owner whose target Mailbox is non-empty.
Destructive replacement requires both `"conflictPolicy": "replace"` and the
separate exact confirmation
`"replaceConfirmation": "PURGE NON-EMPTY TARGET MAILBOXES"`. The importer never
calls `purge` without both. Review that change to the request as a destructive
restore step; keep the same fields on every resumed request. Before purging a
non-empty target, the importer first replays and count-verifies the complete
dump through a reserved scratch preflight object. Preflight and drill writes do
not arm normal Mailbox alarms; a verified production target is finalized only
after count parity succeeds.

For a drill, use explicit owner ids and add `"drill": true`. The importer
derives reserved scratch owner ids under `__mailbox-drill__:` and rewrites only
owner-bound blob references for those scratch objects; it never opens the real
owners' Mailbox objects. A successful drill still verifies the signed media,
exercises every graph upsert, and requires per-kind `countMailbox` parity. Drill
objects are inert test data and do not imply that their rewritten blob keys
exist. After collecting the per-kind count result, the importer atomically
purges all imported mail rows and retains only a non-sensitive count marker for
idempotent replay; cleanup failure fails the operation so a full mail copy
cannot be left silently. Use the same separately confirmed replace policy only
when recovering a scratch object left by an interrupted older run.

Every completed owner appears in `ownerResults` with expected and actual thread,
message, attachment, and delivery-event counts. Any mismatch leaves
`"verified": false` and is also reported in `warnings`; this operation never
enables ingress. Once target writes begin, normal Mailbox reads remain blocked
until count parity finalizes that owner; a failed or mismatched owner stays
blocked for safe operator recovery. Preserve all responses in the incident
record.

### Manual Mailbox re-import (fallback)

Prefer
[Durable Object point-in-time recovery](#durable-object-point-in-time-recovery)
when the Mailbox object survives and the target is still inside Cloudflare's
30-day history. If the automated importer is unavailable, use this procedure as
the correctness spec and incident-only fallback:

1. Keep ingress disabled and complete the signed D1 plus R2 restore first, so
   every raw MIME and external-attachment key referenced by Mailbox rows exists.
2. Verify the full-manifest signature and the sealed mailbox-index byte count
   and SHA-256. For every owner entry, verify the NDJSON object's byte count and
   SHA-256 before reading any rows. Do not mutate production during a manual
   drill.
3. Build and review an incident-only maintenance command from the restored
   commit. For each `ownerId`, stream that owner's dump into a new or confirmed
   empty `Mailbox` object. Recreate threads and messages with their attachments
   through `upsertMessageGraph`, then delivery events through
   `upsertDeliveryEvents`. Preserve the exported ids and timestamps, process
   parents before children, and never call `purge` on an existing object without
   a separately reviewed destructive-restore plan.
4. Compare `countMailbox` with the dump's per-kind counts, then spot-check
   inbound raw MIME and external attachments through normal reads. Re-enable
   ingress only after every intended owner passes.

## Schedules and freshness

| When (UTC)                       | Who               | What                                                                                                                     |
| -------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `*/5` during 00:30–06:10         | Production worker | Stage Mailbox, selected RunLog state, and other non-D1 stores for the current UTC day (cheap no-op once complete)        |
| Every 15 min outside 00:30–06:10 | Production worker | Staging catch-up: resume the most recent stranded day (progress without summary, today − ≤2 days); cheap no-op otherwise |
| 06:15                            | Production worker | Staging watchdog: a missing `exporter/summary.json` for today, or an earlier stranded day, fails the lane → Sentry       |
| 02:15                            | Control plane     | Primary D1 export Workflow                                                                                               |
| 02:45–05:45 hourly               | Control plane     | Catch-up create/restart of same-day D1 Workflow                                                                          |
| Hourly `:45`                     | Control plane     | D1 freshness (identity, size ceiling, manifest age ≤26h, R2 size/ETag) + seal recent complete days                       |

### Stranded staging days (manual finish)

Failure mode: the nightly exporter hard-stops when the window closes, so a night
with too much work leaves `staging/{day}/exporter/progress.json` without
`exporter/summary.json`. The 06:15 watchdog pages; without a summary the day can
never seal. Daytime catch-up ticks (table above) normally finish the day
automatically within a few hours, and the hourly control-plane seal (3-day
lookback) then seals it — no operator action needed.

Operate manually when catch-up is stuck, the day has already fallen outside the
catch-up lookback, or you want the day finished immediately:

```sh
DAY='YYYY-MM-DD'
curl --fail-with-body \
  --request POST "$PRIMARY_WORKER_ORIGIN/__maintenance/dr-export" \
  --header "Authorization: Bearer $DR_RESTORE_SECRET" \
  --header "Content-Type: application/json" \
  --data "{\"day\": \"$DAY\"}"
```

Each request runs up to 5 resume ticks (`maxTicks`, 1–10) with the normal ~20 s
budget and lease semantics, so it is safe alongside scheduled catch-up ticks.
Repeat until the response reports `"summaryWritten": true` (or
`"reason": "already-complete"`). The endpoint is resume-only: a day with no
staged progress returns `"reason": "no-staged-progress"` instead of starting a
fresh export for a past day. After the summary exists, the next hourly
control-plane seal covers the day if it is within the 3-day seal lookback;
otherwise seal it from the admin UI (`POST /actions/seal-day`).

Hourly freshness does not SHA-256 the SQL bytes; drills do. Page yourself on
`freshness-unrestorable` (the SQL contains statements D1 cannot import),
`freshness-stale`, size-ceiling hits, missing manifests or required SQL stats,
seal failures, `backup-unrestorable-statements`, or unexpected disablement of
the enable gates. Unrestorable exports never receive a canonical day manifest;
catch-up retries can re-export the day after the oversized row or write path is
bounded. Older unrestorable days may already have canonical and full manifests;
immutable media is intentionally left unchanged, so freshness, dashboard, drill,
and production-restore gates remain essential until it ages out.

## Offline CLI fallback

The UI is the primary drill/restore path. Keep the CLIs for air-gapped or
UI-down recovery:

- `node tools/disaster-recovery/d1-restore-drill-cli.ts` — isolated D1 import
  against checked-in identity/baseline/manifest-key registries
- `node tools/disaster-recovery/canonical-readiness-cli.ts` — fail-closed
  readiness assessment from local Ed25519 evidence envelopes
- `node tools/disaster-recovery/seal-escrow.ts` — same seal used by
  `dr-escrow.yml` (also runnable locally with env vars)
- `node tools/disaster-recovery/unseal-escrow.ts` — authenticated recovery from
  a local sealed blob or the DR bucket; writes only to stdout or a new file
  outside the repository

Details:
[`tools/disaster-recovery/readme.md`](../../tools/disaster-recovery/readme.md).
Trust registries are populated only by code review, and the guardrail test in
`restore-trust-and-verification.node.test.ts` pins their exact contents.
`trusted-d1-restore-identities.json` and
`trusted-backup-manifest-public-keys.json` carry the live reviewed production
identity, drill target, and manifest verifying key.
`trusted-restore-baselines.json` and `trusted-readiness-public-keys.json` remain
empty, which keeps CLI baseline verification and CLI readiness fail-closed
(**NOT READY**) — the UI drill and sealing flows are the primary operational
paths.

Known v1 restore-shape limits (documented, not bugs): R2 restore is put-only
(objects created after the backup day are not deleted by a restore), and the
`staging/{day}` → `daily/full/{day}` key layouts plus the `userId/storageId`
dump identity encoding are load-bearing for bucket lock and lifecycle rules —
changing them requires a reviewed migration of the bucket layout.

## Solo enablement checklist

Work top-to-bottom. Leave gates false until the matching gate item is done.

### 1. Accounts and destination

- [ ] DR Cloudflare account exists and is administered separately from
      production.
- [ ] Production source identities recorded: account id, D1 UUID, exact database
      name (`kody`), Worker origin, R2 bucket names.
- [ ] Drill account id differs from production; recorded as `DRILL_ACCOUNT_ID`.
- [ ] Provisioner plan/apply creates the private DR bucket with `daily/` (35d)
      and `weekly/` (400d) lock/lifecycle rules; provisioner token never becomes
      a Worker secret.
- [ ] Checked-in CLI trust registries populated via code review when you want
      offline drills/readiness (optional if UI-only, recommended).

### 2. Manifest keys and Access

- [ ] Ed25519 manifest keypair generated; public SPKI + key id committed as
      reviewed vars; private PKCS#8 only as control-plane Worker secret.
- [ ] Trusted restore baseline id/digest vars match the checked-in baseline
      registry entry you intend to use.
- [ ] Zero Trust Access application fronts the control-plane hostname; policy
      allows only `me@kentcdodds.com`; `ACCESS_*` vars match that app.
- [ ] Control-plane secrets set: `CLOUDFLARE_API_TOKEN`,
      `BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64`, `DRILL_API_TOKEN`,
      `RESTORE_CONFIRM_SECRET`, `DR_RESTORE_SECRET`.

### 3. Deploy control plane (still gated off)

- [ ] Placeholders in `packages/backup-control-plane/wrangler.jsonc` replaced;
      both enable vars remain `"false"`.
- [ ] `DR_DEPLOY_TOKEN` is set; optional R2-admin `DR_BACKUP_ADMIN_TOKEN`
      reconciles policy when accessible and logs a non-blocking skip otherwise;
      the control plane deploys to the DR account; `BACKUP_BUCKET` bound;
      Workflows `kody-production-d1-backup` and `kody-production-dr-restore`
      present; public bucket access off.
- [ ] UI loads only through Access; unauthenticated and wrong-email JWTs
      get 403.

### 4. Production exporter wiring

- [ ] Production Worker vars/secrets: `DR_EXPORT_ENABLED` (leave unset/false
      until ready), `DR_BACKUP_ACCOUNT_ID`, `DR_BACKUP_BUCKET_NAME`,
      `DR_BACKUP_ACCESS_KEY_ID`, `DR_BACKUP_SECRET_ACCESS_KEY`,
      `DR_RESTORE_SECRET` (same value as control plane).
- [ ] Control plane `PRIMARY_WORKER_ORIGIN` points at production.
- [ ] One manual/nightly staging run writes
      `staging/{day}/exporter/summary.json` with acceptable warnings; verify the
      mailbox and RunLog indexes and at least one referenced owner dump against
      the recorded byte count and SHA-256.

### 5. Benchmark and enable D1 schedule

- [ ] Controlled D1 export benchmark at production scale: unavailable time,
      bytes (~117 MB today), hashes, no overlap, download inside URL lifetime;
      live `file_size` strictly below 4.5 GB.
- [ ] Isolated UI drill (or CLI) passes `PRAGMA quick_check` for that export.
- [ ] Set `BACKUP_BENCHMARK_APPROVED` and `ENABLE_PRODUCTION_D1_BACKUPS` to
      `"true"` and redeploy control plane.
- [ ] Observe 02:15 enqueue, hourly freshness success, and first sealed day
      after staging completes.

### 6. Escrow and ongoing drills

- [x] `SECRET_ESCROW_PASSPHRASE` in password manager + GitHub secret; run
      `dr-escrow.yml`; dashboard shows escrow present; run
      `node tools/disaster-recovery/unseal-escrow.ts --input <sealed-blob> --output <secure-path>`
      against the sealed blob with the real passphrase, offline (proven
      2026-08-07 — see live evidence log /
      [#1091](https://github.com/kentcdodds/kody/issues/1091)).
- [ ] Set `DR_EXPORT_ENABLED=true` in production after staging path is proven.
- [ ] Monthly: UI isolated D1 drill on a retained day; confirm alert paths for
      freshness failures.
- [ ] Quarterly: seal verification + verify every Mailbox owner dump against its
      sealed index + spot-check StorageRunner/R2/artifact restore into a
      non-production target (or full UI production restore only during a real
      incident after a fresh drill on that day).
- [ ] After material schema/storage/encryption changes: extra drill before
      trusting the newest sealed day.

## Explicit exclusions

- Continuous replication, zero RPO, or cross-store atomic snapshots
- Live proof of deployment/locks/escrow merely because code exists
- D1 availability during export; non-destructive Time Travel clone
- D1 `file_size` ≥ 4.5 GB or any export/restore object ≥ 5 GiB (rejected)
- Multipart D1 capture / statement-safe split restore
- Full Artifacts Git history or unpublished repo-session work
- Backup of Vectorize, OAuth KV, queues, Workflow runtime, alarms (rebuild)
- Backup of `RunLog` run records and logs (observability; ~30 day DO
  self-retention), invocation idempotency ledger, and workflow projections;
  never-pruned job observability and activation state are backed up
- Automated Mailbox re-import (sealed dumps are manually recoverable)
- Backup of UserMeter (reconciliation/restart is the accepted recovery path)
- Backup of `AUDIT_DB` hashed audit events (180-day evidence;
  accepted-unprotected 2026-08-07 — operator confirmed no backup lane for now)
- Plaintext `SECRET_STORE_KEY` or other credentials inside backup media
- Using `tools/export-d1-remote-to-sqlite.sh` as DR

## Provider references

- [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [D1 export REST API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
- [R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
- [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
