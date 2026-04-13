# Scheduled jobs

Kody scheduled jobs persist agent-authored Durable Object code and run it on an
alarm-based schedule.

Each saved job has:

- **`serverCode`** — Durable Object code that exports
  `class Job extends DurableObject`
- **`serverCodeId`** — a UUID that rotates whenever the server code changes so
  the Dynamic Worker loader does not reuse stale code
- **`schedule`** — either a cron expression or an interval in milliseconds
- **`timezone`** — IANA timezone for cron evaluation, defaulting to
  **`America/Denver`**
- **`enabled`** — whether the alarm should keep firing

Jobs are managed with these capabilities:

- `job_create`
- `job_update`
- `job_delete`
- `job_list`
- `job_get`
- `job_run_now`
- `job_enable`
- `job_disable`
- `job_history`
- `job_storage_reset`
- `job_server_exec`

## Execution model

Each job gets its own **`JobRunner`** supervisor Durable Object keyed by
`job_id`. The supervisor:

- stores observability metadata in its own SQLite database
- loads the job server code as a **Durable Object Facet**
- invokes the job facet by calling **`await job.run()`**
- computes the next alarm time and re-arms itself

The facet gets its own isolated Durable Object SQLite storage, so a job can
store incremental state with `this.ctx.storage.sql` or `this.ctx.storage.kv`
without mixing that state into supervisor metadata.

## Schedule semantics

Jobs support two schedule shapes:

```json
{ "cron": "0 8 * * *" }
```

or

```json
{ "intervalMs": 3600000 }
```

Cron uses standard **5-field** syntax and is interpreted in the configured IANA
timezone.

Interval schedules are measured from the **completion time of the last run**.
This avoids overlapping back-to-back alarm executions when a run takes a long
time.

### Alarm drift and overruns

- Kody re-arms the next alarm **after** each run finishes.
- If a run takes longer than its nominal interval, the next run is scheduled
  from the completion timestamp rather than trying to "catch up" missed
  intervals.
- `job_run_now` does **not** replace the normal schedule. It records a manual
  run and preserves the existing next scheduled alarm.

## Authoring `serverCode`

Job code must export:

```ts
import { DurableObject } from 'cloudflare:workers'

export class Job extends DurableObject {
	async run() {
		return { ok: true }
	}
}
```

There is no HTTP `fetch()` surface for jobs. The entrypoint is `run()`.

## `KODY` bridge inside jobs

Job facets do not get unrestricted outbound networking. Instead they receive a
`KODY` binding with a controlled bridge back into Kody:

- `fetchWithResolvedSecrets({ url, method, headers, body })`
- `fetchViaHostGateway({ url, method, headers, body })`
- `valueGet(name, scope?)`
- `valueSet({ name, value, description?, scope? })`
- `connectorGet(args)`
- `connectorList()`
- `metaRunSkill(name, params?)`
- `secretPlaceholder(name, scope?)`

`fetchViaHostGateway()` performs the outbound request through Kody's host
gateway and honors the same secret placeholder and host approval rules as
execute-time fetch.

The default bridge scope is job-local, but it maps onto Kody's existing
app-scoped storage buckets using a stable internal binding key for each job.
That means job-owned values and secrets stay isolated from saved apps and from
other jobs.

## Kill switch and observability

Each `JobRunner` keeps supervisor-owned metadata:

- run count
- success count
- failure count
- last run started/finished timestamps
- last run duration
- last error message and stack
- bounded run history (default last 50)
- kill switch flag

When the kill switch is on, alarm executions are skipped and the next alarm is
cleared until the job is re-enabled.

Use `job_history({ job_id, limit? })` to inspect recent runs.

## Storage reset and server exec

- `job_storage_reset({ job_id })` deletes the facet storage but keeps the saved
  job record and supervisor history.
- `job_server_exec({ job_id, code, params? })` executes one-off JavaScript
  against the live facet instance for debugging or data migrations.

## Example

See [Feed watcher example](./examples/job-feed-watcher.md) for a job that keeps
track of the last-seen item id in SQLite and only emits new items on later runs.
