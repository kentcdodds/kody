# Data storage

This project uses several Cloudflare storage systems for different purposes.

## Per-user isolation invariant

Kody is multi-user with strict per-user isolation. Every user-owned storage
layer described below is scoped by `user_id` (D1 columns, Vectorize metadata, KV
key prefixes, Durable Object names), and every owner read/write path takes a
`userId` argument. Two users with the same logical identifier (for example the
same `kind`/`instanceId` pair on a remote connector, the same package id, or the
same storage id) land on different durable objects and different rows. Any new
persistence layer added to the project must follow the same convention;
user-scoped tests should exercise both the "happy" path and a cross-user denial
path.

The deliberate storage exception is **operator-owned system email** for reserved
platform local parts (`kody`, `support`, `abuse`, `postmaster`, `security`, and
`admin`). Migration `0130-system-email-graph-expand.sql` adds permanent D1
tables `system_email_threads`, `system_email_messages`,
`system_email_attachments`, and `system_email_delivery_events`. They omit
`user_id` because the operator owner is implicit. Since step 4b they are the
live authority; legacy rows under reserved owner id `system:email` are atomic
rollback mirrors through step 5. The reserved id is not a login account and must
not be conflated with the `kody@example.com` fixture or Kent's personal account.
Account deletion and export treat both graph copies as platform/operator
content, not user data; legacy exclusion is listed in
`accountUserDataExcludedOwnerIds` and the dedicated tables in
`accountOperatorOwnedD1Surfaces`, with guardrail tests.

Platform feedback remains user-owned and user-scoped in storage, but has a
narrow cross-user read and triage path. Only feedback the submitting user
explicitly approved enters that role-gated admin surface. The stored submitter
id makes feedback attributed rather than anonymous; the exception never grants
admins access to unrelated account data.

Community forks and ratings remain user-owned rows for deletion and export, with
a narrow role-gated admin metadata projection. It joins those rows only to
public listing identity and the actor's username. Fork rows snapshot the public
listing name and kody id so retained provenance remains intelligible after a
listing is deleted. The projection never reads the forked Artifacts source, the
public snapshot file tree, rating notes, or unrelated account data. Actor
usernames resolve through the unique `users.stable_user_id` index; email and
stable user ids remain absent from activity results and events. One-click
installs and ordinary forks share the same row shape and therefore appear as
`fork`.

## Account deletion inventory

Account deletion is implemented in `packages/worker/src/app/account-deletion.ts`
and is intentionally inventory driven. Before inventory it durably sets
`users.deleting_at`; browser, MCP, package-invocation, and job mutation
boundaries then reject writes, while the deletion route can still authenticate
the marked account for retry. The operation performs idempotent out-of-band and
OAuth cleanup. Any critical cleanup failure preserves D1, the marker, and the
user row for retry. Only after cleanup succeeds does one atomic D1 batch delete
or clear all user rows and the `users` row. Each step records deleted counts,
updated counts for cleared references, and warnings so the HTTP response states
what was removed and what needs operator attention. Re-running the operation is
safe: missing rows, missing KV keys, missing vectors, deleted Artifacts repos,
and already-cleared Durable Objects are treated as successful no-ops or
warning-only failures.

Legacy system email rows owned by `system:email` and all four dedicated
`system_email_*` graph tables are intentionally excluded from account deletion.
They are operator-owned mail for reserved platform addresses, not portable user
content. The scheduled system-email lane applies its 90-day age policy,
5,000-message cap, and blob-before-row deletion against the dedicated authority,
then removes the corresponding legacy mirrors in the same D1 batch.

Platform-feedback rows follow two account-deletion behaviors. Deleting the
submitting account deletes its submissions. When a deleted account was an admin
reviewer for another user's surviving submission, deletion clears the reviewer
reference so the row does not retain attribution to a nonexistent account.

Deletion must cover these user-owned surfaces:

- **D1:** every live table with `user_id` / `*_user_id` ownership columns, plus
  transitive children (`secret_entries`, `value_entries`, `email_attachments`)
  and listing children for community-owned listings. Physical tables pending a
  later drop migration are registered in `accountUserDataPendingDropTargets`
  (schema coverage only; runtime deletion never queries them). The guardrail
  test in `packages/worker/src/account/data-targets.node.test.ts` applies the
  live migrations to SQLite and fails if a user-owned schema column lacks schema
  coverage in the runtime target list or pending-drop registry, or if those
  lists reference a stale column.
