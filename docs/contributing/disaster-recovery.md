# Disaster recovery

Solo-operator runbook for Kody production data. One operator (Kent) owns
enablement, escrow, drills, and restore. The engineering invariants stay
fail-closed: immutable R2 objects, Ed25519-signed manifests, checked-in trust
registries populated only via code review, source/drill identity allowlists, D1
size ceilings, and drill-before-production-restore.

This document describes the designed end state. Treat every checklist item as
unproven until you have live evidence for that item. Code-complete packages are
not proof that the DR account, bucket locks, secrets, schedules, Access policy,
or escrow blob are live.

Primary operator surface:

- Admin UI on the backup control-plane Worker (Cloudflare Zero Trust Access +
  in-worker JWT verification) for dashboard, run-backup-now, seal-day, isolated
  restore drill, and graduated production restore.
- Offline CLIs under `tools/disaster-recovery/` when the UI is unavailable (see
  [Offline CLI fallback](#offline-cli-fallback)).
- Destination provisioner: `node tools/ci/backup-resources-cli.ts plan|apply`.

Do not use `tools/export-d1-remote-to-sqlite.sh` as a backup or restore tool.

## Objectives

| Scope                | RPO    | Notes                                                                                                     |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| All canonical stores | 24h    | D1, StorageRunner dumps, `EMAIL_BLOBS` / `COMMUNITY_ASSETS` blobs, published package/job source snapshots |
| D1 freshness         | hourly | Control-plane size/ETag freshness; deep checksum via drill                                                |

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
  stage StorageRunner / R2 / artifacts  →   Hourly: D1 freshness + catch-up
  into staging/{day}/...                    Hourly: seal complete days
06:15 UTC: staging watchdog → Sentry        Admin UI: drill / production restore
```

### Bucket layout

Contract: `packages/shared/src/backup-staging.ts`.

| Prefix                          | Mutability       | Contents                                                                     |
| ------------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| `daily/d1/...`, `weekly/d1/...` | Immutable        | Signed D1 SQL + schema-v2 D1 manifests                                       |
| `staging/{day}/...`             | Mutable          | Production exporter progress, indexes, NDJSON dumps, `exporter/summary.json` |
| `daily/full/{day}/...`          | Immutable        | Sealed copy of staged indexes/dumps + Ed25519 full-backup manifest           |
| `blobs/sha256/{hash}`           | Immutable        | Deduplicated email MIME, community assets, published source snapshots        |
| `escrow/`                       | Operator-managed | Sealed `SECRET_STORE_KEY` blob (`escrow/secret-store-key.v1.json`)           |

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
   - **StorageRunner** — platform-wide inventory from D1, NDJSON dump per
     storage identity via `exportStorage`
   - **R2** — `EMAIL_BLOBS` and `COMMUNITY_ASSETS` listed and copied into
     `blobs/sha256/{hash}` with per-bucket NDJSON indexes (objects above 25 MiB
     are skipped with a warning in the staging summary; the same summary also
     warns when a `StorageRunner` dump exceeds the 16 MiB buffer ceiling and is
     skipped — review dashboard warnings before treating a sealed day as
     complete)
   - **Published artifacts** — `BUNDLE_ARTIFACTS_KV` published source snapshots
     for rows in `entity_sources` with a `published_commit`
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
  status): the backup still lands, but treat that day as unrestorable via the
  import API and fix the offending write path.

`TRUSTED_RESTORE_BASELINE_SHA256` is the SHA-256 of the JSON array of sorted
migration filenames at the deployment commit; recompute when adding a migration:

```sh
node -e "const fs=require('node:fs'),{createHash}=require('node:crypto');console.log(createHash('sha256').update(JSON.stringify(fs.readdirSync('packages/worker/migrations').filter(f=>f.endsWith('.sql')).sort())).digest('hex'))"
```

### Derived stores (not backed up)

Restore rebuilds these; do not treat them as recovery media:

- Vectorize (`CAPABILITY_VECTOR_INDEX`) — reindex
- OAuth KV / browser sessions / provider tokens — users reconnect
- Queues, Workflow instances, Durable Object alarms — recreate from config + D1
- Derived community icons and ordinary KV caches
- **RunLog / run records** — per-user execution history (runs + console log
  lines) lives in the `RunLog` Durable Object with ~30 day self-enforced
  retention. It is observability data, not a canonical store. The production DR
  exporter stages a fixed set of stores (StorageRunner NDJSON, R2 blob indexes,
  published artifact snapshots) and does **not** enumerate or dump `RunLog`.
  Account export/deletion cover run records for user-facing portability and
  purge; disaster recovery deliberately does not.

### Honest gaps

- **Artifacts Git history** is not mirrored. Only published source snapshots in
  `BUNDLE_ARTIFACTS_KV` are staged. Full repo history is not restorable from
  backup media.
- **Unpublished / in-progress repo-session work** is not exported.
- **StorageRunner restore is replace-per-bucket** (`importStorage` mode
  `replace`): each inventoried storage id is cleared and rewritten from the
  sealed dump. Storage ids absent from the inventory are not deleted by restore.
- R2 restore puts sealed objects back by key; it does not sweep orphans that
  appeared after the sealed day.
- **StorageRunner inventory** unions authoritative D1 sources: `jobs`,
  `archived_job_artifacts`, `saved_packages` (app packages), the
  `user_storage_buckets` registry (including ad-hoc / execute buckets), and
  `package_service_states` (projected service storage ids). Platform DR has only
  a `D1Database`, so it does **not** walk package manifests or enumerate
  `RunLog` Durable Objects. A service whose Durable Object never projected into
  `package_service_states` is therefore absent from sealed-day inventory until
  it heartbeats or transitions; account deletion/export cover those via manifest
  enumeration. Buckets known only inside a user's `RunLog` (and never registered
  in `user_storage_buckets` or an entity table) remain outside DR inventory by
  design — RunLog is observability, not a canonical store.

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
   (`tools/disaster-recovery/seal-escrow.ts`).
3. Dashboard shows whether the escrow object is present (not whether the
   passphrase still works — test unsealing offline after each seal).

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

Disable ingress / put the app in maintenance before execute. After restore:
reindex Vectorize, re-arm jobs/alarms from D1, recreate queues from Wrangler
config, and expect users to reauthorize OAuth and remote connectors.

## Schedules and freshness

| When (UTC)               | Who               | What                                                                                               |
| ------------------------ | ----------------- | -------------------------------------------------------------------------------------------------- |
| `*/5` during 00:30–06:10 | Production worker | Stage non-D1 stores for the current UTC day (cheap no-op once the summary exists)                  |
| 06:15                    | Production worker | Staging watchdog: a missing `exporter/summary.json` fails the lane → Sentry                        |
| 02:15                    | Control plane     | Primary D1 export Workflow                                                                         |
| 02:45–05:45 hourly       | Control plane     | Catch-up create/restart of same-day D1 Workflow                                                    |
| Hourly `:45`             | Control plane     | D1 freshness (identity, size ceiling, manifest age ≤26h, R2 size/ETag) + seal recent complete days |

Hourly freshness does not SHA-256 the SQL bytes; drills do. Page yourself on
`freshness-stale`, size-ceiling hits, missing manifests, seal failures,
`backup-unrestorable-statements`, or unexpected disablement of the enable gates.

## Offline CLI fallback

The UI is the primary drill/restore path. Keep the CLIs for air-gapped or
UI-down recovery:

- `node tools/disaster-recovery/d1-restore-drill-cli.ts` — isolated D1 import
  against checked-in identity/baseline/manifest-key registries
- `node tools/disaster-recovery/canonical-readiness-cli.ts` — fail-closed
  readiness assessment from local Ed25519 evidence envelopes
- `node tools/disaster-recovery/seal-escrow.ts` — same seal used by
  `dr-escrow.yml` (also runnable locally with env vars)

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
- [ ] `DR_DEPLOY_TOKEN` GitHub secret set; control plane deploys from Actions to
      the DR account; `BACKUP_BUCKET` bound; Workflows
      `kody-production-d1-backup` and `kody-production-dr-restore` present;
      public bucket access off.
- [ ] UI loads only through Access; unauthenticated and wrong-email JWTs
      get 403.

### 4. Production exporter wiring

- [ ] Production Worker vars/secrets: `DR_EXPORT_ENABLED` (leave unset/false
      until ready), `DR_BACKUP_ACCOUNT_ID`, `DR_BACKUP_BUCKET_NAME`,
      `DR_BACKUP_ACCESS_KEY_ID`, `DR_BACKUP_SECRET_ACCESS_KEY`,
      `DR_RESTORE_SECRET` (same value as control plane).
- [ ] Control plane `PRIMARY_WORKER_ORIGIN` points at production.
- [ ] One manual/nightly staging run writes
      `staging/{day}/exporter/summary.json` with acceptable warnings.

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

- [ ] `SECRET_ESCROW_PASSPHRASE` in password manager + GitHub secret; run
      `dr-escrow.yml`; dashboard shows escrow present; offline unseal smoke test
      with the passphrase.
- [ ] Set `DR_EXPORT_ENABLED=true` in production after staging path is proven.
- [ ] Monthly: UI isolated D1 drill on a retained day; confirm alert paths for
      freshness failures.
- [ ] Quarterly: seal verification + spot-check StorageRunner/R2/artifact
      restore into a non-production target (or full UI production restore only
      during a real incident after a fresh drill on that day).
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
- Backup of `RunLog` run records (observability; ~30 day DO self-retention)
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
