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

## D1 (`APP_DB`)

Relational app data lives in D1.

The schema is defined by migrations in `packages/worker/migrations/`:

- `users`: login identity and password hash
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
  `userScopedConnectorSessionKey(userId, kind, instanceId)`. Connectors must
  connect through the username-scoped ingress URL
  `/@{username}/connectors/{kind}/{instanceId}`. The DO carries the ingress user
  id forward via headers + websocket attachment and verifies the shared secret
  against that user's row only. The `MCP` Durable Object is addressed by MCP
  session id rather than user id; ownership is enforced at the request boundary
  by validating the authenticated user against the `McpCallerContext` on every
  request.

## Per-user runtime context (no shared `globalThis`)

Codemode `execute` calls and package-app worker entrypoints store the current
request's runtime in an `AsyncLocalStorage` shared between the wrapper and the
`kody:runtime` virtual module via `Symbol.for('kody.runtimeStorage')`. Two
concurrent calls in the same isolate observe their own runtime view through the
ALS rather than racing on a shared mutable `globalThis` slot. See
`packages/worker/src/package-runtime/module-graph.ts`,
`packages/worker/src/mcp/run-codemode-registry.ts`, and
`packages/worker/src/package-runtime/package-app.ts` for the wrapper
implementations, and
`packages/worker/src/package-runtime/runtime-isolation.node.test.ts` for the
concurrent two-runtime test that pins this invariant.

`kody:runtime` is also a host-external package-runtime module. Saved package
bundle artifacts reserve `.__kody_virtual__/runtime.js` import paths but strip
the runtime source before persistence. Execution loaders hydrate those paths
with the deployed host runtime source for every package surface (exports,
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
