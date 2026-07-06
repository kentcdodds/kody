# Data storage

This project uses several Cloudflare storage systems for different purposes.

## Per-user isolation invariant

Kody is multi-user with strict per-user isolation. Every storage layer described
below is scoped by `user_id` (D1 columns, Vectorize metadata, KV key prefixes,
Durable Object names) and every read/write path takes a `userId` argument. Two
users with the same logical identifier (for example the same `kind`/`instanceId`
pair on a remote connector, the same package id, or the same storage id) land on
different durable objects and different rows. Any new persistence layer added to
the project must follow the same convention; user-scoped tests should exercise
both the "happy" path and a cross-user denial path.

The deliberate storage exception is **operator-owned system email** for reserved
platform local parts (`kody`, `support`, `abuse`, `postmaster`, `security`, and
`admin`). Those messages reuse the email tables but are stored under the
reserved owner id `system:email`, which is not a login account and must not be
conflated with the `kody@example.com` fixture or Kent's personal account.
Account deletion and export treat `system:email` rows as platform/operator
content, not user data; the exclusion is listed in
`accountUserDataExcludedOwnerIds` with a reason and is covered by guardrail
tests.

## Account deletion inventory

Account deletion is implemented in `packages/worker/src/app/account-deletion.ts`
and is intentionally inventory driven. The operation first enumerates user-owned
identifiers while D1 rows still exist, then best-effort deletes out-of-band
stores, then deletes or clears D1 rows, revokes OAuth grants, and finally
deletes the `users` row. Each step records deleted counts, updated counts for
cleared references, and warnings so the HTTP response states what was removed
and what needs operator attention. Re-running the operation is safe: missing
rows, missing KV keys, missing vectors, deleted Artifacts repos, and
already-cleared Durable Objects are treated as successful no-ops or warning-only
failures.

System email rows owned by `system:email` are intentionally excluded from
account deletion. They are operator-owned inbound mail for reserved platform
addresses, not portable user content, and are bounded by fixed system caps plus
the scheduled system-email retention prune.

Deletion must cover these user-owned surfaces:

- **D1:** every live table with `user_id` / `*_user_id` ownership columns, plus
  transitive children (`secret_entries`, `value_entries`, `email_attachments`)
  and listing children for community-owned listings. The guardrail test in
  `packages/worker/src/app/account-deletion.node.test.ts` applies the live
  migrations to SQLite and fails if a user-owned schema column is not
  represented in the deletion target list, or if the deletion target list
  references a stale column.
- **Durable Objects:** `JobManager`, `StorageRunner`, `RepoSession`,
  `RemoteConnectorSession`, `PackageRealtimeSession`, and
  `PackageServiceInstance` are purged through account-deletion RPCs after their
  D1 identifiers are collected. `MCP` objects are session-keyed by the MCP SDK
  rather than user-keyed and are not globally enumerable; account deletion
  revokes OAuth grants/tokens so those sessions cannot continue making
  authorized user requests.
- **Vectorize:** memory, job, and saved-package vector ids are derived from D1
  rows and removed with `deleteByIds`.
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
same user-owned storage surfaces. The D1 table list is shared with account
deletion (`accountUserDataTargets`), and
`packages/worker/src/app/account-export.node.test.ts` applies the live
migrations to SQLite and fails if a `user_id` / `*_user_id` column is not
covered by the export list. The hard invariant is the same as every storage
path: callers pass the authenticated user's stable MCP `userId`, and every query
or Durable Object lookup is scoped to that id.

System email rows owned by `system:email` are intentionally absent from account
exports for the same reason they are absent from deletion: they belong to the
operator inbox surface, not to the exporting user. The export manifest lists
this under `excludedD1Surfaces` so the omission is explicit.

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
hashes, package invocation token hashes, and email reply token hashes. The
manifest states these redactions explicitly so a partial or intentionally
redacted export is not mistaken for a complete secret backup.

The browser route `GET /account/export.json` downloads a full JSON export for
the signed-in user. The MCP capability domain `account` provides a
migration-safe chunked interface:

- `account_export_manifest` returns the manifest, counts, warnings, and chunking
  instructions.
- `account_export_section` pages through one section at a time. D1 rows are read
  with `section: "d1_table"` and a table name. Durable storage buckets are read
  with `section: "storage_runner"` and a `storage_id`, using the same
  StorageRunner `exportStorage({ pageSize, startAfter })` RPC as the dedicated
  storage export capability.

Durable Object export behavior:

- `StorageRunner` bucket contents are exported with paged entries. These buckets
  hold application/job/service durable state and are the primary account
  migration surface for Durable Object storage.
- `JobManager` exposes scheduler alarm/debug state through an export RPC.
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

- `users`: login identity and password hash. There is no persisted mapping from
  the stable MCP `userId` (SHA-256 of the normalized email) back to the row;
  contextless paths (inbound email) reverse-resolve it by scanning and hashing
  (`findUserAccountByStableUserId`). A persisted, indexed `stable_user_id`
  column with an app-level backfill is required before onboarding external users
  / design partners.
- `password_resets`: hashed reset tokens with expiry and foreign key to users
- `jobs`: persisted job metadata, caller context, schedule state, repo source
  pointers, and run observability counters/history
- `entity_sources`: durable mapping from user-facing entities to Artifacts repos
  and their latest published commit
- `saved_packages`: package metadata/search projection derived from published
  `package.json` source

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

Storage split:

