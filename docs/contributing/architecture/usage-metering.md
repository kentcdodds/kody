# Usage metering

Kody records per-user usage events at runtime chokepoints so that cost
attribution, future quotas, and abuse detection can be built on real data. This
document describes the event schema, the `recordUsage()` helper contract, which
chokepoints are instrumented, and the recipe for instrumenting a new chokepoint.

Deliberately out of scope: quotas, plans, billing, enforcement, and admin
dashboards. Metering builds the data; policy is a separate effort that reads the
rollup table.

## Per-user isolation

Usage metering follows the repo-wide isolation invariant: every event carries a
required `userId`, the Analytics Engine index is the `userId`, and the D1 rollup
table is keyed by `user_id`. There is no cross-user read or write path.

## The event schema

One schema covers every chokepoint. It is defined in
`packages/worker/src/usage/record-usage.ts`:

```ts
type UsageEvent = {
	userId: string // required; owning user
	eventType: UsageEventType // see the metric table below
	entityId?: string | null // metered entity id when one exists
	durationMs?: number | null // wall-clock duration of the metered unit
	cpuMs?: number | null // CPU time, only when the platform exposes it
	bytes?: number | null // bytes moved/stored when meaningful
	outcome: 'success' | 'error'
	timestamp?: string // ISO 8601; defaults to time of recording
}
```

