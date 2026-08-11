# Jobs worker migration runbook

Operational runbook for cutting production over to the dedicated jobs worker
(`packages/jobs-worker`, ADR
[0016 — Mono-worker extraction](../decisions/0016-mono-worker-extraction.md)).
It covers two coordinated moves:

1. **Durable Object transfer** — the `JobManager` class moves from the deployed
   `kody-production` script to the `kody-jobs` script via a Wrangler
   `transferred_classes` script migration, keeping every existing per-user DO's
   storage and alarm.
2. **Bounded D1 data migration** — the `jobs` and `archived_job_artifacts` rows
   move from `APP_DB` (`kody-db`) into the dedicated `kody-jobs` D1 database.

This document is the executable plan. Writing this PR does **not** execute any
production step: no production Durable Object migration is applied and no
production data is exported or imported as part of landing the code. A human
operator (or the coordinating parent session) runs the steps below in order.

## Invariants

- `JobManager` DO storage (per-user scheduling state and alarms) must survive
  the move byte-for-byte. `transferred_classes` guarantees this: the namespace
  and all object storage move to the receiving script; object IDs derived from
  user IDs stay valid.
- The `jobs` / `archived_job_artifacts` tables must not take writes while rows
  are copied (brief write pause; the pause window only blocks job
  create/update/delete and job finalization, not the rest of the app).
- `APP_DB` keeps its `jobs` and `archived_job_artifacts` tables until a later,
  separate migration drops them. That drop is intentionally **not** part of this
  PR or this cutover window.

## Cloudflare mechanics (why the order below)

- A `transferred_classes` migration lives in the **receiving** worker's config
  (`packages/jobs-worker/wrangler.jsonc`, tag `v1`,
  `{ from: "JobManager", from_script: "kody-production", to: "JobManager" }`).
  It is applied when the receiving worker (`kody-jobs`) is deployed.
- At the moment the transfer is applied, the source script (`kody-production`)
  must still have the `JobManager` class deployed and no in-flight deploy
  removing it. After the transfer, the namespace belongs to `kody-jobs`; a
  subsequent deploy of `kody-production` without the class (and without its DO
  binding) is valid and must **not** include a `deleted_classes` migration for
  `JobManager` (that would destroy the transferred data; the deploy-guardrails
  check enforces an allowlist for any `deleted_classes`).
- Service bindings are by deployed worker name (wrangler appends the
  environment, so the production main worker script is `kody-production`):
  `kody-production` reaches the jobs worker through the `JOBS` binding
  (`JobsService` entrypoint) and `kody-jobs` calls back into `kody-production`
  through the `HOST` binding (`JobsHost` entrypoint). The jobs worker must exist
  before a main-worker deploy that declares the `JOBS` binding can validate,
  hence the deploy ordering in `.github/workflows/deploy.yml` (jobs worker
  deploys first).

## Cutover steps (production)

Prerequisites: Cloudflare API token with D1 + Workers permissions, `jq`,
repository checkout at the release SHA.

### 1. Provision resources (idempotent)

```sh
node tools/ci/jobs-worker-resources.ts ensure --env production \
	--out-config packages/jobs-worker/wrangler-production.generated.json
```

Creates (when missing) the `kody-jobs` D1 database and the
`kody-scheduled-dispatch` / `kody-scheduled-dispatch-dlq` queues, and writes the
generated deploy config. The deploy workflow runs the same command.

### 2. Apply the jobs D1 schema

```sh
node ./wrangler-env.ts d1 migrations apply JOBS_DB --remote \
	--config packages/jobs-worker/wrangler-production.generated.json
```

### 3. Pause job writes briefly

Enable the platform kill switch for job mutation surfaces (or schedule the
window during a quiet period). The copy in step 4 is bounded: both tables are
small (thousands of rows, not millions), so the pause is minutes. Dual-write is
intentionally not used — the tables have single-writer semantics through the
jobs service and a short pause is simpler and safer than reconciling concurrent
writers.

### 4. Copy `jobs` and `archived_job_artifacts` from `APP_DB`

Export via the Cloudflare D1 export API (SQL dump limited to the two tables),
then import into `kody-jobs`:

```sh
# Export from APP_DB (kody-db)
curl -sX POST \
	"https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database/$APP_DB_ID/export" \
	-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
	-H 'Content-Type: application/json' \
	-d '{"output_format":"polling","dump_options":{"tables":["jobs","archived_job_artifacts"],"no_schema":true}}' \
	| jq -r '.result.at_bookmark' # poll until signed_url is returned, then download

# Import into kody-jobs (schema already applied in step 2)
npx wrangler d1 execute kody-jobs --remote --file ./jobs-export.sql
```

Verify row counts match on both sides:

```sh
npx wrangler d1 execute kody-db --remote \
	--command 'SELECT COUNT(*) FROM jobs; SELECT COUNT(*) FROM archived_job_artifacts;'
npx wrangler d1 execute kody-jobs --remote \
	--command 'SELECT COUNT(*) FROM jobs; SELECT COUNT(*) FROM archived_job_artifacts;'
```

### 5. Deploy the jobs worker (applies the DO transfer)

Deploy `kody-jobs` **before** deploying a main-worker build that removes the
`JobManager` class:

```sh
npm run build # not required for the jobs worker; it deploys from source
npx wrangler deploy --config packages/jobs-worker/wrangler-production.generated.json --env production
```

This deploy applies migration tag `v1` (`transferred_classes`), taking ownership
of every existing `JobManager` object and its storage. Healthcheck:
`curl https://<jobs-worker-host>/health`.

### 6. Deploy the main worker (flips reads/writes to the jobs worker)

Deploy the main-worker (`kody-production`) build from this PR. Its config has no
`JobManager` class export, no jobs cron, and no scheduled-queue consumer; all
job reads and writes go through the `JOBS` service binding, so this deploy is
the read/write flip. The regular deploy workflow performs steps 1, 2, 5, and 6
in this order automatically.

### 7. Unpause and verify

- Clear the kill switch from step 3.
- Confirm cron ticks: jobs-worker logs show `scheduled` invocations every 5
  minutes and queue consumption on `kody-scheduled-dispatch`.
- Confirm a due job runs end-to-end (JobManager alarm → `HOST.runDueJobsForUser`
  → run recorded in the user's activity).
- Confirm dashboards (`/account/jobs`) and MCP `jobs_*` capabilities list the
  copied rows.

### 8. Later: drop the old tables from `APP_DB`

After a soak period (suggested: one week) with no fallback reads, land a
separate `packages/worker/migrations/` migration dropping `jobs` and
`archived_job_artifacts` from `APP_DB`, following the migration-ledger process.
Not part of this cutover.

## Rollback

- Before step 5: nothing to roll back (resources are additive).
- After step 5 but before step 6: redeploy the previous main-worker build; the
  DO namespace already belongs to `kody-jobs`, and the previous build reaches it
  only if it still has a `JOB_MANAGER` binding — so prefer rolling forward. A
  reverse `transferred_classes` migration (`from_script: "kody-jobs"`) is the
  escape hatch to hand the namespace back.
- After step 6: roll forward. The old `APP_DB` tables still hold the pre-pause
  rows as a cold copy until step 8, so data loss is bounded to the cutover
  window in the worst case.
