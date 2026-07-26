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
`admin`). Those messages reuse the email tables but are stored under the
reserved owner id `system:email`, which is not a login account and must not be
conflated with the `kody@example.com` fixture or Kent's personal account.
Account deletion and export treat `system:email` rows as platform/operator
content, not user data; the exclusion is listed in
`accountUserDataExcludedOwnerIds` with a reason and is covered by guardrail
tests.

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

System email rows owned by `system:email` are intentionally excluded from
account deletion. They are operator-owned inbound mail for reserved platform
addresses, not portable user content, and are bounded by fixed system caps plus
the scheduled system-email retention prune.

Platform-feedback rows follow two account-deletion behaviors. Deleting the
submitting account deletes its submissions. When a deleted account was an admin
reviewer for another user's surviving submission, deletion clears the reviewer
reference so the row does not retain attribution to a nonexistent account.

Deletion must cover these user-owned surfaces:

- **D1:** every live table with `user_id` / `*_user_id` ownership columns, plus
  transitive children (`secret_entries`, `value_entries`, `email_attachments`)
  and listing children for community-owned listings. The guardrail test in
  `packages/worker/src/app/account-deletion.node.test.ts` applies the live
  migrations to SQLite and fails if a user-owned schema column is not
  represented in the deletion target list, or if the deletion target list
  references a stale column.
- **Durable Objects:** `JobManager`, `StorageRunner`, `RepoSession`,
  `RemoteConnectorSession`, `PackageRealtimeSession`, `PackageServiceInstance`,
  and `RunLog` are purged through account-deletion RPCs after their D1
  identifiers are collected (`RunLog` is one object per user and needs no D1 id
  scan). `MCP` objects remain SDK session-keyed, while `mcp_agent_sessions`
  indexes each Durable Object id by authenticated stable user id so account
  deletion can purge stored props, conversation state, raw-fetch state, and
  transport storage before revoking OAuth grants.
- **Vectorize:** memory, job, and saved-package vector ids are derived from D1
  rows and removed with `deleteByIds`.
- **R2:** raw email MIME blobs in `EMAIL_BLOBS` are enumerated from
  `email_messages` (deterministic `emailRawMimeKey` keys) and attachment storage
  keys while those rows still exist. A failed object delete aborts D1
  finalization so those inventory rows remain available for retry. Rows owned by
  `system:email` keep their blobs here (they are not user data); those blobs are
  removed when the system-email retention prune deletes the messages through the
  shared delete-message helper.
- **KV:** published bundle artifact keys, source/manifest snapshot keys,
  community listing snapshots, and per-user package retriever cache/index keys
  in `BUNDLE_ARTIFACTS_KV` are deleted before D1 projection rows are removed.
  OAuth token/grant KV is owned by the OAuth provider and is handled through
  provider grant revocation rather than app-level key scans.
- **Cloudflare Artifacts:** source repos referenced by `entity_sources` and
  `repo_sessions` are deleted through the REST client in
  `packages/worker/src/repo/artifacts.ts`.

## Account export inventory

Account export is implemented in `packages/worker/src/app/account-export.ts`. It
mirrors the deletion inventory so portability and account migration cover the
same user-owned storage surfaces. The D1 table list and shared kind→SQL match
builders live in `account-data-targets.ts` (`accountUserDataTargets`,
`buildUserScopedTargetMatch`); export redaction columns also live there.
Out-of-band surfaces (Durable Objects, KV schemes, R2, Vectorize, Artifacts) are
declared in `account-user-owned-surfaces.ts` and consumed by both deletion and
export. Growth-table retention dispositions are linked in
`account-retention-dispositions.ts`.
`packages/worker/src/app/account-export.node.test.ts` applies the live
migrations to SQLite and fails if a `user_id` / `*_user_id` column is not
covered by the export list. The hard invariant is the same as every storage
path: callers pass the authenticated user's stable MCP `userId`, and every query
or Durable Object lookup is scoped to that id.

