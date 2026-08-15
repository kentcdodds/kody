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
`admin`). The permanent D1 tables are `system_email_threads`,
`system_email_messages`, `system_email_attachments`, and
`system_email_delivery_events`. They omit `user_id` because the operator owner
is implicit. They are the sole live `system:email` graph authority. The reserved
id is not a login account and must not be conflated with the `kody@example.com`
fixture or Kent's personal account. Account deletion and export treat these
tables as platform/operator content in `accountOperatorOwnedD1Surfaces`, with
guardrail tests.

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

All four dedicated `system_email_*` graph tables are intentionally excluded from
account deletion. They are operator-owned mail for reserved platform addresses,
not portable user content. The scheduled system-email lane applies its 90-day
age policy, 5,000-message cap, and blob-before-row deletion against the
dedicated authority.

Platform-feedback rows follow two account-deletion behaviors. Deleting the
submitting account deletes its submissions. When a deleted account was an admin
reviewer for another user's surviving submission, deletion clears the reviewer
reference so the row does not retain attribution to a nonexistent account.

Deletion must cover these user-owned surfaces:

- **D1:** every live table with `user_id` / `*_user_id` ownership columns, plus
  transitive children (`secret_entries`, `value_entries`) and listing children
  for community-owned listings. The guardrail test in
  `packages/worker/src/account/data-targets.node.test.ts` applies the live
  migrations to SQLite and fails if a user-owned schema column lacks schema
  coverage in the runtime target list or if that list references a stale column.
