# Run records

Kody records what each runtime surface ran and how it ended so users (and their
agents) can debug failures without scanning platform logs. This document
describes the contract, the per-user Durable Object store, persistence policy,
retention, and the recipe for instrumenting a new surface.

Deliberately out of scope: Analytics Engine aggregates (see
[Usage metering](./usage-metering.md)), Sentry platform alerts, and entity
“current state” columns such as `jobs.last_run_*`. Those neighbors are covered
in [Neighboring systems](#neighboring-systems).

## What a run record is

A run record is one execution attempt on a named **surface**: status (`running`
/ `success` / `error`), optional package/job/workflow identifiers, start and
finish timestamps, duration, truncated error fields, JSON metadata, and up to
200 captured log lines.

Package ownership is optional. Ad-hoc MCP `execute`, standalone `kody.json`
jobs, and inline workflows have no `package_id`; the record still lands under
the signed-in user. That optionality is why run records are not shaped as
package-scoped debug rows.

Code lives in `packages/worker/src/run-records/` (types, worker service, and the
`RunLog` Durable Object). MCP read capabilities live under
`packages/worker/src/mcp/capabilities/runs/`. The account UI is
`/account/activity`.

## Surfaces

| Surface        | Meaning                                                        |
| -------------- | -------------------------------------------------------------- |
| `execute`      | Ad-hoc MCP `execute` sandbox evaluation                        |
| `export`       | Saved-package export invocation                                |
| `subscription` | Package subscription handler dispatch                          |
| `app_fetch`    | Package app HTTP fetch handler                                 |
| `app_realtime` | Package app realtime websocket session                         |
| `service`      | Package service run (bounded or persistent)                    |
| `job`          | Scheduled or manually triggered job execution                  |
| `workflow`     | Cloudflare Workflow run (`DynamicCallableWorkflow`)            |
| `retriever`    | Package retriever evaluation                                   |
| `webhook`      | Authenticated inbound webhook delivery (and post-auth rejects) |

The closed union is `RunSurface` in `packages/worker/src/run-records/types.ts`.
Add new members there — never invent ad hoc surface strings at call sites.

## Persistence policy

`runPersistenceForSurface(surface)` returns:

- **`eager`** — every surface except `execute`. A `running` row is written at
  begin so an evicted or hung run is still visible in history.
- **`on-failure`** — key-less `execute` only. Nothing is persisted unless the
  run ends in `error`.

`runPersistenceForContext(context)` is what begin/finish actually use: same as
the surface default, except **`execute` with a caller-supplied `idempotencyKey`
upgrades to `eager`**.

Key-less `execute` stays on-failure because it is the highest-volume surface and
already returns its result (and logs) inline to the caller. Success counts for
key-less ad-hoc execute come from Analytics Engine via
[usage metering](./usage-metering.md), not from run records. Users who look for
successful key-less `execute` rows in Activity will not find them; that is
intentional.

When an external MCP client times out (for example MCP error `-32001`) while the
sandbox continues, a keyed execute call still has a recoverable record: the
caller can poll `run_get` with the returned `runId`, or retry `execute` with the
same `idempotencyKey` to receive a `replayed: true` result (or
`inProgress: true` while the first attempt is still running) without starting a
duplicate sandbox.

## Begin / finish contract

```ts
import { beginRunRecord, finishRunRecord } from '#worker/run-records/service.ts'

const handle = beginRunRecord({
	env,
	userId,
	context: {
		surface: 'job',
		name: job.name,
		jobId: job.id,
		// packageId / kodyId optional
	},
	waitUntil, // optional; preferred when ExecutionContext is available
})

try {
	// … do the work …
	await finishRunRecord({
		env,
		handle,
		status: 'success',
		logs,
	})
} catch (error) {
	await finishRunRecord({
		env,
		handle,
		status: 'error',
		logs,
		error,
	})
	throw error
}
```

Rules:

- **`beginRunRecord` is synchronous and non-blocking.** For `eager` surfaces it
  fire-and-forgets `startRun` (optionally via `waitUntil`). It returns a handle
  that already carries a minted run id, `startedAt`, persistence mode, and the
  full context — or `null` when there is no user / no `RUN_LOG` binding /
  missing context.
- **`finishRunRecord` upserts the complete row in one RPC** (`finishRun`), then
  replaces logs and enforces retention. A dropped `running` insert is harmless:
  finish still writes the terminal row. That is why begin can stay off the
  request critical path.
- **`on-failure` + `success` is a no-op** at finish (no DO write).
- Finish **never throws into the observed path**. Sink failures log a warning.
- Finish may accept an optional JSON-serializable **`result`**. When present it
  is stored under `metadata.result` after a bounded snapshot
  (`runRecordMaxResultSnapshotBytes`, currently 4 KiB). Oversized values become
  `{ __truncated__: true, preview }`. Eager surfaces that produce a handler
  return value (at minimum webhook deliveries and package exports, plus keyed
  execute) should pass it so `run_get` can show what the handler returned.
- Keyed execute claims the idempotency key through `claimRunRecord` (awaited DO
  RPC) before sandbox work so a concurrent retry sees `running` or the terminal
  row instead of starting a second attempt. Lookups are scoped by
  `(surface, idempotency_key)` so execute keys cannot collide with
  package/workflow history. Claim is select-then-insert inside one DO RPC
  (serialized), not a unique SQL constraint — other surfaces may reuse
  idempotency keys across history. Setup failures before sandbox work
  `abandonRunRecord` (delete if still `running`) so keys are not poisoned.
- Bundled-module runners (`runBundledModuleWithRegistry`) accept a `runRecord`
  context (and an optional pre-claimed `runRecordHandle`) and call begin/finish
  internally; surfaces that do not go through that helper call the service
  directly (webhooks, package apps, and similar).

## Per-user Durable Object

Records live in a per-user `RunLog` Durable Object with SQLite (`runs` and
`run_logs` tables). One DO per user:

```ts
runLogDurableObjectName(userId) // → idFromName(userId)
```

There is deliberately **no `user_id` column** inside the DO. The object identity
_is_ the user, so cross-user reads are structurally impossible: a caller that
passes the authenticated `userId` can only open that user’s stub. Binding name:
`RUN_LOG` (class `RunLog`).

This satisfies the repo-wide per-user isolation invariant the same way
`JobManager` and `McpClientHub` do — by namespacing Durable Object identity —
rather than by filtering a shared table.

## Why not D1

Run records are per-event writes. D1 is a single shared writer for the whole
deployment. Putting every execute failure, job run, webhook delivery, and
service wake on that writer would serialize unrelated user traffic — the same
reason usage metering writes Analytics Engine data points instead of upserting
D1 per event (see [Usage metering](./usage-metering.md) § Sinks). Per-user DO
SQLite keeps write contention on the user who produced the events. That is the
`no-per-event-shared-writes` invariant: per-event writes go to Analytics Engine
or per-user DO SQLite, never the shared D1 writer.

## Retention

Enforced **inside the DO on every `finishRun`**, not by a global cron lane over
a shared D1 table:

| Cap                        | Value                                           |
| -------------------------- | ----------------------------------------------- |
| Age                        | ~30 days (`runRecordRetentionDays`)             |
| Count                      | 2,000 runs per user (`runRecordMaxRunsPerUser`) |
| Log lines per run          | 200                                             |
| Text / JSON field budgets  | 16 KiB / 32 KiB truncated                       |
| `metadata.result` snapshot | 4 KiB (`runRecordMaxResultSnapshotBytes`)       |
| Stale `running` (short)    | ~3 minutes for execute/export/webhook/…         |
| Stale `running` (job)      | ~6 hours                                        |
| Stale `running` (long)     | ~24 hours for service/workflow                  |

Age prune deletes finished runs older than the cutoff (rows still `running` are
kept). Count prune deletes the oldest excess rows **failure-last**: successes
are removed before errors (`ORDER BY (status = 'error') ASC, started_at ASC`).
Orphan log lines are cleaned in the same pass. Caps are applied in small batches
per finish so a single RPC stays bounded.

Stranded `running` rows (isolate reset, lost `waitUntil` finish, hung Worker
Loader `evaluate`) are reconciled to `status=error` with `errorName=Interrupted`
(Interrupted means the execution outcome is unknown) using the surface-aware
TTLs above. Reconciliation runs on the DO alarm, on retention passes, and **on
read** (`getRun`, keyed lookup, `listRuns`, `summarize`) so Activity and
keyed-execute recovery do not wait for an alarm.

## Keyed package-invocation idempotency ledger

The same per-user `RunLog` DO also hosts the **keyed package-invocation
idempotency ledger** (`package_invocation_ledger` table), migrated off the D1
`package_invocations` table. This is correctness state, not observability: it
holds the claims and bounded replay responses that keyed `packages.invoke`
dedupes against. Unlike run history it cannot be rebuilt — a lost terminal row
means a replayed delivery for that key re-executes instead of replaying.

- **Claim + run-record begin are one awaited DO RPC**
  (`claimPackageInvocation`): lookup-then-insert is atomic because DO execution
  is serialized — strictly better than the D1 `INSERT OR IGNORE` race it
  replaced — and the eager `running` run row is written in the same call. Stale
  `in_progress` claims (15 minutes, matching request hash) are reclaimed in
  place.
- **Terminal response + run-record finish are one awaited DO RPC**
  (`finishPackageInvocation`): the bounded replay response (same restore-safe
  byte ceiling as before) and the terminal run row land together; the ledger
  update is fenced on the claim timestamp so a competing reclaim cannot be
  overwritten.
- **Ledger retention is DO-local**: terminal rows keep replay responses for 90
  days (`packageInvocationLedgerRetentionDays`), pruned by the same retention
  passes and alarm as run rows; `in_progress` rows are never pruned. There is no
  D1 sweep — the legacy table is gone.
- **The DO is the only store**: the legacy D1 `package_invocations` table was
  dropped (`0112-drop-package-invocations.sql`) after the dual-read window was
  deliberately waived, and the keyed path performs no D1 ledger reads or writes.
  Keys claimed before the DO migration no longer replay; a redelivery for such a
  key executes fresh, exactly like a new key.
- Account export pages ledger rows through the same `run_records` section cursor
  (runs first, then ledger rows); account deletion purges them with `clearAll`.
  Disaster recovery deliberately does not stage the DO — losing it risks
  duplicate execution of replayed webhooks (see
  [disaster recovery](../disaster-recovery.md)).

## Invariant: state vs history

Entity rows hold **current state**. Run records hold **history**. Never derive
live state (is this service running? how many?) by querying run records.

Entitlement concurrency reads `package_service_states` (migration `0095`), an
authoritative D1 projection upserted and heartbeaten by the service Durable
Object. History rows can outlive an evicted DO or stay `running` after a crash,
so they are not a reliable liveness signal. Jobs keep `last_run_*` and counters
on the `jobs` row for the same reason — those fields are entity state, not a
substitute for run history.

## Recipe: instrumenting a new surface

Modelled on the
[usage-metering chokepoint recipe](./usage-metering.md#recipe-instrumenting-a-new-chokepoint).

1. **Pick the semantic unit.** One run record per user-visible attempt (one job
   execution, one webhook delivery, one service wake). Nested layers may each
   record their own surface; do not double-write the same surface for one unit.
2. **Add the `RunSurface` member** to `runSurfaceValues` in
   `packages/worker/src/run-records/types.ts` if it does not exist. Choose
   persistence in `runPersistenceForSurface` (`eager` unless the caller already
   holds the full success result inline and volume is high — then consider
   `on-failure` and document why).
3. **Begin as soon as you have `userId` and context**, before the work that can
   fail:

   ```ts
   import {
   	beginRunRecord,
   	finishRunRecord,
   } from '#worker/run-records/service.ts'

   const handle = beginRunRecord({
   	env,
   	userId,
   	context: {
   		surface: 'my_surface',
   		name: entityName,
   		packageId, // optional
   		metadata: {
   			/* small, non-secret */
   		},
   	},
   	waitUntil: ctx.waitUntil.bind(ctx),
   })

   let status: 'success' | 'error' = 'success'
   let error: unknown
   const logs: Array<string> = []
   try {
   	// existing work; push console-equivalent lines into logs when available
   } catch (cause) {
   	status = 'error'
   	error = cause
   	throw cause
   } finally {
   	await finishRunRecord({ env, handle, status, logs, error })
   }
   ```

   If the path already goes through `runBundledModuleWithRegistry`, pass
   `runRecord: { surface, … }` instead of calling begin/finish yourself.

4. **Do not put secrets in metadata or logs.** Truncation helpers already bound
   size; redaction is still the caller’s job.
5. **Do not change behavior.** Recording must not alter return values or add
   critical-path latency beyond the awaited finish RPC (begin stays
   fire-and-forget).
6. **Keep state updates on the entity.** Update `last_run_*`, counters, or a
   dedicated state table in the same change if the surface has “is it running?”
   semantics — never teach entitlements or UI to infer that from run history.
7. **Test it.** Prefer a `*.workers.test.ts` against the real `RUN_LOG` binding
   (see `packages/worker/src/run-records/run-records.workers.test.ts`), or spy
   on `beginRunRecord` / `finishRunRecord` in Node unit tests the way usage
   metering spies on `recordUsage`.

## Neighboring systems

| System                          | Answers                                         | Store                                     |
| ------------------------------- | ----------------------------------------------- | ----------------------------------------- |
| **Run records** (this doc)      | What failed, with logs, for one user’s runs     | Per-user `RunLog` DO SQLite               |
| **Usage metering**              | How many / how long / aggregate cost pressure   | Analytics Engine + D1 `usage_rollups`     |
| **Sentry**                      | Platform defects operators should fix           | Sentry project                            |
| **Entity state columns/tables** | Current status (`last_run_*`, service liveness) | D1 entity rows / `package_service_states` |
| **Package subscriptions**       | Same-user reaction to terminal errors           | Best-effort dispatch after `finishRun`    |

After a successful terminal `finishRun` with `status: 'error'`,
`finishRunRecord` best-effort dispatches `run.error.recorded` to the owning
user’s packages that declare the topic (see
`packages/worker/src/run-records/package-subscriptions.ts` and
[Package subscriptions](../../guides/package-subscriptions.md)). Emission skips
`surface === 'subscription'` so a failing notifier cannot recurse. Discovery and
invocation infrastructure failures are warned, never thrown into the observed
run path. There is no Queue for this topic in v1.

**Usage metering** and run records are the aggregates/records pair: metering is
sampling-tolerant and quota-oriented; run records are user-facing history.
Successful key-less ad-hoc `execute` appears only in metering. Keyed execute
successes are retained as run records so timed-out clients can recover.

**Sentry** must not open issues for user-authored failures. Boundaries that know
the code is user-supplied throw `UserCodeError`
(`packages/worker/src/user-code-error.ts`). Sentry `beforeSend`
(`filterSentryEvent` in `packages/worker/src/sentry-options.ts`) drops events
when `isUserCodeError(hint.originalException)` — including nested causes.
String-match filters for bundler failures and sandbox timeouts remain only as
backstops for unmarked paths. Run records still store those failures for the
user.

**Entity state** stays on the entity. Jobs update `last_run_*` and counters;
package services heartbeat `package_service_states`. History browsers
(`/account/activity`, `run_list` / `run_get` / `run_summary`) read `RunLog`.

## Reading the data

- UI: `/account/activity` (failures-first by default; filters, 7-day summary,
  log viewer, cursor pagination). `/account/jobs` recent runs link into it.
- MCP domain `runs`: `run_list`, `run_get`, `run_summary`.
- Account export: section `run_records` pages through the user’s `RunLog`.
- Account deletion: `clearAll` on the user’s `RunLog` stub.

Run records are **excluded from the `storage_bytes` entitlement**. They are
observability history, not user content.

## Related

- [Usage metering](./usage-metering.md)
- [Data storage](./data-storage.md)
- [Entitlements](./entitlements.md)
- [Inbound webhooks](./webhooks.md)
- End-user: [Activity](../../use/activity.md)