System email rows owned by `system:email` are intentionally absent from account
exports for the same reason they are absent from deletion: they belong to the
operator inbox surface, not to the exporting user. The export manifest lists
this under `excludedD1Surfaces` so the omission is explicit.

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
- `d1` — user-scoped D1 rows grouped by table.
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
  storage export capability. R2 raw MIME, attachment, avatar, and icon objects
  use `section: "r2_object"`; each response contains at most one 256 KiB base64
  chunk and an opaque cursor. Each request uses bounded `LIMIT 1` ownership
  queries rather than reconstructing inventory. Continuation cursors bind the
  source row, object key, size, and ETag; ownership/key mutations and object
  overwrites are reported instead of mixing generations. Missing objects are
  represented explicitly.

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
- `RunLog` exports per-user execution history (runs + log lines) through the
  account-export `run_records` section (`exportRuns` RPC). Retention is
  self-enforced inside the DO (~30 days / 2,000 runs); see
  [Run records](./run-records.md).
- `RemoteConnectorSession` exposes persisted connector metadata and tool
  descriptors through an export RPC.
- `PackageServiceInstance` uses its status RPC as the stable persisted service
  state summary.
- `MCP`, `RepoSession`, and `PackageRealtimeSession` are documented exclusions:
  MCP objects are SDK session-keyed and not globally enumerable; RepoSession is
  an ephemeral editing workspace; PackageRealtimeSession is live websocket
  state. Canonical repo-backed source and durable package app state are covered
  by Artifacts pointers and StorageRunner buckets instead.

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
  default `public`) come from migration 0065. `account_type` (`'person'` default
  or `'platform'`, migration 0072) distinguishes normal signups from
  operator-provisioned platform accounts that own official package scopes (see
  [Platform accounts](./platform-accounts.md)). Inbound email routing does not
  reverse-resolve stable ids at all — it uses the indexed username lookup
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
  pointers, and run observability state (`last_run_*`, counters). Execution
  history lives in the per-user `RunLog` Durable Object (see
  [Run records](./run-records.md)); `jobs.run_history_json` is left unwritten
  and pending a drop migration.
- `package_service_states` (`0095-package-service-states.sql`): authoritative
  per-service liveness projection (`running` / `idle` / `stopped` / `error`) for
  entitlement concurrency. Upserted and heartbeaten by the package-service
  Durable Object; not derived from run history.
- `package_runtime_runs` / `package_runtime_logs`
  (`0037-package-runtime-debug.sql`): **unwritten leftovers.** Writers do not
  use these tables. Hourly retention drains any remaining rows; a follow-up
  migration drops the tables. Execution history lives in `RunLog`.
- `entity_sources`: durable mapping from user-facing entities to Artifacts repos
  and their latest published commit
- `saved_packages`: package metadata/search projection derived from published
  `package.json` source, plus a user-scoped `hidden` flag (0/1) that excludes
  the package from default ranked search while leaving list/get/execute paths
  intact, and `is_private` (0/1, migration 0065) projecting
  `package.json#private` for public-profile and timeline filters (migration
  defaults existing rows to private;
  `POST /__maintenance/backfill-package-privacy` recomputes from manifests)
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

App access pattern:

- `packages/worker/src/db.ts` defines shared `remix/data-table` table metadata
  and creates a D1-backed database runtime via
  `packages/worker/src/d1-data-table-adapter.ts`
- Database row validation and API payload parsing use `remix/data-schema`
- app handlers and the mock Resend worker perform CRUD/query operations through
  `remix/data-table` (including `findOne`, `create`, `update`, `deleteMany`, and
  `count`)

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
The inbound Worker refunds the daily receive charge and rethrows only typed
pre-commit failures so Cloudflare Email Routing retries without burning quota.
The durable commit boundary is message + attachment rows: thread prework, R2
put, and D1 message/attachment storage are pre-commit; `touchEmailThread` /
`received` delivery-event writes are post-commit and are logged without throwing
(retry would duplicate mail). If attachment insert fails but message cleanup
cannot remove the row — or the residual-row probe itself fails (ambiguous commit
state) — the handler acknowledges the already-created message (logged,
non-retry) rather than risking a duplicate. Outbound messages pass
`rawMime: null` and are unaffected. If D1 insert fails after a successful put,
the blob is best-effort deleted.

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

- All reads go through `loadRawMime` in `packages/worker/src/email/repo.ts`,
  which fetches the blob by `raw_mime_key` only. Attachment content extraction
  re-parses the resolved MIME the same way as before.
- Message deletes always delete the deterministic
  `emailRawMimeKey(userId, messageId)` from R2 (production writers always store
  that canonical key): `deleteEmailMessageById` (best-effort after the D1 row
  delete), user email retention and system-email retention (strict: blob delete
  before row delete; failed blob deletes skip the row for retry), and account
  deletion (strict before atomic D1 finalization; a failed blob delete preserves
  every message row for retry).
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