- **Durable Objects:** `JobManager`, `StorageRunner`, `RepoSession`,
  `RepoSessionIndex`, `RemoteConnectorSession`, `PackageRealtimeSession`,
  `PackageServiceInstance`, `McpClientHub`, `RunLog`, `UserMeter`,
  `StripePlanRefresh`, and `Mailbox` are purged through account-deletion RPCs
  after their identifiers are collected (`RunLog`, `UserMeter`,
  `StripePlanRefresh`, `Mailbox`, and `RepoSessionIndex` are one object per user
  and need no D1 id scan). Account deletion first captures the authoritative
  USER raw-MIME and attachment references through `Mailbox.listBlobReferences`,
  deletes those owner-safe R2 keys plus defensive owner-prefix sweeps, and only
  then calls `Mailbox.purge()`. The purge clears DO SQLite only (see
  [Mailbox](#durable-objects-mailbox)). `MCP` objects remain SDK session-keyed,
  while `mcp_agent_sessions` indexes each Durable Object id by authenticated
  stable user id so account deletion can purge stored props, conversation state,
  raw-fetch state, and transport storage before revoking OAuth grants.
- **Vectorize:** memory, job, and saved-package vector ids are derived from D1
  rows and removed with `deleteByIds`.
- **R2:** raw USER email MIME and attachment blobs in `EMAIL_BLOBS` are
  inventoried by `Mailbox.listBlobReferences`; the Mailbox store derives raw
  keys from owner/message ids and emits only canonical external-attachment keys.
  Deletion also performs per-user prefix cleanup (`email-raw:v1:{userId}/` and
  `email-attachment:v1:{userId}/`) as defense in depth. A failed inventory or
  object delete aborts Mailbox purge and D1 finalization, preserving the
  deletion marker and Mailbox rows for retry. Rows owned by `system:email` keep
  their blobs here (they are not user data); those blobs are removed when
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
`buildUserScopedTargetMatch`); export redaction columns also live there.
Out-of-band surfaces (Durable Objects, KV schemes, R2, Vectorize, Artifacts) are
declared in `account-user-owned-surfaces.ts` and consumed by both deletion and
export. Growth-table retention dispositions are linked in
`account-retention-dispositions.ts`.
`packages/worker/src/account/export.node.test.ts` applies the live migrations to
SQLite and fails if a `user_id` / `*_user_id` column is not covered by the
export list. The hard invariant is the same as every storage path: callers pass
the authenticated user's stable MCP `userId`, and every query or Durable Object
lookup is scoped to that id.

Dedicated `system_email_*` rows are intentionally absent from account exports
for the same reason they are absent from deletion: they belong to the operator
inbox surface, not to the exporting user. The export manifest lists the
omissions under `excludedD1Surfaces` so they are explicit. Daily entitlement
counters live only in `UserMeter`, so they do not appear in the D1 inventory or
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
- `d1` — user-scoped D1 rows grouped by table. USER email graph rows are
  exported only through the authoritative Mailbox section.
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
  the `UserMeter.exportCounters` RPC (daily counters plus authoritative
  `storageBytesState`, `packageServiceStates`, and sanitized `deletionState` on
  the first page only when present). Mailbox metadata uses `section: "mailbox"`
  and the `Mailbox.exportMailbox` RPC. R2 raw MIME, attachment, avatar, and icon
  objects use `section: "r2_object"`; each response contains at most one 256 KiB
  base64 chunk and an opaque cursor. Each request uses bounded `LIMIT 1`
  ownership queries rather than reconstructing inventory. Continuation cursors
  bind the source row, object key, size, and ETag; ownership/key mutations and
  object overwrites are reported instead of mixing generations. Missing objects
  are represented explicitly. R2 cursor version 1 is unsupported by the current
  Mailbox-authoritative traversal because translation could duplicate bytes;
  callers must restart the `r2_object` section without `startAfter`.

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
  package-invocation idempotency ledger, and dedicated RunLog state (workflow
  projections, job-run observability, package run successes, activation
  milestones) through the account-export `run_records` section (`exportRuns`
  RPC; one cursor pages runs first, then ledger rows, then each dedicated phase
  via prefixed cursors). Run history self-prunes inside the DO (~30 days / 2,000
  runs; ledger terminal rows 90 days). Terminal workflow projections age-prune
  after 90 days inside the DO; job/activation dedicated tables are never pruned
  by retention. D1 has no workflow, package-success, or activation projection
  tables. The restore bookmark for the D1 schema that predates their removal,
  database `8c1014d1-6b41-4695-a0a2-159071f0f919`:
  `0000116d-000000d2-000050bd-c7ecd5892a189df7cda145af746bc9c9`. See
  [Run records](./run-records.md).
- `UserMeter` exports daily entitlement counter rows through the `user_meter`
  section (`exportCounters` RPC; keyset pagination by UTC `day` and `resource`).
  The same RPC returns authoritative `storageBytesState`,
  `packageServiceStates`, and sanitized `deletionState` on the first page only
  (`startAfter` absent; `null` on later pages). Section totals count each state
  inventory once when present. UserMeter `package_service_states` is
  **authoritative** for running-count enforcement; D1 `package_service_states`
  remains the enumeration export in the `d1` section. The storage-byte counter
  lives only in UserMeter. Retention is self-enforced inside the DO (seven UTC
  days of counter and inbound-delivery-claim rows); storage-byte and
  package-service liveness rows are not time-pruned. See
  [Entitlements](./entitlements.md#usermeter).
- `Mailbox` is the sole authoritative USER email graph export. It exports
  threads, messages, attachments, and delivery events through the account-export
  `mailbox` section (`exportMailbox` RPC; keyset pagination with prefixed
  cursors); manifest counts use `countMailbox`. No shared USER D1 graph exists,
  so the D1 export contains no duplicate email metadata. USER R2 export
  enumerates raw MIME and attachment keys with `Mailbox.listBlobReferences`.
  Internal `email_message_retention_retries` rows defer failed R2 deletion
  attempts without blocking other expired messages; they are likewise excluded
  from export/counts and removed with message or mailbox purge. See
  [Mailbox](#durable-objects-mailbox).
- `RemoteConnectorSession` exposes persisted connector metadata and tool
  descriptors through an export RPC.
- `PackageServiceInstance` uses its status RPC as the stable persisted service
  state summary.
- `MCP`, `RepoSession`, `PackageRealtimeSession`, and `McpClientHub` remain
  account-export exclusions: MCP objects are SDK session-keyed and not globally
  enumerable; RepoSession is an ephemeral editing workspace (although its SQLite
  bytes are inventoried for the `storage_bytes` entitlement);
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
  [Platform accounts](./platform-accounts.md)). The `d1_storage_reconciliation`
  lane sweeps users by `stable_user_id` keyset from the platform-owned
  `d1_storage_reconcile_cursor` singleton. UserMeter `storage_bytes_state`
  (schema v4) drives storage-byte enforcement; UserMeter
  `package_service_states` (schema v5) is the authoritative running-count source
  for `package_services` / `service_start` — see
  [Entitlements](./entitlements.md#usermeter). Inbound email routing does not
  reverse-resolve stable ids — it uses the indexed username lookup
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
- Workflow, activation, and package-success state lives in dedicated RunLog
  tables; D1 has no corresponding projection tables (see
  [Run records](./run-records.md)).
- There is no `jobs` or `archived_job_artifacts` table in `APP_DB` — those live
  in the jobs worker's `JOBS_DB` (see [D1 (`JOBS_DB`)](#d1-jobs_db)).
- `package_service_states` (`0095-package-service-states.sql`): per-service
  liveness projection (`running` / `idle` / `stopped` / `error`) for discovery,
  account export/deletion inventory, and disaster recovery. Upserted and
  heartbeaten (1h) by the `PackageServiceInstance` Durable Object. Running-count
  enforcement and `service_start` read the per-user `UserMeter` copy (schema v5;
  24h staleness on DO `source_updated_at`). D1 remains only the enumeration
  index — see [Entitlements](./entitlements.md#package-service-liveness).
- `entity_sources`: durable mapping from user-facing entities (`job`, `package`,
  or `repo`) to Artifacts repos and their latest published commit (packages
  only; plain repos are live-at-HEAD without a publish pointer)
- `user_repos`: plain-repo discovery metadata (`name`, optional `description`);
  one row per user-owned plain repo, keyed by `entity_sources.entity_id` when
  `entity_kind = 'repo'`
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
- `platform_oauth_apps` (`0004-platform-oauth-apps.sql`): operator-provisioned
  built-in OAuth apps users connect to without registering their own provider
  app. Global operator config with **no `user_id`** (like feature flags, not
  user data). Keyed by `slug`; holds the inline non-secret `client_id`, provider
  endpoints, flow options, the allowed/default scope menu,
  `required_hosts_json`, and `enabled`. `client_secret_encrypted` is the one
  credential ciphertext stored outside `secret_entries` (AES-GCM with a
  dedicated purpose, so no `{{secret:…}}` placeholder can name it);
  `getPlatformOauthAppClientSecret` in
  `packages/worker/src/integrations/platform-apps.ts` is its only decrypt
  accessor. `logo_key` / `logo_content_type`
  (`0005-platform-oauth-app-logos.sql`) point at an operator-owned provider logo
  asset in the `COMMUNITY_ASSETS` R2 bucket (content-hashed
  `platform-oauth-app-logos/{slug}/` keys; SVG uploads are rasterized to PNG
  before storage). See
  [OAuth integrations](./integrations.md#platform-built-in-oauth-apps).
- `user_integrations` (`0101-user-oauth-apps-and-integrations.sql`, rebuilt by
  `0004-platform-oauth-apps.sql`): per-user OAuth connections keyed by
  `(user_id, name)`. Exactly one of nullable `app_slug` (composite FK
  `(user_id, app_slug) → user_oauth_apps(user_id, slug)`) or nullable
  `platform_app_slug` (FK to `platform_oauth_apps(slug)`) is set, enforced by a
  `CHECK` constraint; both FKs use `ON DELETE RESTRICT`. Holds `scopes_json`,
  `required_hosts_json`, and access/refresh token secret names. Secret
  credential values stay in `secret_entries` in both lanes; the non-secret
  `client_id` is stored inline on the owning app row.
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

## D1 (`JOBS_DB`)

Job schedule metadata lives in the dedicated `kody-jobs` D1 database bound as
`JOBS_DB` on the jobs worker (`packages/jobs-worker/`), not in `APP_DB`. Schema:
`packages/jobs-worker/migrations/`. The main worker reaches it only through the
`JOBS` service binding (`JobsService`). See
[ADR 0016](../decisions/0016-mono-worker-extraction.md) and the
[jobs worker migration runbook](./jobs-worker-migration-runbook.md).

- `jobs`: persisted job metadata, caller context, schedule state, repo source
  pointers, `preserved` (skip platform auto-cleanup), and optional `expires_at`
  (UTC ISO; when reached the scheduler skips the job and auto-disables it with
  `enabled = 0`). Account retention windows live on `APP_DB` `users`
  (`job_retention_*_days`; NULL = platform defaults 14/60/90). Completed ad-hoc
  jobs are cleaned by the hourly `job_retention` sweeper on the jobs worker;
  package-owned and preserved jobs are not. `expires_at` stops scheduling only —
  it does not delete rows and is independent of `preserved`. This database keeps
  schedule fields (`next_run_at`, `schedule_json`, …) and `last_run_at` /
  `last_run_status` as retention anchors only; terminal run error, duration, and
  counters for observability live in the per-user `RunLog`
  `job_run_observability` table (see [Run records](./run-records.md)).
- `archived_job_artifacts`: retained job artifact rows with per-row
  `retain_until` cleanup (exempt from the global age prunes on `APP_DB`).

## Analytics Engine reporting

The role-gated admin insights page reads its 28-day email volume and outbound
delivery-outcome charts from the `EMAIL_EVENTS` Analytics Engine dataset.
Workflow status totals and activation funnel/latency on the same page come from
**bounded, content-free per-user RunLog point reads** (see
[Run records — Admin insights RunLog reads](./run-records.md#admin-insights-runlog-reads)),
not from D1 projection tables. The loader exposes `runLogCompleteness` when that
fanout is partial. Charged sends and receives write one event after entitlement
consumption; persisted `cloudflare-email` provider outcomes write one delivery
event. The layout is `index1 = userId`, `blob1 = event type`,
`blob2 = delivery outcome`, `blob3 = source timestamp`, and `double1 = 1`. Admin
queries return only platform-wide day/outcome counts and weight sampled rows by
`_sample_interval`. When Analytics Engine SQL is unreachable, these two charts
zero-fill while the rest of the page renders. Local development cannot query
Wrangler's emulated Analytics Engine SQL API: both email quota and
delivery-outcome aggregates degrade to empty (with an explicit warning) rather
than falling back to a shared USER email graph.

Mailbox has no mirror/parity telemetry, emitters, or operation registry.

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

Raw email MIME payloads live in the `EMAIL_BLOBS` R2 bucket. Mailbox
`email_messages` stores the object key in `raw_mime_key`
(`email-raw:v1:{userId}/{messageId}`). R2 is required for inbound MIME — the
inbound path stores it before `commitInboundMessageGraph`, which writes the
thread, message, and attachments in one owner-Mailbox SQLite transaction and
stores only `raw_mime_key`. R2 or Mailbox commit failures remain retryable;
UserMeter delivery-id idempotency prevents a second charge, and the Mailbox
delivery ledger stabilizes retries. Outbound messages pass `rawMime: null`.

The schema has no inline raw-MIME columns, offload queue, or delete-time claim
protocol. Sender identities accept only `verified` rows, and
`ensurePlatformSenderIdentity` provisions that status.

- Canonical key builders are `emailRawMimeKey` / `emailAttachmentBlobKey` in
  `packages/worker/src/email/blob-keys.ts`.
- USER reads resolve Mailbox metadata and use `loadRawMime` in
  `packages/worker/src/email/service.ts`, which fetches only the Mailbox-owned
  `rawMimeKey`. Attachment content extraction re-parses that resolved MIME.
- USER explicit delete, retention, and account purge call owner Mailbox RPCs.
  Mailbox deletes each canonical raw-MIME/external-attachment R2 object before
  deleting authoritative SQLite metadata; a failed blob delete preserves the row
  and schedules retry. No live path mirrors or repairs a shared D1 graph row.
  There is no shared D1 email graph. `system:email` uses only its dedicated D1
  graph and retention path.
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

Jobs use two Durable Object roles across workers:

- `JobManager` (jobs worker): one object per user, responsible only for alarm
  scheduling and dispatching due jobs from `JOBS_DB`-backed metadata
- `StorageRunner` (runtime worker): one object per durable storage id,
  responsible for isolated SQLite state that can be bound to execute calls,
  jobs, and dedicated storage inspection capabilities

Each `JobManager` alarm processes at most `maxDueJobsPerAlarm` due jobs
(`packages/worker/src/jobs/repo.ts`, oldest `next_run_at` first). When more due
jobs remain after a run, the post-run alarm resync arms a near-immediate
follow-up alarm so large backlogs drain across multiple short invocations
instead of one Durable Object wake.

Storage split:

- `JOBS_DB` `jobs` table: job metadata, persisted caller context, schedule
  fields, `last_run_at` / `last_run_status` as retention anchors, repo source
  pointers (`source_id`, `published_commit`), and stable `storage_id`. Terminal
  run error, duration, counters, and pruned execution history live in the
  per-user `RunLog` (`job_run_observability` and `runs`; see
  [Run records](./run-records.md))
- `JobManager` SQLite: only alarm bookkeeping needed to wake the right user's
  due jobs
- `StorageRunner` SQLite: isolated durable state addressed by `storageId`

`user_storage_buckets` inventories both StorageRunner buckets and RepoSession
workspaces for the check-only `storage_bytes` baseline. Rows use `kind` to
dispatch `getEstimatedBytes` to the correct Durable Object, cache the latest
`databaseSize` in `estimated_bytes`, and feed the same bounded
`storage_bucket_estimate_backfill` lane. Index-backed repo-session
reconciliation pages `repo_session_due_owners` with a per-tick owner budget and
a platform-owned `repo_session_storage_bucket_cursor` so a sweep cannot walk the
whole fleet. Repo sessions register on open, opportunistically refresh after
workspace mutations, and remove the inventory row on discard, purge, scheduled
cleanup, source deletion, or account deletion. This estimate component is
composed with the authoritative UserMeter D1 payload bytes; it is not reserved
into UserMeter.

## Durable Objects (`UserMeter`)

Daily rate-style entitlement counters and inbound email delivery-id idempotency
live in a per-user `UserMeter` Durable Object with SQLite
(`packages/worker/src/entitlements/user-meter-do.ts`). Schema v4
`storage_bytes_state` is the **authoritative** storage-byte counter (see
[Entitlements](./entitlements.md#usermeter)). Schema v5 `package_service_states`
is the **authoritative running-count source** for `package_services` /
`service_start`; D1 remains only the enumeration index
([Entitlements](./entitlements.md#package-service-liveness)). The Worker binding
is `USER_METER` (class `UserMeter`; Wrangler SQLite migration tag `v21` via
`new_sqlite_classes` in `packages/worker/wrangler.jsonc`).

Naming matches `RunLog` and `JobManager`: one object per untrimmed stable MCP
`userId` via `userMeterDurableObjectName(userId)` → `idFromName(userId)` in
`packages/worker/src/user-scoped-durable-object-name.ts`. There is no `user_id`
column inside the DO because the object identity is the user.

SQLite ownership (schema version tracked in `user_meter_meta`; current version
**8**):

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
  `initializeStorageBytes` (INSERT OR IGNORE cold zero-init bootstrap), and
  `setStorageBytes` (absolute set from reconcile). Authoritative for enforcement
  and usage reads via `readStorageBytes`; the reconcile lane sweeps by
  `stable_user_id` keyset from `d1_storage_reconcile_cursor`. StorageRunner and
  RepoSession bucket estimates stay outside this row (see
  [Entitlements](./entitlements.md#usermeter)).
- `package_service_states` — per-service liveness rows (`package_id`,
  `service_name`, `status`, `started_at`, `source_updated_at`, monotonic
  `revision`, `updated_at`; primary key `(package_id, service_name)`). Written
  by `PackageServiceInstance` alongside the D1 enumeration inventory on every
  lifecycle projection/delete; monotonic on `source_updated_at`. Authoritative
  for running-count enforcement and `service_start` via
  `countRunningPackageServices`. D1 remains the enumeration index (discovery,
  export, deletion) only — see
  [Entitlements](./entitlements.md#package-service-liveness).
- `deletion_state` / `account_write_leases` — deletion tombstone plus write
  leases (singleton `deleting_at`; lease rows `token` / `holder` / `acquired_at`
  / `pending_repair_id`). Schema v8 is authoritative for all leases. All callers
  supply `USER_METER`. D1 `account_write_lease_repairs` is the repair audit log
  and `users.deleting_at` remains the permanent point gate. `purge()` preserves
  an existing deleting tombstone across `deleteAll`. Account export emits a
  sanitized `deletionState` without raw token/holder.

Retention is self-enforced inside the DO: every read/write path
opportunistically deletes counter and claim rows older than seven UTC days
(`userMeterDailyCounterRetentionDays`). Enforcement only needs the current day;
the window covers timezone edge cases, recent account exports, and inbound
retries. Storage-byte and package-service liveness rows are not time-pruned.
Write-lease rows clear on release/repair/purge.

**Daily counter authority:** enforcement, point reads, bootstrap, and account
export/deletion paths use `UserMeter`; D1 has no daily entitlement counter table
or day index. `admin_user_meter_parity` reports meter-only daily counts. See
[Entitlements](./entitlements.md#usermeter).

**Daily cold bootstrap:** a missing `(resource, day)` row returns
`needs_bootstrap`. The service calls `initialize({ count: 0 })` with
`INSERT OR IGNORE` (concurrent callers stay safe). Warm daily paths never read
D1 for enforcement.

Account deletion calls `UserMeter.purge()` (one RPC per user, no D1 id scan;
`deleteAll` clears counters, claims, storage bytes, package-service state, and
write leases while preserving an existing deleting tombstone). Account export
pages `UserMeter.exportCounters` through the `user_meter` manifest section /
`account_export_section` (daily counters plus authoritative `storageBytesState`,
`packageServiceStates`, and sanitized `deletionState` on the first page only
when present).

## Durable Objects (`Mailbox`)

User-owned email **metadata** lives in a per-user `Mailbox` Durable Object with
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
`mailboxSchemaVersion = 5`):

- `mailbox_owner_identity` — singleton `owner_id` for blob-key validation and
  cross-user write rejection
- `email_threads`, `email_messages`, `email_attachments`, and
  `email_delivery_events` for the owning user
- `email_outbound_provider_index_repairs` for accepted sends whose operational
  D1 reverse-index write still needs retry
- latest per-message delivery status on `email_messages.delivery_status`, kept
  separate from send-request `processing_status`
- warm-safe additive inbound-ledger due-work indexes, effect leases, retention
  state, and message-deletion tombstones; cold objects install the full DDL and
  warm objects apply guarded additive schema updates.

**USER authority:** live, scheduled, admin, and account USER paths read and
write the owner Mailbox only. Inbound raw MIME is written to R2 first, then
`commitInboundMessageGraph` validates the active `storageLease` and writes the
thread, message, and attachments in one DO SQLite transaction. Only after that
commit does the delivery transition to `received`. Preclaim bounded rejections,
stale-delivery reconciliation, usage/subscription effect leases, classification,
explicit delete, export, and retention are Mailbox operations.

Outbound USER requests write their graph to Mailbox before provider submission.
After provider acceptance, terminal message/event persistence is retried in
Mailbox. D1 `email_outbound_provider_index` is the only USER email
graph-adjacent runtime table: it is a thin, independently idempotent
`providerMessageId → ownerId/messageId/inboxId` lookup. Contextless provider
webhooks resolve that index and mutate Mailbox; they never join shared D1 graph
tables. The terminal Mailbox transaction also records a pending provider-index
repair. Immediate D1 synchronization clears it on success; the Mailbox alarm
retries failures with bounded backoff and publishes aggregate repair health.

USER write entry points require the permanent `email_user_graph_authority`
marker and fail closed when it is absent. The marker retains `owner_count`,
`frozen_at`, and `dropped_at` as the graph-drop contract. D1
`email_inbound_due_owners` provides bounded owner discovery for scheduled
inbound reconciliation, ordered by due time and owner with 25 owners processed
per tick. `email_delivery_alert_events` preserves short-lived bounced/complained
signals for operator burst alerts. Static import/SQL architecture checks reject
production D1 references to USER graph table names; those tables exist only in
owner-scoped Mailbox SQLite.

For operator mail, `system_email_threads`, `system_email_messages`,
`system_email_attachments`, and `system_email_delivery_events` are the only live
metadata and inbound-ledger authority for `system:email`. Reads never fall back
to shared `email_*` rows, and the reserved owner never gets a Mailbox Durable
Object. Shared inbox/address/sender configuration remains in D1 because the
dedicated graph references that operator configuration; account export/deletion
continues to exclude the reserved owner.

Every authoritative system graph or inbound-ledger mutation writes only the
dedicated tables and commits with the dedicated authority/provider-link guard.
R2 retention deletes all referenced blobs first, then atomically deletes
dedicated metadata. If any blob delete fails, the authoritative row remains for
retry. Scheduled retention selects age/cap/events/orphan threads only from the
dedicated graph.

The admin mailbox maintenance `status` action reports content-free dedicated
counts, authority marker state, invalid-reference count, and provider-link
count. It has no graph parity or reconcile action.

The detached `email_outbound_provider_index` does not accept `system:email`.
System outbound sends and provider-linked dedicated messages remain unsupported.
Runtime marker checks repeat the provider gate so any provider-linked system row
stops dedicated work.

**USER restore boundary:** Mailbox/R2 is the only USER graph authority. Recovery
must quiesce email writers and restore the authoritative Mailbox and
`EMAIL_BLOBS` backups; the verified historical D1 bookmark is disaster-recovery
evidence, not a serving-source switch.

**Mailbox graph contract:** all live USER RPCs are owner-bound. Complete graph
writes validate canonical owner-scoped R2 keys. Inbound graph commits
additionally validate the active storage lease, delivery/message identity, inbox
identity, and expected attachment count in the same SQLite transaction as the
graph write. Outbound terminal message/event updates are one SQLite transaction.
Read, classification, explicit-delete, export, and effect-ledger RPCs reject
cross-owner access and do not fall back to D1.

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

**Admin maintenance** is audited and content-free outside an explicitly
owner-scoped delete. Fleet status reports the USER authority marker, thin
provider-index structure, pending provider-index repair owners, inbound due
owners, delivery-alert health, and dedicated system-email counts/reference
health. USER retention calls `Mailbox.runRetentionNow`; USER explicit delete
inventories and deletes canonical R2 keys, deletes Mailbox metadata, and
idempotently removes any thin provider-index row. The dedicated `system:email`
maintenance path remains D1-backed.

USER retention returns Mailbox before/after counts (no message ids or email
content).

Account deletion uses one owner-bound Mailbox object (no shared-graph D1 id
scan). Before purge it exhaustively pages `listBlobReferences`, deletes those
canonical keys and the defensive `EMAIL_BLOBS` owner prefixes, and aborts on any
inventory or cleanup warning. Only then does it call `Mailbox.purge()` (result
key `mailboxes`). Purge clears DO SQLite/alarm state and reinitializes schema;
it does **not** delete R2 objects. Account export pages the sole authoritative
USER graph through the `mailbox` section (`exportMailbox` / `countMailbox`) and
uses `listBlobReferences` for USER email R2 bytes.

### What stays in D1

- **Operator system-email inbox** — remains permanently in D1 for cross-account
  admin access, fixed bounded caps, and separate system-email retention. The
  dedicated `system_email_*` graph is authoritative and stays excluded from
  account deletion and export (`accountOperatorOwnedD1Surfaces`). Operator mail
  always remains outside per-user Mailbox objects.
- **Low-write email config** — sender identities, inboxes, inbox addresses,
  sender rules, and similar low-churn configuration stay in D1.
- **Provider-message reverse lookup** — outbound Cloudflare sending webhooks
  resolve owner/message through the operational D1 lookup table
  `email_outbound_provider_index`, keyed by `(provider, provider_message_id)`
  with `user_id`, `message_id`, `inbox_id`, and created/updated timestamps
  (indexes on `user_id` and unique `message_id`). Mailbox
  `email_messages.provider_message_id` is authoritative. The index `message_id`
  is an opaque owner-scoped key with no graph foreign key. Mailbox
  explicit/account deletion removes index rows separately and idempotently.
  Outbound send separates provider acceptance, bounded Mailbox terminal
  persistence, and independently retryable index persistence; an index failure
  never requests a resend. A pending repair is durable in owner Mailbox SQLite,
  retried by its alarm with bounded backoff, and summarized in D1 without
  provider/message identifiers. Account export omits the operational reverse
  index (`includeInExport: false`); exported Mailbox messages retain their
  provider ids, but no fleet-wide automatic rebuild is claimed.
  `recordProviderEmailDeliveryEvent` resolves index-first, then loads the
  owner-scoped Mailbox message (no shared-message scan). System outbound is
  unsupported, and the verified `no-system-provider-links` disposition means
  `system:email` rows are never added to this global index. The admin status
  exposes an index-only structural report. Contextless provider-id reverse
  lookups must not enumerate per-user Mailbox objects.

### Inbound durability boundary (USER Mailbox authority)

For USER mail, the owner-bound Mailbox ledger is the lifecycle/effect authority:

1. Mailbox CAS selects the dedupe winner. UserMeter consumes quota for that
   winner, then Mailbox inserts the charged pending snapshot.
2. R2 stores raw MIME before metadata commit.
3. `commitInboundMessageGraph` validates the active storing lease and writes
   thread/message/attachments atomically in owner SQLite.
4. Mailbox CAS finalizes the delivery as `received` or `rejected`; terminal
   effects run under Mailbox leases.

Retries and stale reconciliation inspect Mailbox state only. Preclaim bounded
rejection audits are written directly to Mailbox. No live reverse bridge,
projection, or shared-D1 graph fallback exists.

`system:email` is the explicit exception: its inbound lifecycle, effects, and
reconciliation use the dedicated D1 graph and never bootstrap a Mailbox.

If R2 succeeds but the fenced graph transaction or finalization fails, Email
Routing retries the stable delivery id. The graph transaction is idempotent and
the active lease prevents a stale worker from overwriting the winner.

### Package and repo state model

Repos are the durable home for versioned Artifacts source; saved packages are an
explicit extension that adds publish semantics and runtime surfaces. Plain repos
live in `user_repos` with `entity_sources.entity_kind = 'repo'`. Packages add
`saved_packages` plus `entity_sources.entity_kind = 'package'`.

Package and plain-repo state maps onto storage homes as follows:

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
  writes D1 `package_service_states` (enumeration) and UserMeter (authoritative
  running counts). App facets and package-internal DO namespaces are extra
  StorageRunner buckets under the package id, not a general actor model.
- **Package jobs** — schedule metadata in `JOBS_DB` `jobs`; run-local scratch in
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
  and dedicated state (workflow projections with 90-day terminal retention,
  job-run observability, package activation counters/milestones). See
  [Run records](./run-records.md).
- `UserMeter` — `userMeterDurableObjectName(userId)` → `idFromName(userId)`. One
  daily-entitlement meter DO per user (untrimmed stable id, same as `RunLog`),
  plus authoritative schema-v4 storage-byte and schema-v5 package-service
  liveness state. See [Entitlements](./entitlements.md#usermeter).
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
- `RepoSessionIndex` — `repoSessionIndexDurableObjectName(userId)` keyed by
  untrimmed `userId` (like RunLog / UserMeter / Mailbox). Authority for the
  per-user session catalog: rows, active counts, conversation resume, export,
  and deletion inventory. Each index self-alarms; D1 keeps only the thin
  `repo_session_due_owners` hint (one row per user with any session) plus
  platform-owned hydrate and storage-bucket inventory cursors.
- `RepoSession` — `repoSessionDurableObjectName(sessionId)` keyed by session id
  only (not user-prefixed). Every RPC validates the catalog row's `user_id`
  before touching the workspace. Account deletion enumerates the user's session
  ids from `RepoSessionIndex` and purges each workspace DO. Documented exception
  to user-scoped naming.
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
dynamic `import("kody:@...")` is permanently unsupported. Publish checks reject
the pattern, and runtime rewriting returns a teaching error that names static
imports and `packages.invoke` as the supported alternatives.

## Configuration reference

Bindings are configured per environment in `packages/worker/wrangler.jsonc`
(names and bindings only; remote D1/KV IDs come from deploy-generated configs).
`JobManager` and `JOBS_DB` live on the jobs worker
(`packages/jobs-worker/wrangler.jsonc`); the main worker reaches them through
the `JOBS` service binding. Runtime Durable Objects (`StorageRunner`, `RunLog`,
`PackageRealtimeSession`, `PackageServiceInstance`) live on the runtime worker
and are bound cross-script from main — see
[ADR 0016](../decisions/0016-mono-worker-extraction.md).

- `APP_DB` (D1)
- `AUDIT_DB` (D1, global hashed security audit trail)
- `JOBS` (service binding to the jobs worker `JobsService` entrypoint)
- `OAUTH_KV` (KV)
- `BUNDLE_ARTIFACTS_KV` (KV)
- `EMAIL_BLOBS` (R2, raw email MIME blobs)
- `MCP_OBJECT` (Durable Objects)
- `REMOTE_CONNECTOR_SESSION` (Durable Objects)
- `RUN_LOG` (Durable Objects; per-user run records — see
  [Run records](./run-records.md); class hosted on the runtime worker)
- `USER_METER` (Durable Objects; per-user daily entitlement counters — see
  [Entitlements](./entitlements.md#usermeter))
- `STRIPE_PLAN_REFRESH` (Durable Objects; per-user, activity-driven Stripe plan
  reconciliation alarms)
- `MAILBOX` (Durable Objects; sole per-user email graph, inbound-ledger,
  retention, read, export, and mutation authority — see
  [Mailbox](#durable-objects-mailbox))
- `STORAGE_RUNNER` (Durable Objects; class hosted on the runtime worker)
- `REPO_SESSION` (Durable Objects)
- `PACKAGE_REALTIME_SESSION` (Durable Objects; class hosted on the runtime
  worker)
- `PACKAGE_SERVICE_INSTANCE` (Durable Objects; class hosted on the runtime
  worker)
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
- `MCP_PROTOCOL_EVENTS` (Analytics Engine dataset, production/preview only; one
  point per authenticated `/mcp` request recording which protocol lane served it
  — legacy sessionful vs stateless 2026-07-28 — for legacy-lane retirement; see
  `packages/worker/src/mcp/protocol-metrics.ts`)

`packages/worker/wrangler.jsonc` also configures the `EMAIL` send binding,
dispatch queues, worker loaders (`LOADER` / `APP_LOADER`), the `AI` binding, and
`DYNAMIC_CALLABLE_WORKFLOWS`; the Wrangler config is authoritative.

## Repo-backed source and Artifacts

Repo-backed saved packages, package apps, and jobs use Cloudflare Artifacts
repos plus D1 `entity_sources` rows and a per-user `RepoSessionIndex` catalog.

- Primary code lives under `packages/worker/src/repo/`.
- `entity_sources` stores the durable mapping from
  `(user_id, entity_kind, entity_id)` to the repo identity and last published
  commit.
- `RepoSessionIndex` stores mutable editing-fork catalog rows for repo session
  Durable Objects. Leftover D1 `repo_sessions` rows hydrate into the index until
  the Phase 2 DROP.
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
  most MCP callers should prefer package identity with `repo_open_session` and
  the file-level session capabilities (`repo_edit_files`, etc.).
- Once repo-backed source exists, the repo snapshot is the durable source of
  truth for later edits and publishes. Search and detail payloads are derived
  projections of that repo-backed source rather than a competing second source
  of truth.
- Repo sessions expose a file-level API inside the RepoSession Durable Object:
  batch edits (`repo_edit_files`: write/replace/writeJson/delete/move), unified
  diff apply (`repo_apply_patch`), git inspection (`repo_status`, `repo_diff`,
  `repo_log`), commit (`repo_commit`), and restore (`repo_restore`). There is no
  git-command parser channel; branch/checkout/remote operations require the
  Artifacts git lane via `package_get_git_remote`. Package runtime bundles are
  loaded from published artifacts rather than a mounted checkout.
- `repo_write_file` exposes the same Durable Object's `applyEdits` write path as
  a first-class MCP capability for whole-file overwrites. Prefer it over
  `repo_apply_patch` when the agent is replacing an entire file (for example, a
  single-file job source) instead of patching a hunk with surrounding context.

### Direct Artifacts git publishes

Saved package source can also be edited through Artifacts git remotes directly.
`package_get_git_remote` resolves package identity to `entity_sources`, mints a
short-lived Artifacts repo token, and returns a plain remote, `git_author`
(signed-in account email and display name), and setup commands that pass the
token through `http.extraHeader` and set local `user.email` / `user.name` from
`git_author`.

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
usage-rollup aggregation, and bounded USER inbound Mailbox reconciliation
(active-user discovery from the users/config index followed by owner-point
Mailbox due-work RPCs; no shared graph scan). Each production queue message
preserves `scheduled_lane_failed` / D1 lock-contention log and Sentry context. A
handled lane failure is acknowledged and retried by the next cron tick. A failed
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
  `jobs.repo_check_policy_json`
  (`packages/jobs-worker/migrations/0001-jobs-init.sql`,
  `packages/worker/src/jobs/repo.ts`) rely on parser and normalizer
  compatibility. Package jobs persist both `storageContext.appId` for value
  scope and `storageContext.packageId` for package-owned secret scope.
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
  per user, plus authoritative schema-v4 storage-byte and schema-v5
  package-service liveness state.
- `StripePlanRefresh`: `idFromName(userId)` (no trim); one ephemeral billing
  reconciliation alarm DO per user.
- `Mailbox`: `idFromName(userId)` (no trim); one email-metadata DO per user.
- `RepoSessionIndex`: `idFromName(userId)` (no trim); one session-catalog DO per
  user.
- `McpClientHub`: `idFromName(userId.trim())`.
- `StorageRunner`: `idFromName(JSON.stringify([userId, storageId]))`.
- `RepoSession`: `idFromName(sessionId)`; the key is not user-prefixed, so every
  RPC must keep validating the catalog row's `user_id`.
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

Search paths query only per-account namespaces plus the reserved builtin
namespace. Vector rows are derived from D1 and can be rebuilt with the bounded
`POST /__maintenance/reindex-capabilities` sweep, which keyset-pages memory,
job, and saved-package rows and rebuilds builtins in their reserved namespace.

### `entity_sources` and package import contracts

`entity_sources` is the durable repo pointer table:
`(user_id, entity_kind, entity_id) -> source_id`. Child tables store
`source_id = entity_sources.id`; KV snapshots use that same source id plus the
published commit. `entity_kind` accepts `job`, `package`, and `repo`.
`manifest_path`, `source_root`, `published_commit`, `indexed_commit`, and
`last_external_check_at` are part of the repo-source synchronization contract
for jobs and packages; plain `repo` sources are live-at-HEAD, have no manifest
requirement, and are skipped by the external-push reconcile lane.

Saved package imports in user code use `kody:@scope/name/export` specifiers:

1. `packages/worker/src/package-runtime/package-import-resolution.ts` parses the
   `kody:@` prefix, the `@scope/name` package name, and an optional export
   subpath (default `.`).
2. Resolution is scoped to the caller's `userId`, with one structural exception:
   scopes whose username belongs to a **platform account**
   (`users.account_type = 'platform'`, e.g. `@kody`) resolve live from the
   platform account's current published version when the caller has no copy of
   their own (see decision record
   [0014 — Platform scopes resolve live](../decisions/0014-platform-live-packages.md)).
   Person-account and community package scopes never grant cross-user imports.
3. `packages/worker/src/package-registry/manifest.ts` normalizes export keys and
   resolves them through `package.json#exports`.
4. Static imports are pinned into bundle dependencies at publish time. Literal
   dynamic `import("kody:@...")` calls are permanently rejected by publish
   checks and rewritten to an actionable teaching error at runtime.

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
- Terminal workflow projections age-prune after 90 days inside the per-user
  `RunLog` DO (`workflow_projections`; see [Run records](./run-records.md)).
- `published_bundle_artifacts`: delete D1 rows and their `BUNDLE_ARTIFACTS_KV`
  blobs only when the row is older than 30 days, its `published_commit` is no
  longer current for any matching `entity_sources` row, and there is no active
  repo session for the source. When a row is pruned, the matching
  `source-snapshot:v1:{sourceId}:{commit}` and
  `source-manifest-snapshot:v1:{sourceId}:{commit}` KV keys are deleted under
  the same safety conditions, so per-commit snapshots do not accumulate
  indefinitely. Ambiguous publish/edit cases are intentionally kept.
- Mailbox `email_delivery_events`: USER events keep 90 days under the per-owner
  DO alarm/admin RPC. System email is governed by the dedicated system-email
  retention job, which prunes messages, external attachment objects, raw-MIME
  blobs, and delivery events older than 90 days in parameter-bounded batches
  within its own time budget, deletes stale `system_email_daily_counters`, caps
  stored system messages at 5,000, and prunes orphan threads. All R2 objects are
  deleted before dedicated metadata; a failure preserves authority rows for
  retry. The four dedicated `system_email_*` tables therefore have explicit
  `alternate_cleanup` dispositions.
- Mailbox `email_messages` / `email_attachments` / `email_threads`: USER
  messages keep 365 days. The DO deletes canonical raw-MIME/external-attachment
  R2 objects before metadata and retries failures. It then prunes orphan
  threads. Derived provider-index cleanup is separately idempotent.
  `system:email` stays on the dedicated D1 retention job and has no
  provider-index rows.
- UserMeter daily counter rows keep seven UTC days
  (`userMeterDailyCounterRetentionDays`); `admin_user_meter_parity` reports
  meter-only daily counts.
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
