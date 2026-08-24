# Jobs worker migration runbook

Production owns `JobManager`, `JOBS_DB`, and the five-minute cron on
`kody-jobs`. `transferred_classes` is a one-shot cutover; do not invent a second
transfer or add `deleted_classes` for `JobManager`.

This page records current ownership and the invariants later deploys must keep.
The cutover that landed is in the
[historical appendix](#historical-appendix-2026-jobs-cutover). Do not follow
that appendix as a live playbook.

Operational notes for the dedicated jobs worker (`packages/jobs-worker`, ADR
[0016 — Mono-worker extraction](../decisions/0016-mono-worker-extraction.md)).
Later deploys follow `.github/workflows/deploy.yml`. Do not re-run the Durable
Object transfer or a bounded D1 copy against live production.

## Ownership

| Concern                                                          | Owner                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `JobManager` Durable Object (per-user scheduling state + alarms) | `kody-jobs`                                                        |
| `jobs` / `archived_job_artifacts` tables                         | `JOBS_DB` on `kody-jobs`                                           |
| Five-minute cron and `kody-scheduled-dispatch` queues            | `kody-jobs`                                                        |
| Job execution / scheduled lanes (`JobsHost`)                     | `kody` (origin); `kody-jobs` calls back through the `HOST` binding |
| Job reads and writes from origin / MCP / dashboards              | `JOBS` service binding (`JobsService`) on origin                   |

`APP_DB` has no `jobs` or `archived_job_artifacts` tables. The schema change is
`packages/worker/migrations/0010-drop-jobs-tables.sql`. Live authority is
`JOBS_DB`. Do not query those names on `APP_DB`, do not copy them "one more
time," and do not treat 0010 as a waiting follow-up.

## Invariants

- Do not add another `transferred_classes` row for `JobManager`. The `v1`
  transfer already applied on production `kody-jobs`
  (`packages/jobs-worker/wrangler.jsonc`,
  `{ from: "JobManager", from_script: "kody-production", to: "JobManager" }`).
- Never add `deleted_classes` for `JobManager`. That destroys transferred
  per-user DO storage. Deploy guardrails allowlist any `deleted_classes` edit.
- Object IDs derived from user IDs stay valid because the namespace moved with
  the class. Do not recreate `JobManager` on origin.
- Service bindings are by deployed worker name (wrangler appends the
  environment, so the production main worker script is `kody-production`):
  origin reaches the jobs worker through `JOBS` (`JobsService`) and `kody-jobs`
  calls back through `HOST` (`JobsHost`). The jobs worker must exist before a
  main-worker deploy that declares the `JOBS` binding can validate, which is why
  `.github/workflows/deploy.yml` deploys the jobs worker first when jobs sources
  change.
- Shared D1 besides `JOBS_DB` is unchanged: jobs data does not live on `APP_DB`.

## Later deploys

The merged main-branch deploy workflow encodes deploy order. Merge and watch; do
not pause job writes, export `APP_DB`, or apply a jobs-table drop by hand.

When jobs sources change, the workflow deploys `kody-jobs` before origin so the
`JOBS` binding validates. That order is binding hygiene. It does not re-apply
the `v1` transfer and it does not copy rows.

Remix/blog/UI-only uploads skip jobs.

Verify cron ticks (jobs-worker logs show `scheduled` invocations every 5 minutes
and queue consumption on `kody-scheduled-dispatch`), a due job running
end-to-end (`JobManager` alarm → `HOST.runDueJobsForUser` → a run in the user's
activity), and dashboards (`/account/jobs`) plus MCP `jobs_*` listing `JOBS_DB`
rows.

## Historical appendix: 2026 jobs cutover

**Do not re-run these steps.** They describe the one-shot Durable Object
transfer and bounded D1 copy that already landed. Re-exporting `jobs` /
`archived_job_artifacts` from `APP_DB` fails: those tables are gone. Re-issuing
`transferred_classes` or adding `deleted_classes` for `JobManager` destroys or
orphans production scheduling state.

Two coordinated moves landed:

1. **Durable Object transfer** — `JobManager` moved from the deployed
   `kody-production` script to the `kody-jobs` script via `transferred_classes`,
   keeping every existing per-user DO's storage and alarm.
2. **Bounded D1 data migration** — `jobs` and `archived_job_artifacts` rows
   copied from `APP_DB` (`kody-db`) into `JOBS_DB` during a brief write pause
   (job create/update/delete and finalization only). Dual-write was not used.
   After the read/write flip, `APP_DB` held a cold copy until
   `packages/worker/migrations/0010-drop-jobs-tables.sql` removed those tables.

Coordinated order that landed:

1. Provision `kody-jobs` D1 and the `kody-scheduled-dispatch` /
   `kody-scheduled-dispatch-dlq` queues (`tools/ci/jobs-worker-resources.ts`).
2. Apply the jobs D1 schema on `JOBS_DB`.
3. Pause job mutation surfaces (or wait for a quiet window).
4. Export the two tables from `APP_DB` and import into `JOBS_DB`; verify row
   counts.
5. Deploy `kody-jobs` (applied `v1` `transferred_classes`).
6. Deploy origin without a `JobManager` export, jobs cron, or scheduled-queue
   consumer — the read/write flip onto the `JOBS` binding.
7. Unpause; confirm cron, a due job, and dashboard/MCP lists.
8. After every remaining `APP_DB` reader of those tables was ported to the JOBS
   service contract, apply 0010. That migration is in the schema. There is no
   cold copy left on `APP_DB`.

Recovery after the transfer applied: roll _forward_ on `kody-jobs`. A reverse
`transferred_classes` migration (`from_script: "kody-jobs"`) was the escape
hatch to hand the namespace back; do not use it under incident pressure. There
is no `APP_DB` rollback copy.

Leftovers that wait on a later drop follow
[Cleanup after migrations](../cleanup-after-migrations.md).