- D1 `jobs` table: job metadata, persisted caller context, schedule, run
  counters, last error, last duration, run history, repo source reference, and
  stable `storage_id`
- `JobManager` SQLite: only alarm bookkeeping needed to wake the right user's
  due jobs
- `StorageRunner` SQLite: isolated durable state addressed by `storageId`

## Per-user Durable Object naming

The Durable Objects whose state is intrinsically owned by one user are named so
that two different users always resolve to two different object ids. Builders
live in `packages/worker/src/user-scoped-durable-object-name.ts` (JSON tuples
via `durableObjectNameFromParts`); domain helpers such as
`userScopedConnectorSessionKey` delegate to that module.

- `JobManager` — `jobManagerDurableObjectName(userId)` → `idFromName(userId)`.
- `RunLog` — `runLogDurableObjectName(userId)` → `idFromName(userId)`. One
  execution-history DO per user; there is no `user_id` column inside it because
  the DO identity is the user. See [Run records](./run-records.md).
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
dynamic `import("kody:@...")` imports are hydrated at execution time from the
current published package export under the caller's `userId`.

## Configuration reference

Bindings are configured per environment in `packages/worker/wrangler.jsonc`
(names and bindings only; remote D1/KV IDs come from deploy-generated configs):

- `APP_DB` (D1)
- `OAUTH_KV` (KV)
- `BUNDLE_ARTIFACTS_KV` (KV)
- `EMAIL_BLOBS` (R2, raw email MIME blobs)
- `MCP_OBJECT` (Durable Objects)
- `REMOTE_CONNECTOR_SESSION` (Durable Objects)
- `JOB_MANAGER` (Durable Objects)
- `RUN_LOG` (Durable Objects; per-user run records — see
  [Run records](./run-records.md))
- `STORAGE_RUNNER` (Durable Objects)
- `REPO_SESSION` (Durable Objects)
- `PACKAGE_REALTIME_SESSION` (Durable Objects)
- `PACKAGE_SERVICE_INSTANCE` (Durable Objects)
- `ASSETS` (static assets bucket)
- `USAGE_EVENTS` (Analytics Engine dataset, production/preview only; see
  [Usage metering](./usage-metering.md))

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
`package_publish_external_push` call. The Worker scheduled handler runs every
five minutes (`wrangler.jsonc` `*/5 * * * *`) and loops over batches of stale
`entity_sources` rows (selected by `last_external_check_at`) until the backlog
is drained or a wall-clock time budget (`reconcileTimeBudgetMs`, ~60 seconds) is
exhausted, so throughput scales with backlog size instead of being capped at one
batch per tick. For each source it resolves the Artifacts default-branch HEAD
cheaply; when HEAD matches `published_commit` (or is unresolvable) it only
advances `last_external_check_at` without any Durable Object work, and it spins
up the RepoSession publish path only when HEAD differs.

The reconcile loop is idempotent: if another caller publishes the same commit
first, the publish path returns `already_published`. Check failures and
non-fast-forward results leave D1/KV untouched and are counted in the one-line
metrics log, which also records batches processed and whether the time budget
was exhausted. Once per day during the 03:00 UTC cron window, reconcile also
calls `revokeStaleArtifactsTokens(...)` for checked repos to clean up expired
Artifacts tokens.

Reconcile runs as one lane of the scheduled handler in
`packages/worker/src/index.ts`, alongside repo-session cleanup, system-email
retention, general retention, and hourly usage-rollup aggregation. Lane failures
are isolated: each rejected lane is logged with a `scheduled_lane_failed` tag
and reported to Sentry, and the handler never throws, so one broken lane cannot
abort or mask the others.

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

- `jobs.params_json`, `jobs.schedule_json`, `jobs.caller_context_json`,
  `jobs.run_history_json`, and `jobs.repo_check_policy_json`
  (`packages/worker/migrations/0018-jobs.sql`,
  `0025-jobs-repo-check-policy.sql`, `packages/worker/src/jobs/repo.ts`).
  `run_history_json` is **unwritten** (run records own history; the column
  remains until a follow-up drop migration). The other fields rely on parser and
  normalizer compatibility. Package jobs persist both `storageContext.appId` for
  value scope and `storageContext.packageId` for package-owned secret scope.