`eventType` is a closed union defined in the dependency-free
`packages/worker/src/usage/event-types.ts` (re-exported by `record-usage.ts`).
Add new members there (never ad hoc strings at call sites) so the set of metrics
stays reviewable in one place. The feature-flag registry declares flag success
metrics against this union, and the flag-exposure stream (`FLAG_EXPOSURES`
dataset, see [feature-flags.md](./feature-flags.md#success-metrics)) is joined
with these events for the admin on/off cohort readout.

### Metrics and their chokepoints

| `eventType`           | Metered unit                                                                      | Recorded at                                                                                                                                                                 | `entityId`                     |
| --------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `execute`             | one dynamic-worker sandbox evaluation                                             | `packages/worker/src/mcp/executor.ts` (`execute`)                                                                                                                           | none                           |
| `package_export`      | one saved-package bundled-code run                                                | `packages/worker/src/mcp/run-kody-registry.ts` (bundled runs with a package context)                                                                                        | package id                     |
| `package_static_call` | one call of a statically imported package export (function-valued, incl. default) | sandbox-side wrapper stamped by the bundler; validated and recorded host-side by `packages/worker/src/usage/package-static-call-usage.ts` (wired in `run-kody-registry.ts`) | callee package id              |
| `job_run`             | one job execution                                                                 | `packages/worker/src/jobs/service.ts` (`executeJobOnce`)                                                                                                                    | job id                         |
| `workflow_run`        | one Cloudflare Workflow run                                                       | `packages/worker/src/package-runtime/package-workflows.ts` (`DynamicCallableWorkflow.run`)                                                                                  | workflow instance id           |
| `service_runtime`     | one package service run (bounded or persistent)                                   | `packages/worker/src/package-runtime/package-service.ts` (run finalization)                                                                                                 | `{packageId}:{serviceName}`    |
| `realtime_session`    | one realtime websocket session                                                    | reserved — not yet instrumented                                                                                                                                             | session id                     |
| `outbound_fetch`      | one outbound fetch through the gateway                                            | `packages/worker/src/mcp/fetch-gateway.ts` (`KodyFetchGateway.fetch`)                                                                                                       | request host                   |
| `email_send`          | one outbound email send attempt                                                   | `packages/worker/src/email/outbound.ts` (`sendOutboundEmail`)                                                                                                               | email message id               |
| `email_received`      | one inbound receive attempt for a routed inbox                                    | `packages/worker/src/email/inbound.ts` (`handleInboundEmail`, after inbox resolution)                                                                                       | email message id (when stored) |

`email_received` covers receive attempts once an inbound message is routed to a
known, enabled inbox: stored messages record `success`; unverified-account
rejections, size rejections, entitlement rejections, and parse failures record
`error`. The `bytes` field always carries the raw message size, including for
rejected mail. Mail rejected before inbox resolution (unknown alias, disabled
inbox) has no owning user and is not metered.

### `package_static_call`: statically imported package export calls

Static imports (`import fn from 'kody:@scope/pkg/export'`) are the default way
package code is reused, so calls through them are metered per call:

- **Metered unit:** one call of a function-valued export (named or default) that
  was statically imported from a saved package. Non-function exports pass
  through unwrapped; imports that are never called record nothing. `userId` is
  the user the host run executes as, `entityId` is the **callee** package id,
  `durationMs` is the wall time of the call (through settlement for async
  functions), and `outcome` is `error` iff the call threw or rejected — the
  error still propagates to the caller unchanged.
- **Provenance is bundler stamping, never sandbox strings.** The import
  rewriter's proxy module (`ensurePackageProxy` in
  `packages/worker/src/package-runtime/module-graph-import-rewriting.ts`) knows
  which saved package a `kody:@…` specifier resolved to and bakes that id into
  the generated proxy (`createMeteredPackageImportProxySource`), which wraps
  function exports with `__kodyMeterStaticPackageExport` from the virtual
  runtime module — the same stamping discipline as per-package
  `packageStorage()` routing. Root self-imports are not stamped (the run already
  records `package_export` for that package).
- **Host-side validation (trust model, stated honestly):** stamped ids ride in
  generated code, but that code still executes inside the sandbox realm, so a
  malicious module could forge reports. The host
  (`createPackageStaticCallMeterTools` in
  `packages/worker/src/usage/package-static-call-usage.ts`) only records events
  whose stamped id is in the bundle's **static** dependency package ids recorded
  at build time (`bundle.dependencies`) — a strict subset of the
  `packageStorage()` grant set, which additionally grants the run's own package
  id and dynamic-import dependencies, neither of which the bundler ever stamps
  into a metered proxy — and silently drops the rest with a debug log. Forgery
  can therefore at worst inflate counts for packages the bundle already
  statically depends on.
- **Delivery never blocks the call path.** Each call does one synchronous buffer
  push (capped at 200 events per run — Analytics Engine allows 250
  `writeDataPoint` calls per invocation, one per event, and the run's other
  usage events need headroom; overflow is dropped and the cap is enforced
  host-side too); the run wrapper in `runBundledModuleWithRegistry` flushes the
  buffer over a runtime bridge in batches at the end of the run, while the
  sandbox RPC dispatchers are still live — a fire-and-forget RPC per call would
  race dispatcher teardown and lose events. The awaited flush is bounded by a
  short timeout so a slow bridge never owns the run's tail latency, and it loops
  (bounded) so async calls that settle during an in-flight flush are still
  delivered; calls that have **not settled when the run's entrypoint finishes**
  (a promise the run never awaited) are not metered — metering never extends a
  run's lifetime, and such a dangling promise may never settle inside the
  sandbox at all. Flush failures are swallowed.
- **Coverage:** every surface that funnels through
  `runBundledModuleWithRegistry` (ad hoc execute with static `kody:@…` imports,
  saved-package invocations, and the job/workflow/service runs built on them).
  Package-app fetch handlers use a separate runtime bridge and do not bind the
  meter yet; the wrapper silently no-ops there.
- **Capacity note:** the 200-events-per-run cap shares the ~250
  `writeDataPoint`-per-invocation Analytics Engine budget with every other usage
  event in the same invocation — in particular `outbound_fetch`, which also
  scales per operation. A heavy run (many static calls **and** many gateway
  fetches) can exceed the budget and Analytics Engine silently drops the
  overflow points. The eventual fix is aggregation (coalescing per-callee
  counts/durations into fewer data points), not raising the cap.

### Nesting: metrics are independent, do not sum across types

Execution surfaces nest. A job run funnels through the bundled-module runner and
the sandbox executor, so a single package job produces one `job_run`, one
`package_export`, and one `execute` event, each measuring its own layer.
Likewise, a bundled run that calls statically imported package exports produces
one `package_static_call` event per call **inside** the run's own
`execute`/`package_export` span. This is intentional: each metric answers its
own question (`execute` is total sandbox pressure; `job_run` is job activity;
`package_static_call` is per-callee reuse). Never add durations across different
`eventType` values — that double counts nested layers. Within one `eventType`,
each chokepoint records exactly one event per metered unit, so sums are safe.

## Sinks

`recordUsage()` picks its sink by environment:

1. **Workers Analytics Engine is the write path in production and preview**
   (`USAGE_EVENTS` dataset binding, configured for the `production` and
   `preview` environments in `packages/worker/wrangler.jsonc`). When the binding
   is present, each event is one non-blocking `writeDataPoint` call and nothing
   else — a per-event D1 upsert would serialize every metered request (execute,
   fetch, email, jobs, ...) on D1's single writer. Data point layout:
   - `indexes`: `[userId]`
   - `blobs`: `[userId, eventType, entityId ?? '', outcome, timestamp]`
   - `doubles`: `[durationMs ?? 0, cpuMs ?? 0, bytes ?? 0]`

   Analytics Engine is the analysis store (sampling-tolerant, high cardinality).
   Do not build enforcement on it.

2. **D1 `usage_rollups` is a derived aggregate** (migration
   `packages/worker/migrations/0047-usage-rollups.sql`): per-user, per-metric,
   per-month counters:
   - key: `(user_id, metric, month)` where `metric` is the `eventType` and
     `month` is the UTC `YYYY-MM` prefix of the event timestamp
   - counters: `event_count`, `error_count`, `total_duration_ms`,
     `total_cpu_ms`, `total_bytes`

   In production/preview the rows are recomputed hourly by
   `aggregateUsageRollups` in `packages/worker/src/usage/aggregate-rollups.ts`
   (gated by `shouldRunUsageAggregationCron` in the scheduled handler): it
   queries the Analytics Engine SQL API for the current UTC month grouped by
   user and metric (weighting by `_sample_interval`, since Analytics Engine
   samples under load) and batch-upserts absolute values — an idempotent
   recompute, not increments. Analytics Engine retention (~90 days) always
   covers a full month, so month-to-date recompute is complete; prior months
   already in D1 stay untouched. The aggregation needs `CLOUDFLARE_ACCOUNT_ID`
   and `CLOUDFLARE_API_TOKEN` and no-ops with a debug log when either (or the
   `USAGE_EVENTS` binding) is missing.

   **Local-dev direct fallback:** when `USAGE_EVENTS` is absent (local dev,
   tests), `recordUsage` upserts `usage_rollups` directly per event, so local
   admin pages and workers-unit tests work without Analytics Engine access.

   The rollup is the cheap read path a future quota/entitlements layer will
   consume: one point lookup per user, metric, and month.

## Agent package popularity (MCP instructions hint)

Separate from `usage_rollups`, D1 table `agent_package_conversation_uses`
(migration `0073-agent-package-conversation-uses.sql`) tracks **distinct
conversations** in which a signed-in user’s agents used a saved package via MCP
`execute` (`packages.invoke*` with execute provenance, plus static/dynamic
`kody:@…` deps attributed to that execute call’s `conversationId`).

- Key: `(user_id, package_id, conversation_id)` — upsert updates `last_used_at`;
  the same package in the same conversation counts once. Stored
  `conversation_id` values are SHA-256 hex digests of the MCP conversation id
  (cardinality only; not reversible to the raw id).
- Read path: take the user’s last **N** distinct agent conversations
  (default 40) with `last_used_at` within a hard max age (default 180 days),
  count how many of those conversations used each package (package rows must
  also be within max age), join `saved_packages` for `kody_id` + description,
  top 8 name bullets for `buildMcpServerInstructions`. Cold start (no rows)
  omits the section. List failures (missing table, transient D1 errors) return
  `[]` so MCP init stays up.
- Writes are best-effort and never throw into the invoke path (same spirit as
  `recordUsage`). Do **not** widen `usage_rollups` for conversation cardinality.

Helpers live in `packages/worker/src/usage/agent-package-conversation-uses.ts`.

## Helper contract

```ts
import { recordUsage } from '#worker/usage/record-usage.ts'

await recordUsage(env, {
	userId,
	eventType: 'job_run',
	entityId: job.id,
	durationMs,
	outcome: execution.ok ? 'success' : 'error',
})
```

Guarantees and rules:

- `recordUsage` **never throws and never rejects.** Metering must not break the
  path it observes. Sink failures are logged at warn level; expected local-dev
  degradation is logged at debug level.
- Every recorded event also emits a `kody.usage.{eventType}` **trace span**
  (when Workers tracing is available) with `kody.user_id`, `kody.event_type`,
  `kody.outcome`, and the optional `kody.entity_id` / `kody.duration_ms` /
  `kody.bytes` attributes. It nests under the active platform span, so traces
  become searchable by user and feature with no chokepoint changes. Span
  emission follows the same never-throws contract.
- It accepts any object with optional `USAGE_EVENTS` / `APP_DB` bindings
  (`UsageEnv`), so the full `Env` can be passed directly.
- **Graceful degradation:** in local dev and tests where the Analytics Engine
  binding is not present, the event is logged via `console.debug` and upserted
  into `usage_rollups` directly; when `APP_DB` is missing (or the table does not
  exist), the rollup write is skipped with a debug log.
- If `userId` is empty, the event is skipped entirely. Callers on paths that can
  run without a user (for example anonymous gateway fetches) must guard with
  `if (userId)` and not invent placeholder ids.
- The returned promise resolves quickly (one `writeDataPoint`, or one D1 upsert
  in local dev). `await` it inline, or pass it to `ctx.waitUntil(...)` inside
  Durable Objects when the caller must not block.

## Recipe: instrumenting a new chokepoint

1. **Pick the metered unit.** One event per semantic unit (one run, one fetch,
   one send). If your chokepoint already funnels through an instrumented layer,
   that is fine — you are adding a new metric, not replacing one — but never
   record the same `eventType` twice for one unit.
2. **Add the `eventType`** to the `UsageEventType` union in
   `packages/worker/src/usage/record-usage.ts` if it does not exist, and add a
   row to the metric table in this document.
3. **Find the narrowest span** where you have all of: the `userId`, the entity
   id, the start time, and the outcome. Wrap it:

   ```ts
   const startedAtMs = Date.now()
   let outcome: 'success' | 'error' = 'success'
   try {
   	// existing work
   } catch (error) {
   	outcome = 'error'
   	throw error
   } finally {
   	if (userId) {
   		await recordUsage(env, {
   			userId,
   			eventType: 'my_metric',
   			entityId,
   			durationMs: Date.now() - startedAtMs,
   			outcome,
   		})
   	}
   }
   ```

   A result object that carries an `error` field (like `ExecuteResult`) counts
   as `outcome: 'error'` even when nothing throws.

4. **Populate optional fields when cheap.** `bytes` for transfer-shaped metrics,
   `cpuMs` only when the platform exposes it. Leave fields you cannot measure as
   `undefined` — do not approximate.
5. **Do not change behavior.** No new throws, no altered return values, no added
   latency beyond the awaited write (use `ctx.waitUntil` in DOs if needed).
6. **Test it.** Pick the flavor with the
   [test flavor decision matrix](../testing-principles.md#test-flavor-decision-matrix).
   In `*.node.test.ts`, spy on the helper:

   ```ts
   const usageModule = await import('#worker/usage/record-usage.ts')
   const recordUsageSpy = vi
   	.spyOn(usageModule, 'recordUsage')
   	.mockResolvedValue(undefined)
   ```

   Assert one call per metered unit with the expected `userId`, `eventType`,
   `entityId`, and `outcome` for both a success and a failure path, then
   `recordUsageSpy.mockRestore()`. The exemplar is the usage test in
   `packages/worker/src/mcp/executor.node.test.ts`. For `*.workers.test.ts`
   suites with a real local D1, create the table with
   `ensureUsageRollupsTestSchema` from
   `packages/worker/src/usage/test-schema.ts` and assert on `usage_rollups` rows
   instead.

## Reading the data

- Analytics Engine: query the `kody_usage_events` dataset (SQL API) filtered by
  the `index1` user id; blob/double positions are listed above. Remember that
  Analytics Engine samples: count with `sum(_sample_interval)` and sum values
  with `sum(doubleN * _sample_interval)`.
- D1: `SELECT * FROM usage_rollups WHERE user_id = ?1 AND month = ?2` gives
  every metric for a user's month in one small scan.
- Admin usage drill-down (on the admin users page):
  `packages/worker/src/admin/user-usage-data.ts` caches its per-user rollup read
  model for ~5 minutes in `BUNDLE_ARTIFACTS_KV` via the `@epic-web/cachified`
  adapter in `packages/worker/src/kv-cachified.ts` (key prefix
  `derived-cache:v1:`), keyed by user id + current month, falling through to
  direct D1 queries when KV is unavailable. Usage is loaded for one selected
  account at a time, so admin reads stay O(1) per view as the user base grows.