- **Durable Objects:** `JobManager`, `StorageRunner`, `RepoSession`,
  `RemoteConnectorSession`, `PackageRealtimeSession`, `PackageServiceInstance`,
  `McpClientHub`, `RunLog`, `UserMeter`, `StripePlanRefresh`, and `Mailbox` are
  purged through account-deletion RPCs after their D1 identifiers are collected
  (`RunLog`, `UserMeter`, `StripePlanRefresh`, and `Mailbox` are one object per
  user and need no D1 id scan). During Mailbox step 3, account deletion first
  captures the authoritative USER raw-MIME and attachment references through
  `Mailbox.listBlobReferences`, deletes those owner-safe R2 keys plus defensive
  owner-prefix sweeps, and only then calls `Mailbox.purge()`. The purge clears
  DO SQLite only. D1 `email_*` compatibility rows remain explicit deletion
  targets until step 5 (see [Mailbox](#durable-objects-mailbox)). `MCP` objects
  remain SDK session-keyed, while `mcp_agent_sessions` indexes each Durable
  Object id by authenticated stable user id so account deletion can purge stored
  props, conversation state, raw-fetch state, and transport storage before
  revoking OAuth grants.
- **Vectorize:** memory, job, and saved-package vector ids are derived from D1
  rows and removed with `deleteByIds`.
- **R2:** raw USER email MIME and attachment blobs in `EMAIL_BLOBS` are
  inventoried by `Mailbox.listBlobReferences`; the Mailbox store derives raw
  keys from owner/message ids and emits only canonical external-attachment keys.
  Deletion also performs per-user prefix cleanup (`email-raw:v1:{userId}/` and
  `email-attachment:v1:{userId}/`) as defense in depth. A failed inventory or
  object delete aborts Mailbox purge and D1 finalization, preserving the
  deletion marker and compatibility rows for retry. Rows owned by `system:email`
  keep their blobs here (they are not user data); those blobs are removed when
  system-email retention deletes messages through the D1 helper.
  `Mailbox.purge()` never deletes R2 objects.
- **KV:** published bundle artifact keys, source/manifest snapshot keys,
  community listing snapshots, and per-user package retriever cache/index keys
  in `BUNDLE_ARTIFACTS_KV` are deleted before D1 projection rows are removed.
  OAuth token/grant KV is owned by the OAuth provider and is handled through
  provider grant revocation rather than app-level key scans.
- **Cloudflare Artifacts:** source repos referenced by `entity_sources` and
  `repo_sessions` are deleted through the REST client in
  `packages/worker/src/repo/artifacts.ts`.

## Account export inventory

Account export is implemented in `packages/worker/src/account/export.ts`. It
mirrors the deletion inventory so portability and account migration cover the
same user-owned storage surfaces. The D1 table list and shared kind→SQL match
builders live in `account/data-targets.ts` (`accountUserDataTargets`,
`buildUserScopedTargetMatch`); export redaction columns and
`accountUserDataPendingDropTargets` also live there. Out-of-band surfaces
(Durable Objects, KV schemes, R2, Vectorize, Artifacts) are declared in
`account-user-owned-surfaces.ts` and consumed by both deletion and export.
Growth-table retention dispositions are linked in
`account-retention-dispositions.ts`.
`packages/worker/src/account/export.node.test.ts` applies the live migrations to
SQLite and fails if a `user_id` / `*_user_id` column is not covered by the
export list or pending-drop registry. The hard invariant is the same as every
storage path: callers pass the authenticated user's stable MCP `userId`, and
every query or Durable Object lookup is scoped to that id.

Legacy `system:email` rows and dedicated `system_email_*` rows are intentionally
absent from account exports for the same reason they are absent from deletion:
they belong to the operator inbox surface, not to the exporting user. The export
manifest lists both omissions under `excludedD1Surfaces` so they are explicit.
The retired `entitlement_daily_counters` D1 mirror is absent from the final
schema (migration `0126`) and therefore from export inventory and
`excludedD1Surfaces`.

Platform-feedback submissions are included in the submitting user's own D1
export section. An export never includes submissions owned by other users,
including feedback the exporter may have reviewed as an admin. The submitter's
feedback status may remain in the export, but internal review metadata
(`reviewed_by_user_id`, `reviewed_at`, and `admin_note`) is redacted.

Exports are versioned JSON documents:

- `manifest.schemaVersion` — `1`.
- `manifest.generatedAt` — UTC timestamp.
- `manifest.sections` — per-section counts, warnings, and redacted columns.
- `manifest.security.secretValuesExported` — always `false`.
- `d1` — user-scoped D1 rows grouped by table. USER `email_threads`,
  `email_messages`, `email_attachments`, and `email_delivery_events`
  compatibility rows are deliberately excluded to avoid duplicating the
  authoritative Mailbox graph.
- `durableObjects` — exported user-scoped Durable Object state where it is
  durable and enumerable.
- `oauthGrants` — OAuth grant metadata only.
- `artifactRepos` — Artifacts repo pointers from `entity_sources`.
- `kvKeys` — KV source/cache keys that belong to the user.

Secret values are **never** exported. `secret_entries` rows are metadata-only:
name, description, bucket, allowed hosts, allowed kody, allowed packages, and
timestamps. The encrypted payload (`encrypted_value`) and lookup hash
(`lookup_hash`) are omitted. The same redaction rule is applied to other
credential-equivalent fields such as password hashes, password/email reset token
hashes, and package invocation token hashes. The manifest states these
redactions explicitly so a partial or intentionally redacted export is not
mistaken for a complete secret backup.

The browser route `GET /account/export.json` downloads a bounded metadata
manifest for the signed-in user and identifies the MCP capabilities required for
a complete export. It deliberately does not inline D1 rows, Durable Object
state, or R2 bytes. The MCP capability domain `account` provides the complete,
migration-safe chunked interface:

- `account_export_manifest` returns the manifest, counts, warnings, and chunking
  instructions.
- `account_export_section` pages through one section at a time. D1 rows are read
  with `section: "d1_table"` and a table name. Durable storage buckets are read
  with `section: "storage_runner"` and a `storage_id`, using the same
  StorageRunner `exportStorage({ pageSize, startAfter })` RPC as the dedicated
  storage export capability. User meter counters use `section: "user_meter"` and
  the `UserMeter.exportCounters` RPC (daily counters plus additive shadow fields
  on the first page only when present: `storageBytesShadow` and
  `packageServiceStatesShadow`; explicitly non-authoritative). Mailbox metadata
  uses `section: "mailbox"` and the `Mailbox.exportMailbox` RPC. R2 raw MIME,
  attachment, avatar, and icon objects use `section: "r2_object"`; each response
  contains at most one 256 KiB base64 chunk and an opaque cursor. Each request
  uses bounded `LIMIT 1` ownership queries rather than reconstructing inventory.
  Continuation cursors bind the source row, object key, size, and ETag;
  ownership/key mutations and object overwrites are reported instead of mixing
  generations. Missing objects are represented explicitly. R2 cursors created
  before the Mailbox-authoritative traversal (version 1) cannot be translated
  without risking duplicate bytes; callers receive an invalid/unsupported cursor
  error and must restart the `r2_object` section without `startAfter`.

D1 manifest counts use bounded SQL `COUNT(*)` queries. D1 section rows are read
with SQL-level keyset pagination: every query orders by the table's `rowid`,
resumes strictly after an opaque cursor, and applies a SQL `LIMIT`, so a single
query never loads a whole table. `account_export_section` fetches only the
requested page.

Durable Object export behavior:

- `StorageRunner` bucket contents are exported with paged entries. These buckets
  hold application/job/service durable state and are the primary account
  migration surface for Durable Object storage.
- `JobManager` exposes scheduler alarm/debug state through an export RPC.
- `RunLog` exports per-user execution history (runs + log lines), the keyed
  package-invocation idempotency ledger, and dedicated unpruned RunLog state
  (workflow projections, job-run observability, package run successes,
  activation milestones) through the account-export `run_records` section
  (`exportRuns` RPC; one cursor pages runs first, then ledger rows, then each
  dedicated phase via prefixed cursors). Run history self-prunes inside the DO
  (~30 days / 2,000 runs; ledger terminal rows 90 days); dedicated tables are
  never pruned by retention. See [Run records](./run-records.md).
- `UserMeter` exports daily entitlement counter rows through the `user_meter`
  section (`exportCounters` RPC; keyset pagination by UTC `day` and `resource`).
  The same RPC may return additive shadow fields on the first page only
  (`startAfter` absent): `storageBytesShadow` when the schema-v4 row exists, and
  `packageServiceStatesShadow` when schema-v5 service rows exist (`null` on
  later pages and when never shadowed). Section totals count each shadow
  inventory once when present. UserMeter `package_service_states` is
  **authoritative** for running-count enforcement; D1 `package_service_states`
  remains the enumeration export in the `d1` section. `users.d1_storage_bytes`
  is a **temporary async mirror**; authoritative storage bytes live in
  UserMeter. Retention is self-enforced inside the DO (seven UTC days of counter
  and inbound-delivery-claim rows); storage-byte and package-service liveness
  rows are not time-pruned. See
  [Entitlements](./entitlements.md#usermeter-expand-phase).
- `Mailbox` is the sole authoritative USER email graph export. It exports
  threads, messages, attachments, and delivery events through the account-export
  `mailbox` section (`exportMailbox` RPC; keyset pagination with prefixed
  cursors); manifest counts use `countMailbox`. D1 `email_delivery_events`
  remains the synchronous compatibility mirror and graph-write fence, and the
  other D1 `email_*` rows remain live compatibility projections/deletion targets
  during expansion, but none of those four graph tables is duplicated in the D1
  export. USER R2 export enumerates raw MIME and attachment keys with
  `Mailbox.listBlobReferences`. Mailbox also retains migration-only
  `email_message_deletion_tombstones` so delayed D1 dual-write/parity pages
  cannot recreate deleted messages. Tombstones are not exported or counted;
  account purge clears them. They intentionally have no time-based cleanup while
  D1 writers remain, so their growth is bounded by deleted message ids during
  the migration. Tombstone cleanup is safe only after those writers retire in
  step 5. Internal `email_message_retention_retries` rows defer failed R2
  deletion attempts without blocking other expired messages; they are likewise
  excluded from export/counts and removed with message or mailbox purge. See
  [Mailbox](#durable-objects-mailbox).
- `RemoteConnectorSession` exposes persisted connector metadata and tool
  descriptors through an export RPC.
- `PackageServiceInstance` uses its status RPC as the stable persisted service
  state summary.
- `MCP`, `RepoSession`, `PackageRealtimeSession`, and `McpClientHub` are
  documented exclusions: MCP objects are SDK session-keyed and not globally
  enumerable; RepoSession is an ephemeral editing workspace;
  PackageRealtimeSession is live websocket state; McpClientHub can hold OAuth
  tokens and SDK registrations that are non-portable. Canonical repo-backed
  source and durable package app state are covered by Artifacts pointers and
  StorageRunner buckets instead.

Vectorize entries are intentionally excluded. Memory text and metadata, job
metadata, and package projections are exported from D1; vectors are derived and
should be rebuilt by reindexing after import.

Cloudflare Artifacts repo contents are not inlined in the JSON export. D1 stores
metadata/projections, while canonical package, job, and app source lives in the
Artifacts repos referenced by `entity_sources.repo_id` and
`repo_sessions.source_repo_id`. For account migration to a new Cloudflare
account, first run `account_export_manifest`, page through export sections as
needed, then separately fetch or clone every repo listed in `artifactRepos`
using Artifacts access and recreate those repos in the destination account
before importing D1 projections or republishing packages.

## D1 (`APP_DB`)

Relational app data lives in D1.

The schema is defined by migrations in `packages/worker/migrations/`:

- `users`: login identity and password hash, plus the persisted stable MCP
  `userId` (`stable_user_id`, NOT NULL unique index from migrations 0052 + 0075;
  initially SHA-256 of the normalized email at signup via
  `createStableUserIdFromEmail`, then preserved across email changes). Optional
  community profile fields (`display_name`, `bio`, `profile_visibility` with
  default `public`) come from migration 0068. `account_type` (`'person'` default
  or `'platform'`, migration 0072) distinguishes normal signups from
  operator-provisioned platform accounts that own official package scopes (see
  [Platform accounts](./platform-accounts.md)). `d1_storage_bytes` and
  `d1_storage_bytes_updated_at` (migration 0122) are a **temporary async
  mirror** of the UserMeter `storage_bytes_state` singleton. Enforcement and
  usage reads are authoritative in UserMeter; the D1 columns remain for cold
  bootstrap, parity checks, and the `d1_storage_reconciliation` sweep cursor
  until they can be safely dropped (a separate schema migration after parity
  sign-off). UserMeter `storage_bytes_state` (schema v4) drives storage-byte
  enforcement; `package_service_states` (schema v5) is the authoritative
  running-count source for `package_services` / `service_start` — see
  [Entitlements](./entitlements.md#usermeter-expand-phase). Mailbox expand-phase
  parity/backfill state (migration `0125-mailbox-parity-state.sql`):
  `mailbox_parity_checked_at`, `mailbox_parity_matching_since`,
  `mailbox_parity_mismatch_count`, `mailbox_parity_last_error`,
  `mailbox_parity_content_watermark_at`, durable content-replay window
  (`mailbox_parity_content_replay_upper_at` plus `(updated_at, id)` cursor),
  message and **all** owner delivery-event backfill cursors/completion
  timestamps on the user row. Indexed by
  `(mailbox_parity_checked_at, stable_user_id)` for oldest-first discovery in
  the every-5-minute `mailbox_parity` reconcile lane (see
  [Mailbox](#durable-objects-mailbox)). The same migration adds keyset-friendly
  composites on `email_messages(user_id, created_at, id)`,
  `email_messages(user_id, updated_at, id)`, and
  `email_delivery_events(user_id, created_at, id)`. Inbound email routing does
  not reverse-resolve stable ids at all — it uses the indexed username lookup
  (`findPublicUserIdentityByUsername`). Contextless paths resolve stable ids
  with one indexed point read on `users.stable_user_id` (for example
  `findUserAccountByStableUserId`).
- `platform_feedback`: attributed, user-approved Kody feedback and admin triage
  state. Submitter identity remains on the row; optional reviewer attribution is
  cleared if that admin account is deleted. Open and triaged rows remain until
  they are resolved, dismissed, or the submitting account is deleted. Resolved
  and dismissed rows are pruned 365 days after `updated_at`; submitter deletion
  removes any remaining rows.
- `package_scope_grants`: explicit rows granting a person account permission to
  act inside a platform account's package scope (`scope_owner_user_id`,
  `grantee_user_id`, `created_by_user_id`, `created_at`; migration 0072). Grants
  are only representable when the scope owner is a platform account.
- `password_resets`: hashed reset tokens with expiry and foreign key to users
- `jobs`: persisted job metadata, caller context, schedule state, repo source
  pointers, `preserved` (skip platform auto-cleanup), and optional `expires_at`
  (UTC ISO; when reached the scheduler skips the job and auto-disables it with
  `enabled = 0`). Account retention windows live on `users`
  (`job_retention_*_days`; NULL = platform defaults 14/60/90). Completed ad-hoc
  jobs are cleaned by the hourly `job_retention` sweeper; package-owned and
  preserved jobs are not. `expires_at` stops scheduling only — it does not
  delete rows and is independent of `preserved`. D1 keeps schedule fields
  (`next_run_at`, `schedule_json`, …) and `last_run_at` for the retention
  sweeper only; terminal run outcomes and counters for observability live in the
  per-user `RunLog` `job_run_observability` table (see
  [Run records](./run-records.md)). Execution history rows live in the same DO.
- `package_service_states` (`0095-package-service-states.sql`): per-service
  liveness projection (`running` / `idle` / `stopped` / `error`) for discovery,
  account export/deletion inventory, and parity. Upserted and heartbeaten (1h)
  by the `PackageServiceInstance` Durable Object. Running-count enforcement and
  `service_start` read the per-user `UserMeter` copy (schema v5; 24h staleness
  on DO `source_updated_at`). D1 remains the enumeration index and parity mirror
  — see
  [Entitlements](./entitlements.md#package-service-liveness--usermeter-authority-cutover-2026-08-01).
- `entity_sources`: durable mapping from user-facing entities to Artifacts repos
  and their latest published commit
- `saved_packages`: package metadata/search projection derived from published
  `package.json` source, plus a user-scoped `hidden` flag (0/1) that excludes
  the package from default ranked search while leaving list/get/execute paths
  intact, and `is_private` (0/1, migration 0068) projecting
  `package.json#private` for public-profile and timeline filters
- `community_listings`, `community_forks`, `community_ratings`,
  `community_reports`, `community_bans`: public community package listings and
  moderation (see [Community packages](../community-packages.md))
- `user_follows`: follow edges between MCP stable user ids (`follower_user_id` /
  `followee_user_id`)
- `community_stars`: listing stargazer bookmarks (`listing_id` + `user_id`),
  distinct from 1–5 `community_ratings`
- `community_activity_events`: stored `listing_published` / `listing_updated`
  timeline events (`actor_user_id` + `listing_id`); fork and star timeline items
  are derived at read time from `community_forks` / `community_stars`
- `secret_buckets`: encrypted-secret ownership buckets scoped to `user`,
  `package`, or `session`. Package buckets bind directly to `saved_packages.id`;
  package runtimes may use their own package secrets. User secrets are
  auto-granted for read/use to self-authored packages (no `community_forks` row
  for that `saved_packages.id` + `userId`) and to adopted forks
  (`community_forks.adopted_at` set via `community_fork_adopt`; columns in
  `0074-community-fork-adoption.sql`). Unadopted community forks
  (`community_forks.forked_package_id`, indexed in
  `0073-community-forks-forked-package-index.sql`) still require an explicit
  `allowed_packages` grant on every package read path. Updating or deleting a
  user secret from package code always requires that grant, regardless of fork
  or adoption state.
- `user_oauth_apps` (`0101-user-oauth-apps-and-integrations.sql`): per-user
  OAuth app rows keyed by `(user_id, slug)`. Holds shared client id, client-
  secret secret name, provider endpoints, and flow options. See
  [OAuth integrations](./integrations.md).
- `user_integrations` (`0101-user-oauth-apps-and-integrations.sql`): per-user
  OAuth connections keyed by `(user_id, name)`, with composite FK
  `(user_id, app_slug) → user_oauth_apps(user_id, slug)` (`ON DELETE RESTRICT`).
  Holds `scopes_json`, `required_hosts_json`, and access/refresh token secret
  names. Secret credential values stay in `secret_entries`; the non-secret
  `client_id` is stored inline on `user_oauth_apps`.
- `user_openapi_bindings` (`0102-user-openapi-bindings.sql`): per-user OpenAPI
  provider binding rows keyed by `(user_id, name)`. Holds `spec_url`,
  `api_base_url`, `auth_json`, `selection_json`, `include_destructive`, and
  optional description / spec metadata. See
  [OpenAPI provider bindings](./openapi-bindings.md).
- `user_openapi_binding_operations` (`0102-user-openapi-bindings.sql`):
  per-operation child rows keyed by `(user_id, binding_name, slug)`, with
  composite FK `(user_id, binding_name) → user_openapi_bindings(user_id, name)`
  (`ON DELETE CASCADE`). Holds `operation_json` for each curated operation
  snapshot entry. Account deletion lists operations before bindings so cleanup
  does not rely on CASCADE.

App access pattern:

- `packages/worker/src/db.ts` defines shared `remix/data-table` table metadata
  and creates a D1-backed database runtime via
  `packages/worker/src/d1-data-table-adapter.ts`
- Database row validation and API payload parsing use `remix/data-schema`
- app handlers and the mock Resend worker perform CRUD/query operations through
  `remix/data-table` (including `findOne`, `create`, `update`, `deleteMany`, and
  `count`)

## Analytics Engine reporting

The role-gated admin insights page reads its 28-day email volume and outbound
delivery-outcome charts from the `EMAIL_EVENTS` Analytics Engine dataset.
Charged sends and receives write one event after entitlement consumption;
persisted `cloudflare-email` provider outcomes write one delivery event. The
layout is `index1 = userId`, `blob1 = event type`, `blob2 = delivery outcome`,
`blob3 = source timestamp`, and `double1 = 1`. Admin queries return only
platform-wide day/outcome counts and weight sampled rows by `_sample_interval`.
When Analytics Engine SQL is unreachable, these two charts zero-fill while the
rest of the page renders. Local development cannot query Wrangler's emulated
Analytics Engine SQL API: email quota aggregates degrade to empty (with an
explicit warning) rather than reading the retired D1 mirror, while
delivery-outcome aggregates still read D1 `email_delivery_events`.

**Mailbox expand-phase parity events** reuse the same `EMAIL_EVENTS` dataset
with a separate row shape defined in
`packages/worker/src/email/mailbox-parity-events.ts`
(`recordMailboxParityEvent`). Live mirror helpers record one namespaced outcome
per attempted operation; the `mailbox_parity` reconcile lane (every five-minute
cron tick) records one outcome per count comparison (`compare_threads`,
`compare_messages`, `compare_attachments`, `compare_delivery_events`). These
rows do not feed the admin insights charts today:

- `index1` — stable user id (per-user isolation; `system:email` is excluded)
- `blob1` — namespaced event type (`mailbox_mirror:<operation>` or
  `mailbox_parity:<operation>`) so unfiltered consumers can distinguish these
  from `email_send` / `email_receive` / `email_delivery`
- `blob2` — operation outcome
- `blob3` — source event timestamp (ISO 8601)
- `double1` — event weight (always `1`, matching reporting)
- `double2` — D1-minus-DO count delta (`d1Count - doCount` for parity compares;
  `0` when absent or not applicable)

Mirror operations: `mirror_message`, `upsert_delivery_event`,
`upsert_delivery_event_batch`, `touch_thread`, `update_message_delivery`,
`set_message_classification`, `delete_message_metadata`,
`delete_delivery_event`, `delete_thread_if_empty`. Mirror outcomes: `mirrored`,
`stale`, `missing`, `timeout`, `skipped`, `error`. Parity operations:
`compare_threads`, `compare_messages`, `compare_attachments`,
`compare_delivery_events`. Parity outcomes: `match`, `mismatch`. Mirror outcome
writes are automatic from live dual-write helpers; parity compare writes come
from the scheduled reconcile lane after owner-scoped D1 and Mailbox counts are
compared. Writes are best-effort and never throw into D1 authority paths.

Two D1 reporting projections deliberately remain:

- `usage_rollups` keeps 24 months of per-user monthly aggregates. Analytics
  Engine's account retention is approximately 90 days, so it cannot safely serve
  the 12-month admin trend or preserve the 24-month read model. The hourly
  Analytics Engine recompute and D1 table remain unchanged.
- `agent_package_conversation_uses` is read while building MCP server
  instructions to provide popular-package hints. That request path is
  latency-sensitive, so Analytics Engine SQL is not a suitable replacement. A
  per-user meter Durable Object is a possible future home if D1 write contention
  requires another move.

## KV (`OAUTH_KV`, `BUNDLE_ARTIFACTS_KV`)

OAuth provider state is stored in `OAUTH_KV` through the
`@cloudflare/workers-oauth-provider` integration. Published package/job source
snapshots, bundle artifacts, package retriever caches, and community listing
snapshots are stored in `BUNDLE_ARTIFACTS_KV`.

- Bindings are configured in `packages/worker/wrangler.jsonc` (remote KV IDs are
  supplied at deploy time via generated Wrangler configs, not committed in the
  checked-in config).
- `OAUTH_KV` supports OAuth client and token flows without custom storage code
  in the app handlers; account deletion revokes all provider grants for the
  user.
- `BUNDLE_ARTIFACTS_KV` keys are deleted from account deletion using D1-derived
  source ids, published commits, bundle artifact rows, community listing ids,
  and package ids.

## R2 (`COMMUNITY_ASSETS`, `EMAIL_BLOBS`)

Processed public community icons live in the private `COMMUNITY_ASSETS` bucket.
The public icon route reads the active listing first, then resolves a cachified
descriptor from `BUNDLE_ARTIFACTS_KV` and streams the referenced R2 object.
Source files remain in the listing's pinned Artifacts commit; R2 stores only
validated derived output or a generated fallback.

- Keys use `community-icon:v1/{listingId}/{commit}/asset`, where the commit is
  the listing's icon commit (the owner package's current published commit) or
  its pinned snapshot commit.
- Descriptor keys include the same listing id and commit, so package publish and
  listing re-publish cannot serve an older icon.
- Unpublish, admin hard delete, and re-publish prune all descriptor and object
  keys under the listing prefix; package publish prunes superseded commits;
  account deletion removes the pinned and icon commit keys derived from D1.
- Bucket names are `kody-community-assets` in production and
  `{worker}-community-assets` for preview deployments.

Raw email MIME payloads live in the `EMAIL_BLOBS` R2 bucket instead of D1.
`email_messages` stores an object key in `raw_mime_key`
(`email-raw:v1:{userId}/{messageId}`). R2 is required for inbound MIME —
`insertEmailMessage` puts the payload to `EMAIL_BLOBS` before the D1 insert and
writes only `raw_mime_key` (never `raw_mime`). On R2 put failure the insert
throws `EmailRawMimeStorageError` (a `RetryableInboundStorageError`; no D1 row).
The inbound Worker rethrows typed pre-commit failures so Cloudflare Email
Routing retries; UserMeter delivery-id idempotency prevents a second charge. The
message-graph commit boundary is message + attachment rows: thread prework, R2
put, and D1 message/attachment storage precede Mailbox `received` finalization.
If attachment insert fails but message cleanup cannot remove the row — or the
residual-row probe itself fails (ambiguous commit state) — the handler
acknowledges the already-created message (logged, non-retry) rather than risking
a duplicate. Outbound messages pass `rawMime: null` and are unaffected. If D1
insert fails after a successful put, the blob is best-effort deleted.

**Expand/contract Stage 4b1 (code-only):** the worker does not read or write
transitional `email_messages.raw_mime` / `raw_mime_offload_blocked`, does not
run the offload maintenance endpoint or deploy sweep, and does not use the
delete-time claim protocol.

**Expand/contract Stage 4b2 (migration-only):** after production verified
`remainingInline=0`, `remainingBlockedInline=0`, and `remainingBlobCleanup=0`,
migration `0077-drop-email-raw-mime-inline.sql` drops the legacy `raw_mime`
column, `raw_mime_offload_blocked`, the unblocked inline partial index, and
`email_raw_mime_cleanup_queue`. Runtime code from Stage 4b1 is already
compatible with the final schema.

**Expand/contract Stage 5 (migration + types):** migration
`0078-email-sender-identities-verified-only.sql` normalizes every
`email_sender_identities.status` to `verified`, then rebuilds the table with a
verified-only CHECK. Because D1 keeps foreign keys on inside the migration
transaction, the rebuild snapshots and restores
`email_messages.sender_identity_id` (ON DELETE SET NULL) so message linkage is
not lost. Runtime types and `ensurePlatformSenderIdentity` provision verified
rows only.

- Canonical key builders are `emailRawMimeKey` / `emailAttachmentBlobKey` in
  `packages/worker/src/email/blob-keys.ts` (re-exported from
  `packages/worker/src/email/repo.ts`).
- All reads go through `loadRawMime` in `packages/worker/src/email/repo.ts`,
  which fetches the blob by `raw_mime_key` only. Attachment content extraction
  re-parses the resolved MIME from that blob.
- Message deletes always delete the deterministic
  `emailRawMimeKey(userId, messageId)` from R2 (production writers always store
  that canonical key). `deleteEmailMessageById` captures ownership + attachment
  `storage_key` values, optionally enforces an `expectedUserId` owner fence,
  runs an atomic D1 batch (attachments, then message), then best-effort R2 blob
  deletes and returns the exact captured blob deletion inventory/outcomes for
  internal verification. Live explicit and retention deletes do not call Mailbox
  mirror helpers today; the parity lane repairs DO state via purge/rebuild.
  Direct delete wiring is pending. User email retention and system-email
  retention stay strict: blob delete before row delete; failed blob deletes skip
  the row for retry. Account deletion stays strict before atomic D1
  finalization; a failed blob delete preserves every message row for retry.
- Bucket names: `kody-email-blobs` (production), per-preview
  `{worker}-email-blobs` buckets created and cleaned up by
  `tools/ci/preview-resources.ts`, and the test env reuses the preview-style
  name locally (Wrangler/vitest-pool-workers simulate the bucket).

## Durable Objects (`MCP_OBJECT`)

MCP server runtime state is hosted via a Durable Object class (`MCP`) in
`packages/worker/src/mcp/index.ts`, exposed through the `/mcp` route.

- The Worker forwards authorized MCP requests to `MCP.serve(...).fetch`
- Durable Objects provide a stateful execution model for MCP operations
- The DO is keyed by the MCP SDK session id (per-connection); per-user identity
  is supplied on every request via the OAuth token's `props`
  (`McpCallerContext.user`) rather than baked into the DO id.

## Durable Objects (`JobManager` and `StorageRunner`)

Jobs use two Durable Object roles:

- `JobManager`: one object per user, responsible only for alarm scheduling and
  dispatching due jobs from D1-backed metadata
- `StorageRunner`: one object per durable storage id, responsible for isolated
  SQLite state that can be bound to execute calls, jobs, and dedicated storage
  inspection capabilities

Each `JobManager` alarm processes at most `maxDueJobsPerAlarm` due jobs
(`packages/worker/src/jobs/repo.ts`, oldest `next_run_at` first). When more due
jobs remain after a run, the post-run alarm resync arms a near-immediate
follow-up alarm so large backlogs drain across multiple short invocations
instead of one Durable Object wake.

Storage split:

- D1 `jobs` table: job metadata, persisted caller context, schedule fields,
  `last_run_at` / `last_run_status` as retention anchors, repo source pointers
  (`source_id`, `published_commit`), and stable `storage_id`. Terminal run
  error, duration, counters, and pruned execution history live in the per-user
  `RunLog` (`job_run_observability` and `runs`; see
  [Run records](./run-records.md))
- `JobManager` SQLite: only alarm bookkeeping needed to wake the right user's
  due jobs
- `StorageRunner` SQLite: isolated durable state addressed by `storageId`

## Durable Objects (`UserMeter`)

Daily rate-style entitlement counters and inbound email delivery-id idempotency
live in a per-user `UserMeter` Durable Object with SQLite
(`packages/worker/src/entitlements/user-meter-do.ts`). Schema v4
`storage_bytes_state` is the **authoritative** storage-byte counter (D1
`users.d1_storage_bytes` is the temporary async mirror; evidence in
[Entitlements](./entitlements.md#storage-authority-flip-complete-2026-08-01)).
Schema v5 `package_service_states` is the **authoritative running-count source**
for `package_services` / `service_start`; D1 remains the enumeration index and
parity mirror (evidence in
[Entitlements](./entitlements.md#package-service-liveness--usermeter-authority-cutover-2026-08-01)).
The Worker binding is `USER_METER` (class `UserMeter`; Wrangler SQLite migration
tag `v21` via `new_sqlite_classes` in `packages/worker/wrangler.jsonc`).

Naming matches `RunLog` and `JobManager`: one object per untrimmed stable MCP
`userId` via `userMeterDurableObjectName(userId)` → `idFromName(userId)` in
`packages/worker/src/user-scoped-durable-object-name.ts`. There is no `user_id`
column inside the DO because the object identity is the user.

SQLite ownership (schema version tracked in `user_meter_meta`; current version
**7**):

- `daily_counters` — authoritative UTC-day counters for `email_sends_per_day`,
  `email_receives_per_day`, `execute_calls_per_day`, and
  `outbound_fetches_per_day` (`resource`, `day`, `count`, monotonic `revision`,
  `updated_at`).
- `inbound_delivery_claims` — idempotency ledger keyed by inbound `delivery_id`
  (scoped by DO identity, so the primary key is delivery id alone). Records the
  claim's resource/day, post-charge counter, revision, and `claimed_at` so
  Cloudflare Email Routing retries inside the 48-hour inbound dedupe window
  cannot double-charge `email_receives_per_day`.
- `storage_bytes_state` — **authoritative** D1 payload byte counter (`id = 1`
  CHECK constraint, `bytes`, monotonic `revision`, `updated_at`). Written by
  `reserveStorageBytes` (atomic increment with limit check),
  `initializeStorageBytes` (INSERT OR IGNORE cold bootstrap from D1 mirror), and
  `setStorageBytes` (absolute set from reconcile). Authoritative for enforcement
  and usage reads via `readStorageBytes`; D1 `users.d1_storage_bytes` is the
  temporary async mirror (MAX on reserve; direct set on reconcile).
  StorageRunner bucket estimates stay outside this row (see
  [Entitlements](./entitlements.md#usermeter-expand-phase)).
- `package_service_states` — per-service liveness rows (`package_id`,
  `service_name`, `status`, `started_at`, `source_updated_at`, monotonic
  `revision`, `updated_at`; primary key `(package_id, service_name)`). Added in
  schema v5. Populated by dual-writes from `PackageServiceInstance` on every D1
  projection/delete; monotonic on `source_updated_at`. Authoritative for
  running-count enforcement and `service_start` via
  `countRunningPackageServices`. D1 remains the enumeration index (discovery,
  export, deletion) and parity mirror — see
  [Entitlements](./entitlements.md#package-service-liveness--usermeter-authority-cutover-2026-08-01).
- `deletion_state` / `account_write_leases` — deletion tombstone plus write
  leases (singleton `deleting_at`; lease rows `token` / `holder` / `acquired_at`
  / `authority` (`do`|`legacy`) / `pending_repair_id`). Schema v7 is authority
  for DO-path leases. When callers supply `USER_METER`, `authority='do'` rows
  are authoritative for acquire/held/release and admin union list; no D1 row is
  written on acquire. `authority='legacy'` rows are the D1 lease snapshot
  replaced by `markDeleting`. D1 `account_write_leases` may still hold legacy
  email leases and historical stale pre-retirement rows. D1 `users.deleting_at`
  remains the permanent point gate; email paths omit `env` and keep exact D1
  leases. `purge()` preserves an existing deleting tombstone across `deleteAll`.
  Account export emits a sanitized `deletionShadow` without raw token/holder.

Retention is self-enforced inside the DO: every read/write path
opportunistically deletes counter and claim rows older than seven UTC days
(`userMeterDailyCounterRetentionDays`). Enforcement only needs the current day;
the window covers timezone edge cases, recent account exports, and inbound
retries. Shadow storage-byte and package-service liveness rows are not
time-pruned. Deletion-fence legacy lease rows are bounded by the D1 snapshot
replace on `markDeleting` rather than time retention; DO-authority rows clear on
release/repair/purge.

**D1 daily mirror retired:** enforcement, point reads, bootstrap, mirror, and
account export/deletion inventory paths never read or write
`entitlement_daily_counters`. The three-deploy retirement is complete (Workers
`#1133` / `#1134`, then migration `0126-drop-entitlement-daily-counters.sql`).
The final live schema has no table or day index; `admin_user_meter_parity`
reports `daily.mirrorRetired: true` (meter counts only). See
[Entitlements](./entitlements.md#usermeter-expand-phase).

**Daily cold bootstrap:** a missing `(resource, day)` row returns
`needs_bootstrap`. The service calls `initialize({ count: 0 })` with
`INSERT OR IGNORE` (concurrent callers stay safe). Warm daily paths never read
D1 for enforcement.

Account deletion calls `UserMeter.purge()` (one RPC per user, no D1 id scan;
`deleteAll` clears counters, claims, storage-byte shadow, package-service
shadow, and write-lease shadow, while preserving an existing deleting
tombstone). Account export pages `UserMeter.exportCounters` through the
`user_meter` manifest section / `account_export_section` (daily counters plus
additive `storageBytesShadow`, `packageServiceStatesShadow`, and
`deletionShadow` on the first page only when present; shadow fields are
non-authoritative).

## Durable Objects (`Mailbox`)

User-owned email **metadata** moves to a per-user `Mailbox` Durable Object with
SQLite (`packages/worker/src/email/mailbox-do.ts` and siblings under
`mailbox-*.ts`; client in `packages/worker/src/email/mailbox-client.ts`). The
Worker binding is `MAILBOX` (class `Mailbox`; Wrangler SQLite migration tag
`v22` via `new_sqlite_classes` in `packages/worker/wrangler.jsonc`). Raw MIME
and outbound attachment bytes stay in `EMAIL_BLOBS` R2; the DO stores object
keys, not payload bytes. Canonical key builders live in
`packages/worker/src/email/blob-keys.ts`.

Naming matches `RunLog`, `JobManager`, and `UserMeter`: one object per untrimmed
stable MCP `userId` via `mailboxDurableObjectName(userId)` →
`idFromName(userId)` in
`packages/worker/src/user-scoped-durable-object-name.ts`. Data rows have no
`user_id` column (object identity is the user). Because a Durable Object cannot
introspect its `idFromName` string, a singleton `mailbox_owner_identity` row
persists `ownerId` on first write and rejects cross-owner RPCs. That persisted
owner is also used to validate canonical owner-scoped R2 keys (`emailRawMimeKey`
/ `emailAttachmentBlobKey`).

**SQLite ownership** (schema version in `mailbox_meta`; current
`mailboxSchemaVersion = 2`):

- `mailbox_owner_identity` — singleton `owner_id` for blob-key validation and
  cross-user write rejection
- `email_threads`, `email_messages`, `email_attachments`, and
  `email_delivery_events` for the owning user (same logical names as the D1
  tables they will eventually replace)
- latest per-message delivery status on `email_messages.delivery_status`, kept
  separate from send-request `processing_status`
- **Schema v2 (warm-safe):** additive inbound-ledger due-work indexes on
  `email_delivery_events` (reconcile/retry/stale-state/dedupe-provider). Cold
  objects install the full DDL; warm v1 objects run `CREATE INDEX IF NOT EXISTS`
  only. No destructive ALTERs.

**USER inbound ledger authority (step 2b):** owner-bound atomic RPCs in
`mailbox-inbound-ledger.ts` / `mailbox-inbound-effect-ledger.ts` are the sole
authority for USER delivery/window/storage/rejection/receive/reconciliation and
effect transitions. Mutations keep promoted columns and `detail_json` in sync
and set canonical `updated_at`. Usage/subscription complete and subscription
fail require an exact `expectedFinalizationToken` match (`event_type`/`state` =
`received`); mismatch is `lease-lost`. Storage claim clears finalization plus
in-flight effect leases/retry (and resets `processing` → `pending`) so
reclaim/re-finalization cannot be completed by a stale effect worker. Cleanup
claim/release and orphan-cleaned tombstones are also owner-bound CAS.

The DO does **not** perform external usage recording or subscription dispatch:
Workers claim in Mailbox, perform the D1 usage-rollup or package dispatch, then
complete/fail in Mailbox. `inbound-delivery-authority.ts` synchronously upserts
one full Mailbox snapshot into D1 `email_delivery_events` (promoted columns plus
`detail_json`, owner/provider fenced, monotonic and idempotent). Pending is
mirrored before delivery reads; storing is mirrored before D1
thread/message/attachment fence predicates. Those fence-critical failures fail
closed. A rejected CAS is the deliberate exception: SMTP rejection remains
permanent when its D1 projection fails, and rejected terminal work read-repairs
the projection. Terminal/effect snapshots keep D1 global due-owner discovery
current, but D1 is never read back as ongoing authority. Dedupe pruning projects
only the exact bounded pointer IDs deleted by Mailbox, with D1 owner/provider
fences; it never runs a second independent expiry/limit selection.

The only reverse path is the deployment bridge: when a USER point lookup misses
in Mailbox and a pre-deploy D1 row exists, one complete D1 snapshot bootstraps
the owner-bound DO row, after which transitions continue through Mailbox CAS.
Scheduled parity partitions those validated legacy lifecycle/dedupe snapshots to
the missing-only `bootstrapDeliveryEvents` RPC; pre-claim rejection audits and
non-inbound events continue through normal `upsertDeliveryEvents`. The bootstrap
RPC accepts at most 100 snapshots, validates owner/provider/detail coherence,
and reports inserted/existing/skipped counts. It never updates an existing
Mailbox row. Normal delivery-event upserts continue rejecting USER inbound
authority snapshots. Legacy lifecycle bootstrap preserves canonical
`reconcileAfter` and orphan-cleaned `cleanupRetryAt` schedules in Mailbox
columns/detail JSON so due work cannot run early; irrelevant dedupe/terminal
schedule columns remain null. A malformed schedule is skipped per row, allowing
the normal audit subset to commit; parity records a count mismatch instead of
treating the mixed page as an RPC failure. `system:email` stays on the existing
D1 implementation and cannot bootstrap a Mailbox. Migration
`0129-email-inbound-mailbox-authority-mirror.sql` is additive: it promotes
compatibility/fence fields and adds the cross-store usage effect idempotency
ledger; it drops no tables. Destructive follow-up work remains gated on the
verified backup whose SHA-256 starts with `7787f8c9`; this change is explicitly
non-destructive.

**Operator system-email graph split:** migration
`0130-system-email-graph-expand.sql` was the step 4a non-destructive expand/copy
boundary. Migration `0131-system-email-graph-authority.sql` is also additive:
before changing either graph, a CHECK sentinel rejects provider links and
cross-owner inbox/sender/thread/message references. It then reconciles changes
made after the 0130 snapshot by deleting dedicated drift child-first and
full-column UPSERTing valid legacy authority rows parent-first. It then replaces
every promoted transition/effect column in both the dedicated graph and rollback
mirror for Cloudflare inbound and dedupe rows with the canonical `detail_json`
projection, including clearing stale non-null values when a JSON property is
absent. `needs_effect_reconcile` remains column-authoritative because legacy
receive and effect transitions update it in the same statement as JSON.
Non-inbound providers retain their promoted columns. To stay below D1's
five-term compound-SELECT limit, the migration records each ownership, provider,
and per-table parity concern with a separate bounded zero-only CHECK row. The
four post-copy table checks cover exact counts and full-column values,
missing/extra IDs, and invalid cross-owner inbox/sender references. Any nonzero
row aborts the whole reconciliation before the singleton
`system_email_graph_authority` insert persists the validated
`graph_mismatch_count = 0` and `provider_link_count = 0` totals. The migration
never deletes shared rows. The 4b Worker requires that marker on every dedicated
authority entry point and refuses startup/work when it is missing or invalid.
The pre-4b rollback Worker does not know about the marker and ignores it.

Wrangler submits each migration file together with its `d1_migrations` ledger
insert as one D1 multi-statement transaction (local execution uses `D1.batch`;
remote execution uses D1's transactional multi-statement query). Therefore a
preflight or post-copy CHECK failure rolls back the authority table, the counter
correlation-token column, and every graph mutation. The migration tests execute
the file through Wrangler's local D1 path and prove an early preflight failure
rolls back DDL, graph changes, and the migration ledger; Node SQLite coverage
also proves a late post-copy parity failure leaves the pre-0131 graph unchanged
and no marker behind.

After 4b, `system_email_threads`, `system_email_messages`,
`system_email_attachments`, and `system_email_delivery_events` are the only live
metadata and inbound-ledger authority for `system:email`. Reads never fall back
to shared `email_*` rows, and the reserved owner never gets a Mailbox Durable
Object. Shared inbox/address/sender configuration remains in D1 because the
dedicated graph references that operator configuration; account export/deletion
continues to exclude the reserved owner.

Every authoritative graph or inbound-ledger mutation writes the dedicated row
first and writes a complete legacy `system:email` compatibility mirror in the
same transactional D1 batch. The shared transaction composer follows each pair
with a SQL parity/absence guard, so an exception **or silent no-op** on the
legacy fence aborts the batch before commit. This composer is the single mirror
seam removed in step 5. A same-id collision with a user-owned legacy delivery
event also fails closed. R2 retention is the deliberate cross-service exception:
it deletes all referenced blobs first, then atomically deletes dedicated
metadata and its legacy mirror. If any blob delete fails, the authoritative row
remains for retry. Scheduled retention selects age/cap/events/orphan threads
only from the dedicated graph; it never copies stale legacy state into dedicated
tables.

The admin mailbox maintenance `status` action remains an aggregate, content-free
parity report. The audited `system_email_graph_reconcile` action is now a
rollback-mirror repair only and requires both `force: true` and
`direction: "dedicated_to_legacy"`. In one D1 batch it removes legacy drift
child-first and upserts the complete legacy graph parent-first. There is no
legacy-to-dedicated reconcile path after cutover.

The existing `email_outbound_provider_index` still has an FK to legacy
`email_messages`, so it cannot index the dedicated graph. The production cutover
check found zero provider-linked `system:email` rows; parity reports this
healthy disposition as `no-system-provider-links` with `dedicated-inbound-only`
authority. System outbound sends and provider-linked dedicated messages are
rejected rather than creating a broken cross-authority FK. Immediately before
deploying 0131, operators must capture fresh production evidence that the
provider index, legacy provider-linked system messages, and dedicated
provider-linked messages all remain zero. The marker insert independently
recounts those surfaces; a nonzero count violates its constraint and rolls back
the migration. Runtime marker checks repeat the provider gate so links created
after migration also stop dedicated work. Step 5 may remove legacy system rows
only after dedicated/mirror parity and rollback gates pass: **4a
schema/copy/parity → 4b dedicated authority plus rollback mirror → step 5 legacy
cleanup**.

The pre-4b shared D1 system-delivery engine is retained only as a compatibility
and rollback reference. Once the dedicated marker exists it rejects
`system:email` calls; USER Mailbox paths are unaffected. Dedicated and legacy
implementations share lease/retry timing constants and are covered by
claim/release/retry/reject/receive/reconcile transition-parity tests. Their SQL
engines intentionally remain separate during rollback support; step 5 removes
the legacy system branch instead of attempting a risky state-machine rewrite
during authority cutover.

Rolling back to the pre-4b Worker is supported because 4b continuously maintains
the legacy mirror. Once that older Worker accepts a write, however, legacy
becomes newer and the dedicated graph becomes stale. Do not roll forward to 4b
directly: quiesce ingress and scheduled/effect consumers, repair or rebuild
dedicated state with the approved operator procedure, verify full parity and
zero provider links, and only then redeploy. The 4b reconcile action
intentionally cannot import those rollback-era legacy writes.

**Accepted rollback → roll-forward caveat and manual repair:** a rollback to the
previous Worker can advance USER inbound state in legacy `detail_json` with
`json_set` without advancing `email_delivery_events.updated_at`. A later
roll-forward does not automatically detect that D1 is newer: the bootstrap is
missing-only, an existing Mailbox authority row wins, and the Mailbox → D1
projection fence treats existing D1 `updated_at >=` the snapshot timestamp as
already current. Rollback-era D1 progress can therefore require operator repair
before redeploy.

Use this exact owner-by-owner procedure; do **not** run ordinary Mailbox purge
casually:

1. Gate the repair on the sealed, verified production backup whose D1 SQL
   SHA-256 starts with `7787f8c9`. Verify the signed manifest and stored object,
   not a copied checksum string. Stop if the prefix or restore drill evidence
   does not match.
2. Put the app behind the approved maintenance controls, disable the affected
   Cloudflare Email Routing ingress, and pause scheduled/queue consumers that
   can write email. Keep the rollback Worker quiesced for the entire inspection,
   purge, rebuild, and verification window.
3. For each affected `stable_user_id`, capture D1 `email_threads`,
   `email_messages`, `email_attachments`, and `email_delivery_events` counts.
   Inspect every inbound lifecycle/dedupe row's `detail_json`, promoted state,
   effect/finalization fields, `created_at`, and `updated_at`; compare with
   `Mailbox.exportMailbox`/`countMailbox`. Decide that D1 contains the desired
   rollback-era progress from operator evidence. The code does not make this
   decision.
4. Only after that owner passes inspection, invoke the existing owner-derived
   `Mailbox.purge()` RPC through a reviewed production operator script/Worker
   using `MAILBOX.idFromName(stable_user_id)`. This is the safe metadata-only
   purge: it clears that owner's Mailbox SQLite/alarm state and does not delete
   D1 or R2. Never substitute the normal retention/delete surfaces.
5. Reset only that owner's parity state in D1, preserving all `email_*` rows:

   ```sql
   UPDATE users
   SET mailbox_parity_checked_at = NULL,
       mailbox_parity_matching_since = NULL,
       mailbox_parity_mismatch_count = 0,
       mailbox_parity_last_error = NULL,
       mailbox_parity_content_watermark_at = NULL,
       mailbox_parity_content_replay_upper_at = NULL,
       mailbox_parity_content_replay_cursor_updated_at = NULL,
       mailbox_parity_content_replay_cursor_id = NULL,
       mailbox_parity_message_backfill_cursor_created_at = NULL,
       mailbox_parity_message_backfill_cursor_id = NULL,
       mailbox_parity_message_backfill_completed_at = NULL,
       mailbox_parity_event_backfill_cursor_created_at = NULL,
       mailbox_parity_event_backfill_cursor_id = NULL,
       mailbox_parity_event_backfill_completed_at = NULL
   WHERE stable_user_id = ? AND deleting_at IS NULL;
   ```

6. Run `admin_mailbox_maintenance({ action: "reconcile", batch_size: 100 })`
   until that owner completes a full D1 → Mailbox rebuild and exact count
   compare. Re-export the Mailbox and verify per-row lifecycle state, dedupe
   pointers, effect state/leases/retry/dead-letter fields, finalization tokens,
   usage fields, and message/attachment counts against the inspected D1 source.
   Require zero parity error/mismatch before continuing.
7. Redeploy the roll-forward Worker while writes remain quiesced. Re-run
   owner/fleet status and a focused inbound canary, then resume queues,
   schedules, Email Routing, and normal ingress in that order.

**Mirror write contract:** `mirrorMessage`, `upsertDeliveryEvent`,
`upsertDeliveryEvents`, and `bootstrapDeliveryEvents` take complete snapshots —
every persisted field is explicit (nullable fields use explicit `null`). They
are not patch APIs. All require `ownerId`. Normal upserts apply equal-or-newer
`updatedAt` snapshots (stale snapshots are ignored) and reject USER inbound
lifecycle/dedupe authority rows. `bootstrapDeliveryEvents` is their explicit
missing-only exception: it validates legacy USER inbound snapshots and never
updates an existing ID. Both batch RPCs accept at most
`mailboxUpsertDeliveryEventsMax` (100) events and process in caller order. The
only omission exception is the `mirrorMessage` `attachments` bundle: omitting it
preserves existing attachment rows; an explicit `attachments: []` clears them.
Accepted mirrors validate inbound/outbound `rawMimeKey` and external attachment
`storageKey` values against the canonical builders for that `ownerId`.

**Partial mutation RPCs** (owner-bound, monotonic on `updatedAt`, no R2 or
retention-alarm side effects — unlike full snapshot mirrors, these do not mark
retention dirty or reschedule alarms). All partial mutation RPCs remain
library-only on live paths that prefer full graph repair or parity backfill;
direct delete wiring for explicit/retention deletes is pending:

- `touchThread` — advance `last_message_at` / `updated_at` without a full
  snapshot; `last_message_at` never moves backward
- `updateMessageDelivery` — outbound processing fields (`processing_status`,
  `provider_message_id`, `error`, `sent_at`)
- `setMessageClassification` — inbound classification fields
- `deleteMessageMetadata` — metadata-only delete (null delivery-event
  `message_id`, then attachments + message); never deletes R2 or empty threads
- `deleteDeliveryEvent` — metadata-only delivery-event delete
- `deleteThreadIfEmpty` — deferred empty-thread cleanup (D1
  `deleteEmptyEmailThreads` parity); stale-safe by `thread.updated_at`

Partial touch/update/classify RPCs return `accepted`, `missing` (target absent —
idempotent for best-effort callers), or `stale` (newer `updated_at` retained).
Delete RPCs return `deleted`, `missing`, or `stale` with the same semantics.
Implementation lives in `mailbox-mutations.ts` (SQLite helpers) and is exposed
through `mailbox-do.ts` RPCs. All require `ownerId` and reject cross-owner
calls.

**Email owner constant** (`packages/worker/src/email/email-owner.ts`): a
lightweight module exporting `systemEmailOwnerId` (`'system:email'`) and
`isSystemEmailOwner`. It stays free of system-email service imports so
dual-write helpers can skip the reserved operator inbox without import cycles.
Operator mail is never mirrored into per-user Mailbox objects.

**D1 → Mailbox snapshot adapters** (`mailbox-snapshots.ts`; delivery loads in
`mailbox-snapshot-repo.ts`): pure converters that turn D1 rows into complete
Mailbox wire inputs — `toMailboxThreadInput`, `toMailboxMessageInput`,
`toMailboxAttachmentInput`, and `toMailboxDeliveryEventInput`. They normalize
nulls to Mailbox SQLite defaults (empty strings, `[]`, `{}`, `0`,
`application/octet-stream`, `kody`) and fail clearly on invalid persisted
JSON/enums rather than fabricating state. Delivery events consume a complete
`EmailDeliveryEventMirrorProjection` loaded as one cohesive D1 row (base columns
plus promoted `needs_effect_reconcile` and usage-effect fields); inbound/effect
lease fields still come from `detail_json`. Callers load via
`getMailboxDeliveryEventMirrorInput` / `getEmailDeliveryEventMirrorProjection`
and supply only `sourceMutationAt` — the canonical mirror `updatedAt` from the
D1 mutation (inserts use `created_at`). Callers must not stitch promoted columns
field-by-field.

**Best-effort mirror helpers** (`mailbox-mirror.ts`): non-throwing wrappers
around the DO RPCs for D1-authoritative dual-write. Each awaited DO RPC is
bounded by `mailboxMirrorRpcTimeoutMs` (1 second) by default.
`mirrorMailboxDeliveryEventSnapshots` accepts an optional `timeoutMs` override
(telemetry/outcomes unchanged) so the scheduled parity lane can use a longer
batch bound without slowing live dual-write. Each returns a structured
`MailboxMirrorResult`: `{ status: 'mirrored' }`, `{ status: 'stale' }`,
`{ status: 'missing' }`, `{ status: 'timeout' }`,
`{ status: 'skipped', reason }` (`system-email` | `mailbox-unconfigured` |
`missing-owner` | `user-inbound-authority`), or `{ status: 'error', error }`.
Single-RPC helpers record one `mailbox_mirror:<operation>` outcome automatically
when a user id is known; `mirrorMailboxDeliveryEventSnapshots` partitions a
mixed page into normal and bootstrap subsets, bounds each non-empty RPC, and
records one aggregate `mailbox_mirror:upsert_delivery_event_batch` outcome for
the original page. Inserted/existing/skipped bootstrap results map to
mirrored/stale/skipped rather than treating idempotency as an error.
`system:email` is excluded. Failures log with stable tags (for example
`mailbox-mirror-message-failed`) and never propagate into D1 commit paths.
Helpers cover full snapshots (`mirrorMailboxMessageSnapshot`,
`mirrorMailboxDeliveryEventSnapshot`, `mirrorMailboxDeliveryEventSnapshots` —
prefer loading delivery events with `getMailboxDeliveryEventMirrorInput` or
`listMailboxDeliveryEventMirrorInputsForMessage`) and partial mutations
(`mirrorMailboxTouchThread`, `mirrorMailboxUpdateMessageDelivery`,
`mirrorMailboxSetMessageClassification`, `mirrorMailboxDeleteMessageMetadata`,
`mirrorMailboxDeleteDeliveryEvent`, `mirrorMailboxDeleteThreadIfEmpty`). Partial
mutation helpers are library-only; live paths prefer the graph orchestrator
below or parity purge/rebuild for deletes. These best-effort helpers remain for
D1-authoritative message graphs; USER inbound delivery events use the
synchronous reverse compatibility mirror described above.

**Live graph orchestrator** (`mailbox-live-mirror.ts`): loads a cohesive D1
message graph (optional caller thread, message, attachments, then delivery
events) and mirrors it best-effort. `mirrorMailboxMessageGraphFromD1` settles
the message snapshot RPC first, then repairs delivery events with sequential
owner-bound normal/bootstrap batch RPCs (never concurrent per-event RPCs to the
same DO). Event load queries newest `max+1` rows from D1, restores chronological
order, and when truncated keeps the newest `mailboxLiveMirrorMaxEvents`
(`mailboxUpsertDeliveryEventsMax`, 100) — dropping oldest overflow — with a
stable warning (`mailbox-live-mirror-events-truncated`; `userId`, `messageId`,
`loaded`, `max`). Each non-empty subset uses the 1s timeout; the original page
emits one `mailbox_mirror:upsert_delivery_event_batch` telemetry outcome. Each
graph attempt emits at most two Analytics Engine writes (1 message outcome + 1
batch outcome). Never throws; returns a bounded summary. **Live callers:**

- **Outbound terminals** (`outbound.ts`) — after D1 reaches a terminal outbound
  state (`sent`, attachment-store `failed`, or send `failed`), mirrors the full
  message/thread/attachment/event graph. Passes a just-created thread when
  present; otherwise the orchestrator loads it from D1. Failures never affect
  send/refund.
- **Provider delivery queue** (`delivery-queue.ts`) — when queue ingestion
  resolves to `recorded`, `duplicate`, or `stale` with a bound message,
  schedules `mirrorMailboxMessageGraphFromD1` via `waitUntil` so the Worker ack
  is not blocked; full graph repair via message + batch event upsert. `recorded`
  and `duplicate` still run subscription dispatch first; `stale` skips
  subscription dispatch (abuse pause only) but still schedules graph repair when
  a message is present.
- **User classification** (`service.ts#setEmailMessageClassification`) —
  transport handlers (`account-email.ts`, `email-message-classify.ts`) delegate
  here for the D1 mutation + full graph mirror invariant (mirror only after a
  successful D1 update; failures never change the mutation response).
- **Inbound terminals** (`inbound.ts`) — USER delivery authority starts in
  Mailbox: dedupe claim, UserMeter consume, and charged-pending CAS precede
  D1/R2 message-graph storage. Mailbox then finalizes `received` or `rejected`.
  Received snapshots synchronously project to D1; rejected snapshots project
  best-effort so a compatibility-write outage cannot undo the permanent SMTP
  reject. A received winner schedules D1 message-graph repair via
  `ctx.waitUntil` (`scheduleInboundReceivedTerminalWork`) without D1
  delivery-event write-back. **Already-received** Email Routing retries
  (delivery ledger `state === 'received'` with an existing message row)
  idempotently repair the graph and re-run effect reconciliation without a
  second charge. **Rejected terminals** (post-claim parse failure or replay of a
  claimed `rejected` delivery) read-repair the Mailbox → D1 projection via
  `scheduleInboundRejectedTerminalWork`. Effects claim and complete/fail in
  Mailbox around external work; terminal snapshots synchronously repair D1.
  Terminal coordinator failures are contained after the authoritative CAS.
  **Pre-claim bounded rejection rows** (`recordBoundedEmailRejectionEvent` for
  verification, suspension, sender-policy, size, entitlement, and system-limit
  gates before delivery claim/charge) stay **D1-only on the live path** — the
  every-5-minute `mailbox_parity` lane backfills them. **`system:email` stays
  excluded** (no per-user Mailbox object). Retention sweeper deletes and other
  bulk metadata-delete mirrors are **still not wired** on live paths. Scheduled
  parity reconcile **is** wired (see below); read cutover is prepared but not
  flipped.

**Scheduled parity reconcile (`mailbox_parity`)** runs as its own queue-isolated
scheduled lane on **every** five-minute Worker cron tick
(`packages/worker/src/scheduled/scheduled-lanes.ts`,
`packages/worker/src/email/mailbox-reconcile.ts`,
`packages/worker/src/email/mailbox-parity-phases.ts`,
`packages/worker/src/email/mailbox-parity-repo.ts`). Production uses the same
per-lane queue isolation as reconcile, retention, and sibling lanes so a slow
parity pass cannot consume another lane's budget.

User discovery is **D1-only** — no Mailbox Durable Object enumeration. Each tick
selects up to sixteen non-deleting owners (`mailboxParityUserBatchSize`) ordered
by oldest `mailbox_parity_checked_at`, excluding `system:email`. Owners with D1
mail (`email_messages` or `email_delivery_events`) are always eligible;
**previously tracked** owners (any non-null parity column on `users`) remain
discoverable even when D1 mail is empty so DO-only leftovers after the last-row
delete can be purged and reconciled. Never-tracked empty users stay out.
Per-user work shares a ~10s wall-clock budget (`mailboxParityTimeBudgetMs`)
across the batch. The five-minute cron cadence plus that budget is the
production convergence loop: each tick should make forward progress on the
oldest owners rather than soaking the lane on per-event RPCs.

**Account-deletion races:** `loadUserParityState`, `persistUserParityProgress`,
and `rotateCheckedAt` require `deleting_at IS NULL` (zero-row updates are
harmless). Before and after each mirror RPC the lane re-checks
`users.deleting_at`; if deletion started mid-tick it best-effort
`Mailbox.purge()`s and skips further progress for that user.

Per user, the lane:

1. **Content watermark baseline** — on the first backfill attempt, sets
   `mailbox_parity_content_watermark_at` to the run's `now` and retains it
   across incomplete/error ticks so updates during creation mirroring stay
   inside the replay window.
2. **Bounded initial message backfill** — keyset-pages D1 `email_messages` by
   `(created_at, id)` (composite index from migration `0125`) and mirrors each
   graph via `mirrorMailboxMessageGraphFromD1` until complete or
   budget-exhausted.
3. **Bounded delivery-event backfill** — after messages complete, keyset-pages
   **every** owner `email_delivery_events` row by `(created_at, id)` into ready
   `MailboxDeliveryEventInput` snapshots
   (`listMailboxDeliveryEventMirrorInputsForOwnerKeyset`; not only
   `message_id`-null orphans). Each page partitions legacy USER inbound
   lifecycle/dedupe snapshots to missing-only `bootstrapDeliveryEvents`, and
   sends pre-claim rejection audits plus non-inbound rows to normal
   `upsertDeliveryEvents`; a legacy authority row cannot roll back the normal
   audit batch. Both subsets remain bounded by the original page
   (`mailboxParityEventPageSize` ≤ DO max), with timeout
   `mailboxParityEventMirrorTimeoutMs` ≈ 5s). Production evidence: per-event 1s
   RPCs repeatedly timed out on a lagging owner and prevented soak under the 10s
   lane budget; page batches restore convergence while live dual-write keeps the
   1s bound. Cursor advances through per-event mirrored/stale/missing results
   and USER-inbound bootstrap skips (so count comparison exposes malformed
   legacy rows); equal `created_at` progresses by id. Uniform
   timeout/error/unconfigured retains the cursor so the next tick reloads the
   same page. Rows deleted before the snapshot load simply do not appear.
4. **Durable content watermark replay** — after both creation phases complete,
   opens a frozen window `(watermark, upper]`
   (`mailbox_parity_content_replay_upper_at` set once when the window opens;
   retained across ticks). Keyset-replays owner messages by `(updated_at, id)`
   within that window; the `(updated_at, id)` cursor persists across incomplete
   ticks. The watermark advances to `upper` only when the full window succeeds.
5. **Count compare + AE signals** — runs only after the event phase and a
   completed content window. Owner-scoped D1 counts vs `Mailbox.countMailbox()`
   for threads, messages, attachments, and delivery events (timeout
   `mailboxParityCountTimeoutMs` ≈ 5s). Production evidence: after event
   backfill completed, tracked owners repeatedly hit `countMailbox timed out`
   under the live 1s mirror bound and could not advance soak; the scheduled lane
   uses a longer count-only bound while live dual-write mirrors stay at 1s. Each
   comparison emits one `mailbox_parity:<operation>` Analytics Engine row with
   `double2 = d1Count - doCount`.

Parity progress persists on `users` (migration `0125-mailbox-parity-state.sql`).
D1 remains mail authority — the lane never mutates `email_*` rows and does not
flip read authority.

**`matching_since` semantics:** records the start of continuous **exact**
D1↔Mailbox count parity for phase-3 soak tracking. Set on the first exact
compare when null; preserved across successful content replay + exact compare.
Cleared on: creation backfill work in the same tick (`creationBackfilled > 0`),
incomplete/budget-exhausted ticks, mirror retryable failures, content-replay
failure/incomplete, and compare-path errors (`rotateCheckedAt` also clears soak
so a poison tick cannot preserve a false window). Resets `mismatch_count` to `0`
on exact match.

**Count mismatch rebuild:** on mismatch the lane first **must** observe a
successful metadata-only `Mailbox.purge()` (DO SQLite / alarm state; no R2),
then resets **all** parity cursors, completion markers, content watermark, and
in-flight replay window for a full D1-authoritative rebuild on subsequent ticks
(increments consecutive `mailbox_parity_mismatch_count` and clears soak). If
purge fails (timeout/error), rebuild state is **not** reset — the user stays
ineligible for soak, `last_error` records the failure, and the next ticks retry
purge before advancing cursors.

**Phase 3 owner-facing read cutover (wired, flag default-off):**
`packages/worker/src/email/mailbox-read-cutover.ts` gates app `/account/email`
inbox/detail and MCP `email_message_*` / `email_attachment_get` /
`email_delivery_event_list` through Mailbox when the default-off
`mailbox-read-cutover` flag **and** per-user parity soak both pass:
`mailbox_parity_matching_since` ≥ **2h** (pre-launch; Kent-approved on ~38-user
fleet evidence — **TODO(launch-hardening):** revisit),
`mailbox_parity_checked_at` fresh within 6h,
`mailbox_parity_mismatch_count === 0`, exact `stable_user_id` match,
`deleting_at IS NULL`. D1 dual-writes remain. Provider reverse lookup, outbound
reply/message-id lookup, inbound, and package-subscription reads stay on D1.
When the gate is on, DO errors propagate with no D1 fallback. Raw MIME / R2
attachment bytes still load through existing blob helpers after Mailbox metadata
selection.

**Operator enable prerequisite (before flipping the flag):** confirm a sealed DR
day covering D1 + `EMAIL_BLOBS` under
[disaster recovery](../disaster-recovery.md) — bucket `kody-production-backups`
in the DR (KCD) account, latest `daily/full/<day>/manifest.json` with verified
stored-object digest/checksum, and
`admin_mailbox_maintenance({ action: "status" })` showing `matching`/`eligible`
counts with `mismatch`/`error` at zero for the target cohort. Deploy first; then
enable per user.

**Retention** is self-enforced inside the DO with alarms
(`mailboxMessageRetentionDays = 365`, `mailboxDeliveryEventRetentionDays = 90`).
Alarm-driven deletes derive canonical blob keys from `ownerId` + row ids (rather
than trusting stored key strings), then apply strict blob-before-row ordering
for `EMAIL_BLOBS` (failed blob deletes skip the row for retry). Each alarm or
owner-bound `runRetentionNow({ ownerId })` invocation selects and revalidates at
most one R2-backed message inside one safe concurrency gate; queued live writes
run before a continuation turn can select another message. SQLite-only expired
delivery-event and orphan-thread cleanup remains batched at 100 rows. Successful
work with expired rows remaining schedules a near-immediate continuation
(`mailboxRetentionContinuationDelayMs`). An R2 failure writes a durable
per-message hourly `retry_at` (`mailboxRetentionRetryDelayMs`); candidate
selection skips that message until due, so a failing oldest message cannot
head-of-line block newer eligible candidates. Alarm scheduling chooses the
earliest eligible continuation, retry due-time, or ordinary future retention
due-time. Write-path alarm selection never postpones an earlier existing alarm
under sustained writes (near-equal times within skew keep the existing alarm).
`alarm` and the RPC share natural production cutoffs and the same post-pass
alarm reschedule; the RPC returns before/after `countMailbox` aggregates plus
`blobDeleteFailures` / `expiredRemaining` (no row ids or content).

**Admin accelerated coverage** (`admin_mailbox_maintenance`;
`packages/worker/src/admin/mailbox-maintenance.ts`): audited admin-only
discriminated actions — `status` (aggregate tracked/matching/mismatch/error/
incomplete/eligible counts plus matching/check timestamps and earliest cutover;
no email content), `reconcile` (bounded `reconcileMailboxParity`, `batch_size`
max 100, then status), `retention` (natural cutoffs only), and `delete_message`
(owner-scoped single-message canary delete):

1. Run existing D1 `pruneUserEmailMessagesForRetention` then
   `pruneEmailDeliveryEventsForRetention` (bounded batches; message prune keeps
   blob-before-row authority during expand).
2. Keyset-page non-deleting non-system owners with mail/parity state by
   `stable_user_id ASC` (`start_after_user_id` / `nextStartAfter` / `truncated`;
   never parity `checked_at` ordering; `limit` default/max 20).
3. Before each owner DO pass, check for remaining natural-cutoff-expired D1
   `email_messages` (`emailMessageRetentionDays` = 365) or
   `email_delivery_events` (`emailDeliveryEventRetentionDays` = 90). If any
   remain (e.g. omitted by the global oldest-first batch), skip
   `runRetentionNow`, count `pendingD1Owners`, and still advance the cursor so
   repeated global D1 batches can drain — never DO/R2-delete while D1 expired
   rows remain for that owner.
4. Otherwise call owner-bound `Mailbox.runRetentionNow` with concurrency ≤4 and
   a ~10s wall budget (stop scheduling new owners after the deadline; cursor is
   the last considered owner). Per-owner failures are isolated.

`delete_message` takes `stable_user_id` + `message_id`. For USER owners it
verifies message existence and captures canonical raw-MIME/attachment refs from
Mailbox metadata; `system:email` explicitly uses D1. It deletes canonical blobs
and D1 compatibility rows through `deleteEmailMessageById` (`APP_DB` +
`EMAIL_BLOBS`, `expectedUserId` fence), then deletes USER Mailbox metadata.
Exact captured keys are verified absent via `head`. Returns aggregate
booleans/counts only (no addresses, bodies, filenames, or keys). Audit success
reason includes the target ids.

Retention returns D1 delete/error totals plus aggregate Mailbox before/after
counts (no message ids or email content). No seed or arbitrary-cutoff surface.

Account deletion uses one owner-bound Mailbox object (no D1 id scan). Before
purge it exhaustively pages `listBlobReferences`, deletes those canonical keys
and the defensive `EMAIL_BLOBS` owner prefixes, and aborts on any inventory or
cleanup warning. Only then does it call `Mailbox.purge()` (result key
`mailboxes`). Purge clears DO SQLite/alarm state and reinitializes schema; it
does **not** delete R2 objects. D1 `email_*` compatibility projections are still
deleted in the final atomic D1 batch until step 5. Account export pages the sole
authoritative USER graph through the `mailbox` section (`exportMailbox` /
`countMailbox`), excludes the four D1 graph tables, and uses
`listBlobReferences` for USER email R2 bytes.

### Expand/contract phases

This is an expand/contract migration. **Step 3 internal-reader cutover is wired
on top of phase 2 USER inbound authority + graph dual-write + parity:** live
dual-write covers outbound terminal message/thread/attachment/event graphs,
provider delivery-queue graph repair (`recorded` / `duplicate` / `stale` with a
message, via `waitUntil`), user classification (full graph repair after D1
update via `service.ts#setEmailMessageClassification`), high-risk inbound
terminal paths (received graph + rejected delivery-event mirror + post-effects
event re-mirror; `waitUntil`; no Mailbox before D1/R2 finalization; pre-claim
bounded rejections parity-lane only; `system:email` excluded). Mirror helpers
emit automatic namespaced outcome telemetry (`missing` and `timeout` included).
Message and batch event repair each use one 1s-bounded RPC; each graph attempt
emits at most two AE writes; event repair batches up to 100 events with explicit
truncation (newest retained, chronological insertion restored, stable truncation
warning) and one batch telemetry outcome. Live explicit and retention deletes do
not call Mailbox mirror helpers; the every-5-minute queue-isolated
`mailbox_parity` lane backfills all owner messages and delivery events
(including pre-claim bounded rejection rows), durable content-watermark replays,
compares owner-scoped D1 vs Mailbox counts, persists soak state on `users`
(migration `0125`), re-purges the DO when account deletion races the lane, and
repairs delete drift via purge/rebuild. Direct delete wiring is pending. D1
remains write authority for message graphs and non-USER-inbound delivery events;
USER inbound lifecycle and effect transitions are owner-bound Mailbox CAS,
synchronously projected to D1. Owner-facing inbox/API graph reads may use
Mailbox when the default-off `mailbox-read-cutover` flag and parity soak pass.
Internal USER effect/package payload readers, signed-in `stored_email_messages`
usage, account export, and account R2 inventory use fail-closed Mailbox RPCs
without a D1 fallback; `system:email` stays explicitly D1-backed. **Phase 2
contract completion** (every user-mail D1 mutation also writes the DO on live
paths, including retention deletes) remains pending; terminal inbound + parity
cover the high-risk live surface today.

1. **Additive scaffold / no live mail behavior** — bind `Mailbox`, freeze
   `idFromName(userId)`, ship client + `mirrorMessage` / `upsertDeliveryEvent` /
   `upsertDeliveryEvents` / `exportMailbox` / `countMailbox` / `purge` RPCs and
   alarm retention, and register account deletion/export consumption. No
   dual-write; D1 remains sole authority for live mail.
2. **D1-authoritative dual-write + parity** — every user-mail mutation that
   writes D1 also writes the DO; parity counters and reconciliation prove DO
   completeness against D1. D1 stays authoritative for reads. Library surface:
   `email-owner.ts`, `mailbox-types.ts`, `mailbox-snapshots.ts`,
   `mailbox-snapshot-repo.ts`, `mailbox-mirror.ts`, `mailbox-live-mirror.ts`,
   `mailbox-mutations.ts` + matching DO RPCs (`touchThread`,
   `updateMessageDelivery`, `setMessageClassification`, `deleteMessageMetadata`,
   `deleteDeliveryEvent`, `deleteThreadIfEmpty`, `upsertDeliveryEvents`), and
   `mailbox-parity-events.ts`, `mailbox-parity-repo.ts`,
   `mailbox-parity-phases.ts`, and `mailbox-reconcile.ts`. **Live today
   (terminal inbound + parity):** outbound terminals, provider delivery-queue
   outcomes with a message (`recorded`, `duplicate`, `stale`; `waitUntil`), user
   classification (`service.ts#setEmailMessageClassification`), inbound terminal
   paths in `inbound.ts` (received graph via `waitUntil` only after D1/R2 +
   finalization; rejected delivery-event mirror; post-effects event re-mirror;
   already-received idempotent repair; pre-claim bounded rejections parity-lane
   only; `system:email` excluded) call the live mirror helpers; graph repair
   uses message RPC + one batch event RPC (at most two AE writes per attempt).
   The every-5-minute `mailbox_parity` scheduled lane backfills all owner
   messages and delivery events, durable content-watermark replays, count
   compares, soak tracking on `users` (migration `0125`), and repairs delete
   drift via purge/rebuild. USER inbound delivery lifecycle/effect state is the
   exception: Mailbox is authoritative and D1 is its synchronous compatibility
   projection. **Still pending for phase-2 contract completion:** direct delete
   wiring for explicit/retention deletes (including retention sweeper
   metadata-delete mirrors). D1 remains write authority for the message graph
   and non-USER-inbound events; owner-facing inbox/API read cutover remains
   behind the default-off flag.
3. **Reader/account cutover in staged substeps** — internal USER product reads
   now pass through `mailbox-internal-read.ts`: message, attachment, count,
   export, and blob-reference reads fail closed against the owner Mailbox with
   no feature flag or D1 fallback. `system:email` message/attachment/count reads
   explicitly remain D1. Inbound effects load the repaired USER message and
   package attachment payload from Mailbox. Signed-in/user-owner
   `stored_email_messages` usage reads `Mailbox.countMessages`; compatibility
   system/admin fleet aggregates may still count D1 until step 4/5. Account
   export treats Mailbox as the sole USER graph, and account deletion captures
   Mailbox blob refs before R2 deletion and Mailbox purge. D1 graph-write
   fences, recovery reads, projection deletion, parity/backfill, and retention
   remain. App inbox/detail and MCP list/get/search/attachment/delivery-event
   reads move to the DO only after production parity soak is verified
   (`mailbox_parity_matching_since` ≥ 2h continuous exact counts pre-launch —
   TODO(launch-hardening) revisit, fresh `mailbox_parity_checked_at`, zero
   `mailbox_parity_mismatch_count`, account not marked for deletion) **and** the
   default-off `mailbox-read-cutover` flag is enabled per user. Live gate
   evaluations record flag exposures (session cache or cutover memo chokepoint).
4. **D1 write-off / event retirement** — stop writing moved user-mail metadata
   to D1; retire dual-write and event/mirror machinery used only for the
   migration.
5. **Later contract migrations** — drop retired D1 user-mail tables/columns only
   after verification. No premature schema deletion.

The every-5-minute `mailbox_parity` scheduled lane (queue-isolated sibling in
`scheduled-lanes.ts`) owns backfill of all owner messages and delivery events,
durable content-watermark replay, count parity, soak state on `users`,
metadata-only DO purge + full rebuild on count mismatch, and best-effort
`Mailbox.purge()` when account deletion races the lane. This Mailbox track owns
DO storage semantics, alarm retention, and the inbound durability boundary
below.

### What stays in D1

- **Operator system-email inbox** — remains permanently in D1 for cross-account
  admin access, fixed bounded caps, and separate system-email retention. The
  dedicated `system_email_*` graph is authoritative; legacy `system:email` rows
  are atomic rollback mirrors through step 5. Both copies stay excluded from
  account deletion and export (`accountUserDataExcludedOwnerIds` and
  `accountOperatorOwnedD1Surfaces`). Operator mail is never migrated into
  per-user Mailbox objects.
- **Low-write email config** — sender identities, inboxes, inbox addresses,
  sender rules, and similar low-churn configuration stay in D1.
- **Provider-message reverse lookup** — outbound Cloudflare sending webhooks
  resolve owner/message through the derived D1 table
  `email_outbound_provider_index` (migration
  `0128-email-outbound-provider-index.sql`), keyed by
  `(provider, provider_message_id)` with `user_id`, `message_id`, `inbox_id`,
  and created/updated timestamps (indexes on `user_id` and unique `message_id`).
  `email_messages.provider_message_id` remains authoritative: outbound inserts
  with a provider id and `updateEmailMessageDelivery` commit the message row
  plus index sync in one `db.batch` (index owner/inbox fields come from the
  authoritative message row, never caller input). `message_id` references
  `email_messages(id)` with `ON DELETE CASCADE`, so message deletes clear index
  rows; account deletion still inventories/deletes by `user_id` for coverage.
  Outbound send separates provider acceptance from terminal D1/index
  persistence: once the provider returns a `providerMessageId`, persistence uses
  bounded D1 retries and must not mark the message `failed`, clear the id, or
  resend. Account export treats the table as derived global lookup
  (`includeInExport: false` / `derivedData.email_outbound_provider_index`)
  because authoritative outbound message rows are already exported.
  `recordProviderEmailDeliveryEvent` resolves index-first, then loads the
  owner-scoped message by `user_id`/`message_id` (no full-table provider scan).
  System outbound is unsupported, and the verified `no-system-provider-links`
  disposition means `system:email` rows are never added to this legacy-FK index.
  Aggregate parity (`loadOutboundProviderIndexParityReport`; counts only) is
  surfaced on `admin_mailbox_maintenance` `status.outboundProviderIndex` for
  production verification. Contextless provider-id reverse lookups must not
  enumerate per-user Mailbox objects or resolve a system compatibility mirror.

### Inbound durability boundary (USER Mailbox authority)

For USER mail, the owner-bound Mailbox ledger is the lifecycle/effect authority:

1. Mailbox CAS selects the dedupe winner. UserMeter consumes quota for that
   winner, then Mailbox inserts the charged pending snapshot. The charged
   pending snapshot is synchronously projected to D1.
2. Thread prework, R2 raw-MIME put, and D1 message/attachment storage build the
   message graph. D1 remains authoritative for that graph.
3. Mailbox CAS finalizes the delivery as `received` or `rejected`. A received
   snapshot is synchronously projected to D1 and fence-critical projection
   failures fail closed. Rejection projection is best-effort because Mailbox has
   already made the SMTP rejection permanent; rejected terminal work
   read-repairs D1.
4. Received terminal work repairs the D1-authoritative message graph into
   Mailbox without delivery events, runs externally executed effects under
   Mailbox leases, then read-repairs the Mailbox → D1 projection.

Retries inspect Mailbox state and never restore USER delivery authority from D1.
The sole reverse bridge is a missing-row-only bootstrap of a validated,
owner/provider-matched pre-deploy D1 snapshot. Malformed or cross-owner legacy
rows are skipped. Pre-claim bounded rejection audit rows remain D1-only.

`system:email` is the explicit exception: its inbound lifecycle, effects, and
reconciliation use the dedicated D1 graph and never bootstrap a Mailbox or read
the legacy compatibility mirror.

If attachment commit fails but message cleanup (or a residual probe) cannot
prove the pre-commit state, the handler acknowledges the already-created message
rather than risking a duplicate on Email Routing retry. Empty-thread cleanup
stays deferred.

### Package state model

Saved packages are the only top-level persisted primitive. Their state maps onto
storage homes as follows:

- **Package source** — Cloudflare Artifacts repos + D1 `entity_sources`
  projections; `package.json` is authoritative.
- **Package config** — D1/secret/value rows keyed by the saved package id
  (manifest metadata, package-scoped secrets, app-scoped values with
  `appId = packageId`).
- **Package storage** — StorageRunner bucket
  `package:{encodeURIComponent(packageId)}` via `buildPackageStorageId` /
  `packageStorage()`. Shared durable data for every package surface.
- **Package coordination** — `PackageServiceInstance` DO holds lifecycle and
  alarms only; durable data stays in package storage. Each lifecycle projection
  dual-writes D1 `package_service_states` (enumeration/parity) and UserMeter
  (authoritative running counts). App facets and package-internal DO namespaces
  are extra StorageRunner buckets under the package id, not a general actor
  model.
- **Package jobs** — schedule metadata in D1 `jobs`; run-local scratch in
  `job:package-job:{packageId}:{encodeURIComponent(jobName)}`; shared durable
  data in package storage.

## Per-user Durable Object naming

The Durable Objects whose state is intrinsically owned by one user are named so
that two different users always resolve to two different object ids. Builders
live in `packages/worker/src/user-scoped-durable-object-name.ts` (JSON tuples
via `durableObjectNameFromParts`); domain helpers such as
`userScopedConnectorSessionKey` delegate to that module.

- `JobManager` — `jobManagerDurableObjectName(userId)` → `idFromName(userId)`.
- `RunLog` — `runLogDurableObjectName(userId)` → `idFromName(userId)`. One
  execution-history DO per user; there is no `user_id` column inside it because
  the DO identity is the user. Hosts pruned run history, the invocation ledger,
  and dedicated unpruned state (workflow projections, job-run observability,
  package activation counters/milestones). See [Run records](./run-records.md).
- `UserMeter` — `userMeterDurableObjectName(userId)` → `idFromName(userId)`. One
  daily-entitlement meter DO per user (untrimmed stable id, same as `RunLog`),
  plus optional schema-v4 D1 storage-byte shadow and schema-v5 package-service
  liveness shadow. See [Entitlements](./entitlements.md#usermeter-expand-phase).
- `StripePlanRefresh` — `stripePlanRefreshDurableObjectName(userId)` →
  `idFromName(userId)`. One ephemeral, one-shot reconciliation alarm per user;
  checkout and subscription webhook activity arm it as a backstop to the
  immediate Stripe refresh. Account deletion cancels and purges the alarm.
- `Mailbox` — `mailboxDurableObjectName(userId)` → `idFromName(userId)`. One
  email-metadata DO per user (untrimmed stable id, same as `RunLog`). See
  [Mailbox](#durable-objects-mailbox).
- `McpClientHub` — `mcpClientHubDurableObjectName(userId)` →
  `idFromName(userId.trim())`.
- `StorageRunner` — `storageRunnerDurableObjectName(userId, storageId)` →
  `idFromName(JSON.stringify([userId, storageId]))`.
- `PackageRealtimeSession` —
  `packageRealtimeSessionDurableObjectName({ userId, packageId })`.
- `PackageServiceInstance` —
  `packageServiceInstanceDurableObjectName({ userId, packageId, serviceName })`.
- `RemoteConnectorSession` —
  `userScopedConnectorSessionKey({ userId, instanceId })`, where `instanceId` is
  the explicit user-chosen connector name (globally unique per user). Connectors
  must connect through the username-scoped ingress URL
  `/@{username}/connectors/{connectorName}`. Renaming a connector changes this
  DO id; the old live session snapshot can be orphaned, but reconnecting
  rebuilds it from settings. The DO carries the ingress user id forward via
  headers + websocket attachment and verifies the shared secret against that
  user's row only.
- `RepoSession` — `repoSessionDurableObjectName(sessionId)` keyed by
  `repo_sessions.id` only (not user-prefixed). Every RPC validates the D1
  session row's `user_id` before touching the workspace. Account deletion
  enumerates the user's session ids before deleting D1 rows and purges each DO.
  Documented exception to user-scoped naming.
- The `MCP` Durable Object is addressed by MCP session id rather than user id;
  ownership is enforced at the request boundary by validating the authenticated
  user against the `McpCallerContext` on every request.

## Per-user runtime context (no shared `globalThis`)

Kody `execute` calls and package-app worker entrypoints store the current
request's runtime in an `AsyncLocalStorage` shared between the wrapper and the
`capabilities:runtime` virtual module via `Symbol.for('kody.runtimeStorage')`.
Two concurrent calls in the same isolate observe their own runtime view through
the ALS rather than racing on a shared mutable `globalThis` slot. See
`packages/worker/src/package-runtime/module-graph.ts`,
`packages/worker/src/mcp/run-kody-registry.ts`, and
`packages/worker/src/package-runtime/package-app.ts` for the wrapper
implementations, and
`packages/worker/src/package-runtime/runtime-isolation.node.test.ts` for the
concurrent two-runtime test that pins this invariant.

`capabilities:runtime` is also a host-external package-runtime module. Saved
package bundle artifacts reserve `.__kody_virtual__/runtime.js` import paths but
strip the runtime source before persistence. Execution loaders hydrate those
paths with the deployed host runtime source for every package surface (exports,
subscriptions, jobs, services, package apps, workflows, and ad hoc execute).
Static `kody:@...` package imports remain pinned snapshots, while literal
dynamic `import("kody:@...")` imports (deprecated in agent guidance in favor of
`packages.invoke`) are hydrated at execution time from the current published
package export under the caller's `userId`.

## Configuration reference

Bindings are configured per environment in `packages/worker/wrangler.jsonc`
(names and bindings only; remote D1/KV IDs come from deploy-generated configs):

- `APP_DB` (D1)
- `AUDIT_DB` (D1, global hashed security audit trail)
- `OAUTH_KV` (KV)
- `BUNDLE_ARTIFACTS_KV` (KV)
- `EMAIL_BLOBS` (R2, raw email MIME blobs)
- `MCP_OBJECT` (Durable Objects)
- `REMOTE_CONNECTOR_SESSION` (Durable Objects)
- `JOB_MANAGER` (Durable Objects)
- `RUN_LOG` (Durable Objects; per-user run records — see
  [Run records](./run-records.md))
- `USER_METER` (Durable Objects; per-user daily entitlement counters — see
  [Entitlements](./entitlements.md#usermeter-expand-phase))
- `STRIPE_PLAN_REFRESH` (Durable Objects; per-user, activity-driven Stripe plan
  reconciliation alarms)
- `MAILBOX` (Durable Objects; per-user email metadata — see
  [Mailbox](#durable-objects-mailbox); phase 1 registers purge/export
  consumption; phase 2 wires terminal inbound + outbound live dual-write without
  changing D1 authority)
- `STORAGE_RUNNER` (Durable Objects)
- `REPO_SESSION` (Durable Objects)
- `PACKAGE_REALTIME_SESSION` (Durable Objects)
- `PACKAGE_SERVICE_INSTANCE` (Durable Objects)
- `MCP_CLIENT_HUB` (Durable Objects; user-added remote MCP servers — see
  [MCP client servers](./mcp-client-servers.md))
- `OAUTH_PURGE_COORDINATOR` (Durable Objects)
- `COMMUNITY_ASSETS` (R2; community listing assets)
- `CAPABILITY_VECTOR_INDEX` (Vectorize; capability/memory/job/package vectors)
- `ASSETS` (static assets bucket)
- `USAGE_EVENTS` (Analytics Engine dataset, production/preview only; see
  [Usage metering](./usage-metering.md))
- `EMAIL_EVENTS` (Analytics Engine dataset, production/preview only; indexed by
  stable user id and read only through role-gated platform aggregates)

`packages/worker/wrangler.jsonc` also configures the `EMAIL` send binding,
dispatch queues, worker loaders (`LOADER` / `APP_LOADER`), the `AI` binding, and
`DYNAMIC_CALLABLE_WORKFLOWS`; the Wrangler config is authoritative.

## Repo-backed source and Artifacts

Repo-backed saved packages, package apps, and jobs use Cloudflare Artifacts
repos plus D1 `entity_sources` / `repo_sessions` rows.

- Primary code lives under `packages/worker/src/repo/`.
- `entity_sources` stores the durable mapping from
  `(user_id, entity_kind, entity_id)` to the repo identity and last published
  commit.
- `repo_sessions` stores mutable editing forks for repo session Durable Objects.
- Published source snapshots and bundle artifacts are stored in
  `BUNDLE_ARTIFACTS_KV` and keyed by `source_id` plus `published_commit`.

Canonical source contract:

- Published repo source is the only canonical source for saved packages, package
  apps, and jobs.
- D1 keeps metadata and projections only. It does not store canonical package
  export code, app backend code, or job code.
- App rows keep display metadata, parameters, visibility, `has_server_code`, and
  `source_id` for app projections.
- Job rows keep scheduling/execution metadata, params, storage id, caller
  context, repo check policy, `source_id`, and the published commit last synced
  into the job projection.
- Saved package rows keep display/search metadata, tags, app availability, and
  `source_id` for Kody search and package discovery.
- Projection updates are made from published repo state by the publish/reindex
  paths; stale D1 inline source fields are not a fallback.

Operational notes:

- Saved packages are the user-facing repo-backed identity. They resolve through
  D1 metadata to `entity_sources.id` when a repo editing session is opened.
- `source_id` is the internal durable join key for repo-backed packages, but
  most MCP callers should prefer package identity with `repo_run_commands`.
- Once repo-backed source exists, the repo snapshot is the durable source of
  truth for later edits and publishes. Search and detail payloads are derived
  projections of that repo-backed source rather than a competing second source
  of truth.
- `repo_run_commands` parses a constrained git-command string and runs it inside
  the repo session Durable Object. It accepts only parsed git command forms, not
  arbitrary shell syntax, and package runtime bundles are loaded from published
  artifacts rather than a mounted checkout.
- `repo_write_file` exposes the same Durable Object's `applyEdits` write path as
  a first-class MCP capability for whole-file overwrites. Prefer it over
  `git apply` heredocs when the agent is replacing an entire file (for example,
  a single-file job source) instead of patching a hunk with surrounding context.

### Direct Artifacts git publishes

Saved package source can also be edited through Artifacts git remotes directly.
`package_get_git_remote` resolves package identity to `entity_sources`, mints a
short-lived Artifacts repo token, and returns both a plain remote and setup
commands that pass the token through `http.extraHeader`.

After an external `git push`, `package_publish_external_push` reconciles the
current Artifacts default-branch HEAD with `entity_sources.published_commit`.
The RepoSession Durable Object clones that commit, checks that it is a
fast-forward unless `allow_force` is set, runs `runRepoChecks(...)`, and then
calls `publishFromExternalRef(...)`.

`publishFromExternalRef(...)` owns the post-receive publish transaction:

- run manifest, dependency, bundle, typecheck, and lint checks before mutation
- advance `entity_sources.published_commit`
- write the `PublishedSourceSnapshot` and manifest snapshot to
  `BUNDLE_ARTIFACTS_KV`
- roll the D1 commit pointer back if KV snapshot persistence fails
- rebuild saved package projections, bundle artifacts, vector search entries,
  retriever manifests, package jobs, and services through
  `refreshSavedPackageProjection(...)`

The same helper is used by the existing repo-session publish path after it has
pushed the session commit to the source Artifacts repo.

### Reconcile cron

`packages/worker/src/jobs/reconcile-artifacts-pushes.ts` is a safety net for
external pushes that were not followed by an explicit
`package_publish_external_push` call. In production, the Worker cron dispatcher
runs every five minutes (`wrangler.jsonc` `*/5 * * * *`) and sends each due
maintenance lane to `kody-scheduled-dispatch`. The consumer is configured for
one message per invocation with independent concurrency, so a slow reconcile
cannot consume the runtime budget of retention, OAuth purge, or another sibling
lane. Preview and local runtimes execute the same registry inline when the
production-only queue binding is unavailable. A write-token mint sets the
source's `external_check_until` to the token expiry plus a one-hour grace
period. The normal pass only scans these pending sources, using
`last_external_check_at` for the five-minute cadence and keyset paging until the
pending queue is drained or a wall-clock time budget (`reconcileTimeBudgetMs`,
~60 seconds) is exhausted. Dormant package sources do not incur an Artifacts
HEAD lookup on every tick.

For each pending source, reconcile resolves the Artifacts default-branch HEAD.
When HEAD matches `published_commit`, it advances `last_external_check_at`
without any Durable Object work; once the token horizon has passed, that final
matching check also clears `external_check_until`. A successful explicit or
reconcile publish clears the pending horizon immediately. Unresolvable or
changed HEADs remain pending, and the RepoSession publish path is spun up only
when HEAD differs.

The reconcile loop is idempotent: if another caller publishes the same commit
first, the publish path returns `already_published`. Check failures and
non-fast-forward results leave D1/KV untouched and are counted in the one-line
metrics log, which also records batches processed and whether the time budget
was exhausted. Once per day during the 03:00 UTC cron window, reconcile also
widens the same keyset scan to every package source as a full-fleet backstop and
calls `revokeStaleArtifactsTokens(...)` for checked repos to clean up expired
Artifacts tokens.

Reconcile runs through the registry in
`packages/worker/src/scheduled/scheduled-lanes.ts`, alongside repo-session
cleanup, system-email retention, general retention, job retention, hourly
usage-rollup aggregation, and the every-5-minute `mailbox_parity` lane
(queue-isolated; up to sixteen users per tick within a ~10s budget; D1 user
discovery including previously tracked empty-mail owners, bounded message +
page-batched delivery-event backfill (~5s batch timeout under the ~10s lane
budget), durable content-watermark replay, metadata-only purge + full rebuild on
count mismatch, and count compare — see [Mailbox](#durable-objects-mailbox)).
Each production queue message preserves `scheduled_lane_failed` / D1
lock-contention log and Sentry context. A handled lane failure is acknowledged
and retried by the next cron tick, matching the old cron semantics. A failed
enqueue is reported and runs through the inline fallback after all sibling
enqueue attempts finish; multiple failed enqueues fall back sequentially to
avoid D1 lock contention. Consumer transport failures retain the configured
retry/DLQ behavior. No failure can abort or mask a sibling invocation.

Production note:

- Production deploys warn that the documented Artifacts Worker binding config is
  unexpected, and deploy logs show no `env.ARTIFACTS` binding in the deployed
  Worker binding summary.
- Because that binding is absent in production, repo source code uses the
  documented Artifacts REST API as the single integration path for
  create/get/token/fork operations.
- `packages/worker/src/repo/artifacts.ts` builds that REST client from
  `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and optional
  `CLOUDFLARE_API_BASE_URL` / `ARTIFACTS_NAMESPACE`, which also makes local dev
  mocking straightforward.
- During `npm run dev`, those REST calls go to the local Cloudflare mock Worker,
  which implements the Artifacts repo metadata endpoints used by the app
  (`create`, `get`, `list`, `createToken`, and `fork`). The mock only covers the
  REST control plane; repo session Durable Objects need a Git-capable remote for
  clone/pull/push flows.
- Durable repo-source creation paths
  (`ensureEntitySource(..., requirePersistence: true)`) fail closed when
  persistence bindings are unavailable so callers do not write orphaned
  `source_id` references into D1.

## Frozen storage contract inventory

This section records identifiers and serialized shapes that should be treated as
permanent unless a planned migration explicitly says otherwise. They are cheap
to document and expensive to discover after user data depends on them.

### D1 JSON shadow schemas

The following columns store JSON whose schema is defined in TypeScript rather
than in D1 constraints. Changes must be backward compatible on read and additive
on write unless a migration backfills existing rows.

- `jobs.params_json`, `jobs.schedule_json`, `jobs.caller_context_json`, and
  `jobs.repo_check_policy_json` (`packages/worker/migrations/0018-jobs.sql`,
  `0025-jobs-repo-check-policy.sql`, `packages/worker/src/jobs/repo.ts`) rely on
  parser and normalizer compatibility. Package jobs persist both
  `storageContext.appId` for value scope and `storageContext.packageId` for
  package-owned secret scope.
- `saved_packages.tags_json` and `community_listings.tags_json`
  (`0027-saved-packages.sql`, `0045-community-listings.sql`) are `string[]`
  projections.
- `published_bundle_artifacts.dependencies_json`
  (`0028-published-bundle-artifacts-and-archived-jobs.sql`) stores package
  dependency pointers queried with SQLite JSON functions in
  `packages/worker/src/repo/published-bundle-artifacts-repo.ts`.
- `package_invocation_tokens.package_ids_json`,
  `package_invocation_tokens.package_kody_ids_json`,
  `package_invocation_tokens.export_names_json`, and
  `package_invocation_tokens.sources_json` (`0029-package-invocations.sql`)
  store invocation-token scope projections. Keyed invocation replay lives in the
  RunLog Durable Object ledger (see [Run records](./run-records.md)); there is
  no D1 `package_invocations` table (`0112-drop-package-invocations.sql`).
- `email_messages.*_addresses_json`, `email_messages.references_json`,
  `email_messages.headers_json`, and `email_delivery_events.detail_json`
  (`0030-email-primitives.sql`, `0031-unified-email-receipt.sql`,
  `0061-email-delivery-lifecycle.sql`) store parsed email metadata and provider
  delivery details. Provider event ids are unique for idempotent Queue
  ingestion; `email_messages.delivery_status` is the latest provider state,
  separate from send-request `processing_status`.
- `webhook_endpoints` (`0090-webhook-endpoints.sql`) stores per-user minted URL
  state for `package.json#kody.webhooks`, keyed by
  `(user_id, package_id, webhook_name)`. URL secrets are SHA-256 hashed;
  verification secrets stay in the secrets primitive (`secretName` at delivery
  time). Delivery history is recorded as `webhook` surface run records (see
  [Run records](./run-records.md) and [Inbound webhooks](./webhooks.md)), not as
  D1 rows.
- `system_email_daily_counters` (`0051-system-email-daily-counters.sql`) stores
  fixed per-local daily receive counters for operator-owned system inboxes.
  These counters are not user entitlements and are pruned by the system-email
  retention job.
- `mcp_memories.tags_json` and `mcp_memories.source_uris_json`
  (`0016-mcp-memories.sql`, `0018-mcp-memory-source-uris.sql`) back memory
  search and provenance.
- `secret_entries.allowed_hosts`, `secret_entries.allowed_capabilities`, and
  `secret_entries.allowed_packages` are JSON string lists used as security
  policy inputs (`0009-secret-allowed-hosts.sql`,
  `0010-secret-allowed-capabilities.sql`, `0023-secret-allowed-packages.sql`).
  Tightening parse-error behavior requires explicit compatibility review.
  `allowed_packages` applies only to user-scoped secrets. Unadopted
  community-forked packages need it for every package read/use path (provenance
  via `community_forks.forked_package_id` + `forker_user_id`; index
  `0073-community-forks-forked-package-index.sql`). Self-authored packages and
  adopted forks (`community_forks.adopted_at` / `adoption_note` from
  `0074-community-fork-adoption.sql`) skip that grant for read/use only.
  Mutations from package code (`secret_set` / `secret_delete` / OpenAPI
  token-refresh writes) always require the grant. Package-scoped secrets are
  owned exclusively by the package id in their bucket binding.
- `user_oauth_apps.extra_authorize_params_json`,
  `user_integrations.scopes_json`, and `user_integrations.required_hosts_json`
  (`0101-user-oauth-apps-and-integrations.sql`,
  `packages/worker/src/integrations/`) store a string→string object, a scope
  string list, and a host string list respectively. Parsers in the integrations
  data-access layer own the shapes; credential values are never stored in these
  columns (only secret names and the inline non-secret `client_id`).
- `user_openapi_bindings.auth_json`, `user_openapi_bindings.selection_json`, and
  `user_openapi_binding_operations.operation_json`
  (`0102-user-openapi-bindings.sql`, `packages/worker/src/openapi/`) store the
  auth discriminant, selection object, and per-operation snapshot object.
  Parsers in the OpenAPI binding service own the shapes; credential values are
  never stored (only secret / integration name references inside `auth_json`).

### Durable Object id contracts

`idFromName` inputs are Durable Object identity. Changing any of these strings
or tuple layouts creates new objects and strands existing object storage. All
builders are centralized in
`packages/worker/src/user-scoped-durable-object-name.ts` (plus
`userScopedConnectorSessionKey` in
`packages/worker/src/remote-connector/connector-session-key.ts`, which delegates
to `durableObjectNameFromParts`).

- `JobManager`: `idFromName(userId)` (no trim).
- `RunLog`: `idFromName(userId)` (no trim); one execution-history DO per user.
- `UserMeter`: `idFromName(userId)` (no trim); one daily-entitlement meter DO
  per user, plus optional schema-v4 D1 storage-byte shadow and schema-v5
  package-service liveness shadow.
- `StripePlanRefresh`: `idFromName(userId)` (no trim); one ephemeral billing
  reconciliation alarm DO per user.
- `Mailbox`: `idFromName(userId)` (no trim); one email-metadata DO per user.
- `McpClientHub`: `idFromName(userId.trim())`.
- `StorageRunner`: `idFromName(JSON.stringify([userId, storageId]))`.
- `RepoSession`: `idFromName(repo_sessions.id)`; the key is not user-prefixed,
  so every RPC must keep validating the D1 row's `user_id`.
- `PackageRealtimeSession`: `idFromName(JSON.stringify([userId, packageId]))`.
- `PackageServiceInstance`:
  `idFromName(JSON.stringify([userId, packageId, serviceName]))`.
- `RemoteConnectorSession`:
  `idFromName(JSON.stringify([userId.trim(), normalizedInstanceId]))`.
- `MCP`: session-keyed by the MCP SDK rather than by user id; OAuth caller
  context is the request-time ownership boundary and `mcp_agent_sessions`
  provides deletion-only enumeration by stable user id.

Storage ids are also stable strings. Changing a form strands the old bucket:

- `exec:{uuid}` — ad hoc execute storage bound on the call.
- `job:{jobId}` — non-package job scratch storage (and the generic job id form).
- `job:package-job:{packageId}:{encodeURIComponent(jobName)}` — package-owned
  job run scratch.
- `package:{encodeURIComponent(packageId)}` — package bucket behind
  `packageStorage()` / `buildPackageStorageId(packageId)`.
- `{packageId}:facet:{facetName}` — package-app facet StorageRunner buckets.
- `{packageId}:{exportName}:{name}` — package-app internal Durable Object
  namespace StorageRunner buckets.
- `service:{encodeURIComponent(packageId)}:{encodeURIComponent(serviceName)}` —
  package service run scratch (lifecycle lives on `PackageServiceInstance`).

### KV key contracts

`OAUTH_KV` is provider-owned by `@cloudflare/workers-oauth-provider`; do not put
app-owned keys in it. App-owned `BUNDLE_ARTIFACTS_KV` keys are:

- `source-snapshot:v1:{sourceId}:{publishedCommit}`.
- `source-manifest-snapshot:v1:{sourceId}:{publishedCommit}`.
- `bundle-artifact:v1:{sourceId}:{commit}:{kind}:{artifactName|_}:{entryPoint}`.
- `community-snapshot:v1:{listingId}`.
- `package-retriever-manifest:v1:{userId}:{packageId}:{revision}`.
- `package-retriever-index-entry:v1:{userId}:{scope}:{packageId}:{retrieverKey}`
  for per-entry retriever index rows.
- `derived-cache:v1:usage-rollups:user:{userId}:asof:{YYYY-MM}` — derived
  per-user usage read model written with KV `expirationTtl`; retention is five
  minutes, so immediate account-deletion cleanup is not required.
- `derived-cache:v1:community-icon:v1:{listingId}:...` — derived community
  listing icon cache; registered as a user-owned KV surface and deleted for a
  user's listings during account deletion.

Account deletion derives these keys from D1 rows and package ids before deleting
D1 projections. New KV prefixes must add corresponding account-deletion coverage
or a deliberate retention note.

### R2 key contracts

App-owned R2 keys are:

- `community-icon:v1/{listingId}/{commit}/asset` — processed public community
  icon bytes at the listing's pinned or icon commit. The listing id is the
  public ownership boundary. Account deletion paginates and strictly deletes
  every key under each D1-owned listing prefix, including historical revisions.

- `user-avatars/{stableUserId}/{contentHash}.{extension}` — profile avatars.
  Account deletion paginates and strictly deletes the complete stable-user
  prefix, including historical replacements left by earlier cleanup failures.

- `email-raw:v1:{userId}/{messageId}` — raw email MIME for the message row that
  stores this key in `email_messages.raw_mime_key`. Built by `emailRawMimeKey`
  in `packages/worker/src/email/blob-keys.ts`. The `userId` prefix is part of
  the per-user isolation contract; account deletion removes a user's blobs under
  the matching prefix (and any remaining inventoried keys).

- `email-attachment:v1:{userId}/{messageId}/{attachmentId}` — standalone
  attachment bytes (`storage_kind = 'external'`). Built by
  `emailAttachmentBlobKey` in `packages/worker/src/email/blob-keys.ts`. Same
  per-user prefix isolation and account-deletion coverage as raw MIME.

New R2 key prefixes must add corresponding account-deletion coverage or a
deliberate retention note, same as KV. All currently registered R2 surfaces use
the bounded `r2_object` account-export section; the inventory is derived from
the same user-owned D1 rows used by account deletion.

### Vectorize metadata contracts

Vector ids, namespaces, and metadata are conventional and require reindexing
when changed. User-owned vectors use the account's 64-character stable user id
as their Vectorize namespace. Builtin capability vectors use the reserved
`__kody_builtin__` namespace; stable user ids are lowercase SHA-256 hex, so the
reserved value cannot collide with an account. Namespace filtering is the
primary isolation boundary and is applied by Vectorize before search. The
`userId` metadata filter remains mandatory on every user-owned query as
defense-in-depth.

User-owned ids must also stay within Cloudflare Vectorize's 64-byte id limit:
builders first emit the legacy passthrough form when it fits, then fall back to
`{prefix}_sha256:{truncatedHexDigest}` for overlong raw ids. Length checks are
UTF-8 byte checks, not JavaScript string-length checks, and the digest form is
deterministic so upserts and deletes target the same vector.

- Memories: `memory_{memoryId}` in namespace `{userId}`, with metadata
  `{ kind: 'memory', userId, status, category? }`. Memory ids are UUID-like, so
  search parses only the passthrough `memory_` form back to the D1 id.
- Jobs: `job_{jobId}` or `job_sha256:{digest}` with metadata
  `{ kind: 'job', userId }` in namespace `{userId}`. Package-owned job ids
  `package-job:{packageId}:{jobName}` often need the digest form.
- Saved packages: `package_{packageId}` or `package_sha256:{digest}` with
  metadata `{ kind: 'package', userId }` in namespace `{userId}`.
- Builtin capabilities: id is the capability name in namespace
  `__kody_builtin__`, with metadata `{ kind: 'builtin', domain }`.

The namespace migration uses expand/contract reads. Each query searches both the
intended namespace and the legacy default namespace with the same metadata
filter, then deduplicates, ranks, and limits the combined matches. This keeps
partially reindexed accounts complete without weakening user isolation. The
post-deploy `POST /__maintenance/reindex-capabilities` sweep keyset-pages every
memory, job, and saved package from D1 (200 rows per page) and upserts it into
the owner's namespace; it also rebuilds builtins in their reserved namespace.
The deploy is not considered migrated until every phase reports no `error` or
`failed` vectors. Remove the default-namespace read in a follow-up contract
deploy only after a production full sweep succeeds and the next deploy confirms
normal namespaced search. Vectors are derived from D1, so no canonical data is
moved or deleted during this migration.

### `entity_sources` and package import contracts

`entity_sources` is the durable repo pointer table:
`(user_id, entity_kind, entity_id) -> source_id`. Child tables store
`source_id = entity_sources.id`; KV snapshots use that same source id plus the
published commit. `entity_kind` accepts `job` and `package`. `manifest_path`,
`source_root`, `published_commit`, `indexed_commit`, and
`last_external_check_at` are part of the repo-source synchronization contract.

Saved package imports in user code use `kody:@scope/name/export` specifiers:

1. `packages/worker/src/package-runtime/package-import-resolution.ts` parses the
   `kody:@` prefix, the `@scope/name` package name, and an optional export
   subpath (default `.`).
2. Resolution is scoped to the caller's `userId`; community package scopes do
   not grant cross-user imports.
3. `packages/worker/src/package-registry/manifest.ts` normalizes export keys and
   resolves them through `package.json#exports`.
4. Static imports are pinned into bundle dependencies at publish time. Literal
   dynamic `import("kody:@...")` calls (deprecated in agent guidance in favor of
   `packages.invoke`) resolve at runtime to the caller's current published
   package export.

Do not change this grammar or static/dynamic distinction without a user-code
migration plan.

### Growth and retention policies

The Worker cron dispatcher runs every five minutes, but
`packages/worker/src/app/retention.ts` gates the general retention job to the
top of the hour. Production dispatches it as its own queue invocation; preview
and local runtimes run it inline. Each hourly run loops in round-robin passes
over the policy tables — every pending table gets one configured batch before
any table gets a second one — until every table is drained or the run's time
budget (`retentionRunTimeBudgetMs`, ~20 seconds measured with `Date.now`) is
exhausted. The first pass always completes so a hot table cannot starve the
others, and per-batch sizes stay small to bound D1 single-writer pressure.
Progress is reported with a one-line `retention-prune` log that includes
batches-per-table counts and whether the budget ran out. The retention module
owns the named constants and manifest, and
`packages/worker/src/app/retention.node.test.ts` fails if a future
growth-pattern D1 table is added without either a policy or a documented
exemption.

Current retention policies:

- `mcp_memory_conversation_suppressions`: keep active suppressions and prune
  expired rows only after they have not been seen for 90 days. The existing
  request-time memory prune may remove expired rows sooner.
- `workflow_runs`: keep terminal projections (`complete`, `errored`,
  `terminated`) for 90 days based on `completed_at` / `updated_at` /
  `created_at`. Non-terminal workflow rows are never pruned by retention.
- `published_bundle_artifacts`: delete D1 rows and their `BUNDLE_ARTIFACTS_KV`
  blobs only when the row is older than 30 days, its `published_commit` is no
  longer current for any matching `entity_sources` row, and there is no active
  repo session for the source. When a row is pruned, the matching
  `source-snapshot:v1:{sourceId}:{commit}` and
  `source-manifest-snapshot:v1:{sourceId}:{commit}` KV keys are deleted under
  the same safety conditions, so per-commit snapshots do not accumulate
  indefinitely. Ambiguous publish/edit cases are intentionally kept.
- `email_delivery_events`: user-owned delivery events keep 90 days. System email
  is governed by the dedicated system-email retention job, which prunes
  messages, external attachment objects, raw-MIME blobs, and delivery events
  older than 90 days in parameter-bounded batches within its own time budget,
  deletes stale `system_email_daily_counters`, caps stored system messages at
  5,000, and prunes orphan threads. All R2 objects are deleted before dedicated
  metadata; a failure preserves authority rows for retry. Each successful D1
  delete removes the legacy compatibility mirror in the same batch. The four
  dedicated `system_email_*` tables therefore have explicit `alternate_cleanup`
  dispositions. After Mailbox cut-over, user-owned delivery-event retention
  moves to the per-user Mailbox DO alarm (still 90 days, strict
  blob-before-row).
- `email_messages` / `email_attachments` / `email_threads`: user-owned messages
  (excluding the `system:email` owner) keep 365 days, deleted oldest first in
  batches. Retention deletes the deterministic
  `emailRawMimeKey(userId, messageId)` from `EMAIL_BLOBS` before D1 rows; if the
  blob delete fails, those rows are skipped and still selected on later runs so
  cleanup can retry. Dependent `email_attachments` rows and derived
  `email_outbound_provider_index` rows are deleted before their messages, and
  threads left with no messages are pruned for the affected users. After Mailbox
  cut-over, the same 365-day window and blob-before-row ordering are
  self-enforced by the Mailbox DO alarm; `system:email` stays on the D1
  system-email retention job. System mail has no provider-index rows.
- `entitlement_daily_counters`: **retired** — dropped by migration
  `0126-drop-entitlement-daily-counters.sql` after stages 1/2 stopped mirror
  writes and detached runtime inventory. No scheduled retention disposition or
  pending-drop coverage remains. Daily counter retention lives in the per-user
  `UserMeter` DO (`userMeterDailyCounterRetentionDays`);
  `admin_user_meter_parity` reports `daily.mirrorRetired: true`.
- `usage_rollups`: per user/metric/month rollups keep 24 months by `month` key;
  raw Analytics Engine usage events follow platform retention.
- `feature_flag_exposure_rollups`: local-dev/test flag exposure rollups keep 90
  days by `day` key, matching Analytics Engine retention for the production
  `FLAG_EXPOSURES` exposure stream; the admin metric readout window is the
  current month.
- `platform_feedback`: open and triaged rows remain until review changes them to
  resolved or dismissed, or the submitter deletes their account. Resolved and
  dismissed rows keep 365 days after `updated_at`; submitter deletion removes
  any remaining rows.
- `audit_events`: global hashed auth/security audit events live only in the
  dedicated `AUDIT_DB` database. All persisted writes, admin reads, insights,
  and auth-denial alerts use that binding; the hourly retention lane prunes rows
  after 180 days. Audit events are not user-owned and remain independent of
  account deletion/export.
- `stripe_webhook_events`: platform Stripe webhook idempotency rows keep 30 days
  by `processed_at`. They are not user-owned and remain independent of account
  deletion/export.

Migration `0055-retention-indexes.sql` adds the global time-column indexes these
prunes order by (`created_at` / `day` / `month` / `started_at` across users);
per-user composite indexes cannot serve those ordered scans.

Documented exemptions: `archived_job_artifacts` is exempt because job artifact
cleanup is driven by each row's `retain_until` value, `jobs` are cleaned by the
hourly `job_retention` sweeper (account/platform retention windows; package and
preserved jobs stay until explicit delete, package sync, or account deletion),
and `mcp_memories` is exempt because memories are durable user-curated content
removed by explicit user action or account deletion rather than by time-based
retention.