- `saved_packages.tags_json` and `community_listings.tags_json`
  (`0027-saved-packages.sql`, `0045-community-listings.sql`) are `string[]`
  projections.
- `published_bundle_artifacts.dependencies_json`
  (`0028-published-bundle-artifacts-and-archived-jobs.sql`) stores package
  dependency pointers queried with SQLite JSON functions in
  `packages/worker/src/repo/published-bundle-artifacts-repo.ts`.
- `package_invocations.package_ids_json`,
  `package_invocations.package_kody_ids_json`,
  `package_invocations.export_names_json`, `package_invocations.sources_json`,
  and `package_invocations.response_json` (`0029-package-invocations.sql`) store
  invocation routing and cached response projections.
- `email_messages.*_addresses_json`, `email_messages.references_json`,
  `email_messages.headers_json`, and `email_delivery_events.detail_json`
  (`0030-email-primitives.sql`, `0031-unified-email-receipt.sql`,
  `0061-email-delivery-lifecycle.sql`) store parsed email metadata and provider
  delivery details. Provider event ids are unique for idempotent Queue
  ingestion; `email_messages.delivery_status` is the latest provider state,
  separate from send-request `processing_status`.
- `webhook_endpoints` / `webhook_deliveries` (`0090-webhook-endpoints.sql`)
  store per-user minted URL state for `package.json#kody.webhooks`, keyed by
  `(user_id, package_id, webhook_name)`. URL secrets are SHA-256 hashed;
  verification secrets stay in the secrets primitive (`secretName` at delivery
  time). Delivery history is recorded as `webhook` surface run records (see
  [Run records](./run-records.md) and [Inbound webhooks](./webhooks.md));
  writers do not use `webhook_deliveries`; the table remains until a follow-up
  drop migration. Account deletion/export still include any remaining delivery
  rows.
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
- `package_runtime_runs.metadata_json` and `package_runtime_logs.fields_json`
  (`0037-package-runtime-debug.sql`) are **unwritten** leftover JSON shapes.
  Writers do not use those tables; metadata and log fields live in the `RunLog`
  Durable Object (`runs.metadata_json`, `run_logs.fields_json`). A follow-up
  migration drops the D1 tables.

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

Storage ids are also stable strings: execute storage uses `exec:{uuid}`, job
storage uses `job:{jobId}`, and package services use
`service:{encodeURIComponent(packageId)}:{encodeURIComponent(serviceName)}`.

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
- `package-retriever-index:v1:{userId}:{scope}` — legacy combined retriever
  index blob retained as a delete-only cleanup target; active index rows use
  `package-retriever-index-entry:v1:...`. Package refresh/removal and account
  deletion delete the known `search` and `context` keys directly, so cleanup
  does not depend on KV prefix listing. There is no global sweep because that
  would require cross-user KV enumeration.
- `derived-cache:v1:usage-rollups:user:{userId}:asof:{YYYY-MM}` — derived
  per-user usage read model written with KV `expirationTtl`; retention is five
  minutes, so immediate account-deletion cleanup is not required.

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
  stores this key in `email_messages.raw_mime_key`. The `userId` prefix is part
  of the per-user isolation contract; account deletion deletes a user's blobs by
  the keys stored on their rows.

New R2 key prefixes must add corresponding account-deletion coverage or a
deliberate retention note, same as KV. All currently registered R2 surfaces use
the bounded `r2_object` account-export section; the inventory is derived from
the same user-owned D1 rows used by account deletion.

### Vectorize metadata contracts

Vector ids and metadata are conventional and require reindexing when changed.
User-owned ids must also stay within Cloudflare Vectorize's 64-byte id limit:
builders first emit the legacy passthrough form when it fits, then fall back to
`{prefix}_sha256:{truncatedHexDigest}` for overlong raw ids. Length checks are
UTF-8 byte checks, not JavaScript string-length checks, and the digest form is
deterministic so upserts and deletes target the same vector.

- Memories: `memory_{memoryId}` with metadata
  `{ kind: 'memory', userId, status, category? }`. Memory ids are UUID-like, so
  search parses only the passthrough `memory_` form back to the D1 id.
- Jobs: `job_{jobId}` or `job_sha256:{digest}` with metadata
  `{ kind: 'job', userId }`. Package-owned job ids
  `package-job:{packageId}:{jobName}` often need the digest form.
