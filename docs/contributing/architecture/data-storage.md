# Data storage

This project uses three Cloudflare storage systems for different purposes.

## D1 (`APP_DB`)

Relational app data lives in D1.

Current schema is defined by migrations in `packages/worker/migrations/`:

- `users`: login identity and password hash
- `password_resets`: hashed reset tokens with expiry and foreign key to users
- `chat_threads`: per-user chat thread records and relational metadata
- `jobs`: unified persisted job definitions, caller context, schedule state, and
  run observability counters/history

App access pattern:

- `packages/worker/src/db.ts` defines shared `remix/data-table` table metadata
  and creates a D1-backed database runtime via
  `packages/worker/src/d1-data-table-adapter.ts`
- Database row validation and API payload parsing use `remix/data-schema`
- app handlers and the mock Resend worker perform CRUD/query operations through
  `remix/data-table` (including `findOne`, `create`, `update`, `deleteMany`, and
  `count`)

## KV (`OAUTH_KV`)

OAuth provider state is stored in KV through the
`@cloudflare/workers-oauth-provider` integration.

- Binding is configured in `packages/worker/wrangler.jsonc` (remote KV IDs are
  supplied at deploy time via generated Wrangler configs, not committed in the
  template)
- This supports OAuth client and token flows without custom storage code in the
  app handlers

## Durable Objects (`MCP_OBJECT`)

MCP server runtime state is hosted via a Durable Object class (`MCP`) in
`packages/worker/src/mcp/index.ts`, exposed through the `/mcp` route.

- The Worker forwards authorized MCP requests to `MCP.serve(...).fetch`
- Durable Objects provide a stateful execution model for MCP operations

## Durable Objects (`ChatAgent`)

Chat conversations run through a chat Agent Durable Object.

- D1 stores thread rows in `chat_threads`
- The chat Agent's built-in SQLite stores the full transcript and chat runtime
  state (streaming, approvals, resumable context)
- The Worker routes same-origin browser chat traffic to the agent using the
  existing app session cookie rather than the public MCP OAuth flow

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

## Configuration reference

Bindings are configured per environment in `packages/worker/wrangler.jsonc`
(names and bindings only; remote D1/KV IDs come from deploy-generated configs):

- `APP_DB` (D1)
- `OAUTH_KV` (KV)
- `MCP_OBJECT` (Durable Objects)
- `ChatAgent` (Durable Objects)
- `JOB_MANAGER` (Durable Objects)
- `STORAGE_RUNNER` (Durable Objects)
- `ASSETS` (static assets bucket)

## Repo-backed packages and Artifacts

Repo-backed saved packages and repo editing sessions use Cloudflare Artifacts
repos plus D1 `entity_sources` / `repo_sessions` rows.

- Primary code lives under `packages/worker/src/repo/`.
- `entity_sources` stores the durable mapping from
  `(user_id, entity_kind, entity_id)` to the repo identity and last published
  commit.
- `repo_sessions` stores mutable editing forks for repo session Durable Objects.

Operational notes:

- Saved packages are the user-facing repo-backed identity. They resolve through
  D1 metadata to `entity_sources.id` when a repo editing session is opened.
- `source_id` remains the internal durable join key for repo-backed packages,
  but most MCP callers should prefer the package identity-first open/edit flow.
- Once a repo-backed package exists, the repo snapshot is the durable source of
  truth for later edits and publishes. Search and detail payloads are derived
  projections of that repo-backed package rather than a competing second source
  of truth.

Production note:

- Released `wrangler` `4.83.0` warns that the documented Artifacts Worker
  binding config is unexpected, and production deploy logs show no
  `env.ARTIFACTS` binding in the deployed Worker binding summary.
- Because of that deploy-time gap, repo source code uses the documented
  Artifacts REST API as the single integration path for create/get/token/fork
  operations.
- `packages/worker/src/repo/artifacts.ts` builds that REST client from
  `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and optional
  `CLOUDFLARE_API_BASE_URL` / `ARTIFACTS_NAMESPACE`, which also makes local dev
  mocking straightforward.
- During `npm run dev`, those REST calls go to the local Cloudflare mock Worker,
  which implements the Artifacts repo metadata endpoints used by the app
  (`create`, `get`, `list`, `createToken`, and `fork`). The mock only covers the
  REST control plane; repo session Durable Objects need a Git-capable remote
  for clone/pull/push flows.
- Durable repo-source creation paths
  (`ensureEntitySource(..., requirePersistence: true)`) fail closed when
  persistence bindings are unavailable so callers do not write orphaned
  `source_id` references into D1.