- D1 `jobs` table: job metadata, persisted caller context, schedule, run
  counters, last error, last duration, run history, repo source reference, and
  stable `storage_id`
- `JobManager` SQLite: only alarm bookkeeping needed to wake the right user's
  due jobs
- `StorageRunner` SQLite: isolated durable state addressed by `storageId`

## Per-user Durable Object naming

The Durable Objects whose state is intrinsically owned by one user are named so
that two different users always resolve to two different object ids:

- `JobManager` — `idFromName(userId)`
  (`packages/worker/src/jobs/manager-client.ts`).
- `StorageRunner` — `idFromName(JSON.stringify([userId, storageId]))`
  (`packages/worker/src/storage-runner.ts`).
- `RepoSession` — keyed by `repo_sessions.id`; every RPC validates the D1
  session row's `user_id` before touching the workspace. Account deletion
  enumerates the user's session ids before deleting D1 rows and purges each DO.
- `PackageRealtimeSession` and `PackageServiceInstance` — keyed by
  `(userId, packageId, ...)` via the helpers in
  `packages/worker/src/package-runtime/`. Account deletion enumerates app
  packages and observed service instances, closes live sessions/services, clears
  alarms, and deletes DO storage.
- `RemoteConnectorSession` —
  `userScopedConnectorSessionKey(userId, kind, instanceId)`, where `instanceId`
  is the explicit user-chosen connector name (globally unique per user).
  Connectors must connect through the username-scoped ingress URL
  `/@{username}/connectors/{kind}/{connectorName}`. Renaming a connector changes
  this DO id; the old live session snapshot can be orphaned, but reconnecting
  rebuilds it from settings. The DO carries the ingress user id forward via
  headers + websocket attachment and verifies the shared secret against that
  user's row only. The `MCP` Durable Object is addressed by MCP session id
  rather than user id; ownership is enforced at the request boundary by
  validating the authenticated user against the `McpCallerContext` on every
  request.

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
- `MCP_OBJECT` (Durable Objects)
- `REMOTE_CONNECTOR_SESSION` (Durable Objects)
- `JOB_MANAGER` (Durable Objects)
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
five minutes (`wrangler.jsonc` `*/5 * * * *`), selects a small batch of stale
`entity_sources` rows by `last_external_check_at`, resolves the Artifacts
default-branch HEAD, and calls the same external publish path when HEAD differs
from `published_commit`.

The reconcile loop is idempotent: if another caller publishes the same commit
first, the publish path returns `already_published`. Check failures and
non-fast-forward results leave D1/KV untouched and are counted in the one-line
metrics log. Once per day during the 03:00 UTC cron window, reconcile also calls
`revokeStaleArtifactsTokens(...)` for checked repos to clean up expired
Artifacts tokens.

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
  `run_history_json` is capped in code; the other fields rely on parser and
  normalizer compatibility.
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
  (`0030-email-primitives.sql`, `0031-unified-email-receipt.sql`) store parsed
  email metadata; `detail_json` is write-mostly audit detail.
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
- `package_runtime_runs.metadata_json` and `package_runtime_logs.fields_json`
  (`0037-package-runtime-debug.sql`) store bounded debug metadata and log
  fields.

### Durable Object id contracts

`idFromName` inputs are Durable Object identity. Changing any of these strings
or tuple layouts creates new objects and strands existing object storage.

- `JobManager`: `idFromName(userId)`.
- `StorageRunner`: `idFromName(JSON.stringify([userId, storageId]))`.
- `RepoSession`: `idFromName(repo_sessions.id)`; the key is not user-prefixed,
  so every RPC must keep validating the D1 row's `user_id`.
- `PackageRealtimeSession`: `idFromName(JSON.stringify([userId, packageId]))`.
- `PackageServiceInstance`:
  `idFromName(JSON.stringify([userId, packageId, serviceName]))`.
- `RemoteConnectorSession`:
  `idFromName(JSON.stringify([userId, normalizedKind, normalizedInstanceId]))`.
- `MCP`: session-keyed by the MCP SDK rather than by user id; OAuth caller
  context is the request-time ownership boundary.

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
- `package-retriever-index:v1:{userId}:{scope}` for the legacy combined
  retriever index blob.
- `package-retriever-index-entry:v1:{userId}:{scope}:{packageId}:{retrieverKey}`
  for per-entry retriever index rows.

Account deletion derives these keys from D1 rows and package ids before deleting
D1 projections. New KV prefixes must add corresponding account-deletion coverage
or a deliberate retention note.

### Vectorize metadata contracts

Vector ids and metadata are conventional and require reindexing when changed:

- Memories: `memory_{memoryId}` with metadata
  `{ kind: 'memory', userId, status, category? }`.
- Jobs: `job_{jobId}` with metadata `{ kind: 'job', userId }`.
- Saved packages: `package_{packageId}` with metadata
  `{ kind: 'package', userId }`.
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

### Growth and retention watch list

These tables can grow without a built-in retention policy beyond account
deletion or narrow cleanup paths: `audit_events`, user-owned `email_messages`
and related email tables, `package_runtime_runs`, `package_runtime_logs`,
`workflow_runs`, `package_invocations`, and old published bundle/KV artifacts.
System email rows under `system:email` are the email exception: cron prunes
messages and delivery events older than 90 days, deletes stale
`system_email_daily_counters`, and caps stored system messages at 5000. User
email retention is still account-deletion scoped. `usage_rollups` is bounded by
`(user_id, metric, month)`, while raw Analytics Engine usage events follow
platform retention.