- Saved packages: `package_{packageId}` or `package_sha256:{digest}` with
  metadata `{ kind: 'package', userId }`.
- Builtin capabilities: id is the capability name with metadata
  `{ kind: 'builtin', domain }`.

Every user-owned Vectorize query must filter by `userId`; capability vectors are
global built-in metadata and are rebuilt through the maintenance reindex path.

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
   dynamic `import("kody:@...")` calls resolve at runtime to the caller's
   current published package export.

Do not change this grammar or static/dynamic distinction without a user-code
migration plan.

### Growth and retention policies

The Worker scheduled handler runs every five minutes, but
`packages/worker/src/app/retention.ts` gates the general retention job to the
top of the hour. Each hourly run loops in round-robin passes over the policy
tables — every pending table gets one configured batch before any table gets a
second one — until every table is drained or the run's time budget
(`retentionRunTimeBudgetMs`, ~20 seconds measured with `Date.now`) is exhausted.
The first pass always completes so a hot table cannot starve the others, and
per-batch sizes stay small to bound D1 single-writer pressure. Progress is
reported with a one-line `retention-prune` log that includes batches-per-table
counts and whether the budget ran out. The retention module owns the named
constants and manifest, and `packages/worker/src/app/retention.node.test.ts`
fails if a future growth-pattern D1 table is added without either a policy or a
documented exemption.

Current retention policies:

- `package_runtime_runs` / `package_runtime_logs`: **drain-only leftovers.** Run
  records self-prune inside the per-user `RunLog` Durable Object (about 30 days
  and at most 2,000 runs per user, failure-last — see
  [Run records](./run-records.md)). These D1 lanes drain any remaining rows (30
  days / at most 500 runs per `(user_id, package_id)`, keeping `running` rows
  and referenced runs) until a follow-up migration drops the tables. Logs are
  deleted before their runs, and orphan logs are pruned separately. The age
  prune is index-driven; the per-package cap prune ranks only a bounded set of
  the largest `(user_id, package_id)` pairs per batch
  (`packageRuntimeCapPairsPerBatch`) instead of window-ranking the whole table.
- `package_invocations`: keep terminal idempotency rows for 90 days. Rows with
  `status = 'in_progress'` are never pruned so duplicate requests cannot bypass
  the in-flight guard.
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
  rows under `system:email` remain governed by the system-email retention job,
  which prunes messages (and their `EMAIL_BLOBS` raw-MIME blobs) and delivery
  events older than 90 days in bounded batches within its own time budget,
  deletes stale `system_email_daily_counters`, and caps stored system messages
  at 5000.
- `email_messages` / `email_attachments` / `email_threads`: user-owned messages
  (excluding the `system:email` owner) keep 365 days, deleted oldest first in
  batches. Retention deletes the deterministic
  `emailRawMimeKey(userId, messageId)` from `EMAIL_BLOBS` before D1 rows; if the
  blob delete fails, those rows are skipped and still selected on later runs so
  cleanup can retry. Dependent `email_attachments` rows are deleted before their
  messages, and threads left with no messages are pruned for the affected users.
- `entitlement_daily_counters`: daily rate counters keep 400 days by `day` key.
- `usage_rollups`: per user/metric/month rollups keep 24 months by `month` key;
  raw Analytics Engine usage events follow platform retention.
- `platform_feedback`: open and triaged rows remain until review changes them to
  resolved or dismissed, or the submitter deletes their account. Resolved and
  dismissed rows keep 365 days after `updated_at`; submitter deletion removes
  any remaining rows.
- `audit_events`: global hashed auth/security audit events keep 180 days. They
  are not user-owned D1 rows and remain independent of account deletion/export.
- `stripe_webhook_events`: platform Stripe webhook idempotency rows keep 30 days
  by `processed_at`. They are not user-owned and remain independent of account
  deletion/export.

Migration `0055-retention-indexes.sql` adds the global time-column indexes these
prunes order by (`created_at` / `day` / `month` / `started_at` across users);
per-user composite indexes cannot serve those ordered scans.

Documented exemptions: `archived_job_artifacts` is exempt because job artifact
cleanup is driven by each row's `retain_until` value, and `mcp_memories` is
exempt because memories are durable user-curated content removed by explicit
user action or account deletion rather than by time-based retention.
