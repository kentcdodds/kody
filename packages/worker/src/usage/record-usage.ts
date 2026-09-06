/**
 * Per-user usage metering.
 *
 * One event schema covers every metered chokepoint (execute runs, package
 * export invocations, statically imported package export calls, job runs,
 * workflow runs, realtime websocket sessions, gateway fetches, email sends and
 * receives, unique Dynamic Worker days, and observe-only Durable Object
 * duration).
 *
 * The write path depends on the environment:
 *
 * - When the Workers Analytics Engine binding (`USAGE_EVENTS`) is present
 *   (production/preview), the event is written **only** to Analytics Engine.
 *   The D1 `usage_rollups` table is then a derived aggregate, recomputed
 *   hourly from Analytics Engine by
 *   `packages/worker/src/usage/aggregate-rollups.ts` — a per-event D1 upsert
 *   would serialize every metered request on D1's single writer.
 * - When `USAGE_EVENTS` is absent (local dev, tests), the event is upserted
 *   directly into `usage_rollups` so local admin pages and tests work without
 *   Analytics Engine access. `execute` events also increment today's
 *   `fleet_execute_days` row for the homepage ticker. `execute` events also increment today's
 *   `fleet_execute_days` row for the homepage ticker.
 *
 * `recordUsage` never throws and never rejects; metering must not break the
 * paths it observes. In local dev and tests where a binding is missing it
 * degrades to a debug log. See
 * `docs/contributing/architecture/usage-metering.md`.
 *
 * Every recorded event also emits a `kody.usage.{eventType}` trace span (when
 * Workers tracing is available) carrying the user id, entity id, and outcome
 * as attributes. The chokepoints that meter usage are exactly the app-level
 * units worth finding in traces, so this one funnel makes every trace
 * searchable by user and feature without touching the chokepoints themselves.
 */

import * as cloudflareWorkers from 'cloudflare:workers'
import { type UsageEventType } from '#universal/usage-event-types.ts'
import { stampFirstExecute } from '#worker/identity/activation-stamps.ts'

export {
	usageEventTypes,
	type UsageEventType,
} from '#universal/usage-event-types.ts'

// Older local runtimes (and the node test stub) may not expose `tracing`;
// treat it as optional so metering keeps its never-throws contract.
const runtimeTracing: typeof cloudflareWorkers.tracing | undefined = (
	cloudflareWorkers as Partial<typeof cloudflareWorkers>
).tracing

export type UsageOutcome = 'success' | 'error'

export type UsageEvent = {
	/** Owning user. Required: every usage event is scoped to one user. */
	userId: string
	eventType: UsageEventType
	/**
	 * Identifier of the metered entity when one exists (package id, job id,
	 * workflow run id, email message id, fetch host).
	 */
	entityId?: string | null
	/** Wall-clock duration of the metered unit, in milliseconds. */
	durationMs?: number | null
	/** CPU time in milliseconds, only when the platform exposes it. */
	cpuMs?: number | null
	/** Bytes transferred/stored when meaningful (fetch bodies, email size). */
	bytes?: number | null
	outcome: UsageOutcome
	/** ISO 8601 timestamp. Defaults to the time of recording. */
	timestamp?: string
}

export type UsageEnv = {
	USAGE_EVENTS?: AnalyticsEngineDataset
	APP_DB?: D1Database
}

const usageRollupUpsertStatement = `
INSERT INTO usage_rollups (
	user_id, metric, month,
	event_count, error_count,
	total_duration_ms, total_cpu_ms, total_bytes,
	updated_at
) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT (user_id, metric, month) DO UPDATE SET
	event_count = event_count + 1,
	error_count = error_count + excluded.error_count,
	total_duration_ms = total_duration_ms + excluded.total_duration_ms,
	total_cpu_ms = total_cpu_ms + excluded.total_cpu_ms,
	total_bytes = total_bytes + excluded.total_bytes,
	updated_at = excluded.updated_at
`.trim()

const fleetExecuteDayUpsertStatement = `
INSERT INTO fleet_execute_days (day, event_count, updated_at)
VALUES (?1, 1, ?2)
ON CONFLICT (day) DO UPDATE SET
	event_count = event_count + 1,
	updated_at = excluded.updated_at
`.trim()

/**
 * Record one usage event.
 *
 * With `USAGE_EVENTS` bound this is a single non-blocking `writeDataPoint`
 * call; the D1 rollup is derived later by the hourly aggregation cron.
 * Without it (local dev, tests) the event is upserted into `usage_rollups`
 * directly.
 *
 * Guarantees:
 * - Never throws and never rejects: failures are logged at debug level.
 * - Each sink degrades independently when its binding is unavailable.
 *
 * Callers should `await` it (cheap: one `writeDataPoint`, or one D1 upsert in
 * local dev) or hand the promise to `ctx.waitUntil(...)` inside Durable
 * Objects. Successful `execute` events still stamp `users.first_execute_at`;
 * pass `waitUntil` to keep that D1 write off the critical path.
 */
export async function recordUsage(
	env: UsageEnv,
	event: UsageEvent,
	options?: { waitUntil?: (promise: Promise<unknown>) => void },
): Promise<void> {
	try {
		if (!event.userId) {
			console.debug('usage-event-skipped', 'missing userId', event.eventType)
			return
		}
		emitUsageSpan(event)
		const timestamp = event.timestamp ?? new Date().toISOString()
		if (
			event.eventType === 'execute' &&
			event.outcome === 'success' &&
			env.APP_DB
		) {
			const stamp = stampFirstExecute(env.APP_DB, {
				stableUserId: event.userId,
				at: timestamp,
			}).catch((error: unknown) => {
				console.warn('activation-stamp-execute-failed', error)
			})
			if (options?.waitUntil) {
				options.waitUntil(stamp)
			} else {
				await stamp
			}
		}
		if (env.USAGE_EVENTS) {
			writeUsageDataPoint(env, event, timestamp)
			return
		}
		console.debug('usage-event-local', JSON.stringify({ ...event, timestamp }))
		await writeUsageRollup(env, event, timestamp)
		await writeLocalFleetExecuteDay(env, event, timestamp)
	} catch (error) {
		console.warn('usage-event-record-failed', error)
	}
}

/**
 * Emit a marker span for one usage event, nested under whatever platform span
 * is active in the current async context (HTTP handler, DO invocation, ...).
 * When the invocation is not sampled, `enterSpan` still runs the callback but
 * records nothing.
 */
function emitUsageSpan(event: UsageEvent) {
	if (!runtimeTracing?.enterSpan) return
	try {
		runtimeTracing.enterSpan(`kody.usage.${event.eventType}`, (span) => {
			span.setAttribute('kody.user_id', event.userId)
			span.setAttribute('kody.event_type', event.eventType)
			span.setAttribute('kody.outcome', event.outcome)
			if (event.entityId) span.setAttribute('kody.entity_id', event.entityId)
			if (event.durationMs != null) {
				span.setAttribute('kody.duration_ms', event.durationMs)
			}
			if (event.bytes != null) span.setAttribute('kody.bytes', event.bytes)
		})
	} catch (error) {
		console.debug('usage-span-failed', error)
	}
}

function writeUsageDataPoint(
	env: UsageEnv,
	event: UsageEvent,
	timestamp: string,
) {
	if (!env.USAGE_EVENTS) return
	try {
		env.USAGE_EVENTS.writeDataPoint({
			indexes: [event.userId],
			blobs: [
				event.userId,
				event.eventType,
				event.entityId ?? '',
				event.outcome,
				timestamp,
			],
			doubles: [event.durationMs ?? 0, event.cpuMs ?? 0, event.bytes ?? 0],
		})
	} catch (error) {
		console.warn('usage-event-analytics-failed', error)
	}
}

async function writeUsageRollup(
	env: UsageEnv,
	event: UsageEvent,
	timestamp: string,
) {
	if (!env.APP_DB) {
		console.debug('usage-rollup-skipped', 'missing APP_DB binding')
		return
	}
	try {
		await env.APP_DB.prepare(usageRollupUpsertStatement)
			.bind(
				event.userId,
				event.eventType,
				timestamp.slice(0, 7),
				event.outcome === 'error' ? 1 : 0,
				Math.round(event.durationMs ?? 0),
				Math.round(event.cpuMs ?? 0),
				Math.round(event.bytes ?? 0),
				timestamp,
			)
			.run()
	} catch (error) {
		console.warn('usage-rollup-failed', error)
	}
}

async function writeLocalFleetExecuteDay(
	env: UsageEnv,
	event: UsageEvent,
	timestamp: string,
) {
	if (event.eventType !== 'execute') return
	if (!env.APP_DB) return
	try {
		await env.APP_DB.prepare(fleetExecuteDayUpsertStatement)
			.bind(timestamp.slice(0, 10), timestamp)
			.run()
	} catch (error) {
		console.warn('usage-fleet-execute-day-failed', error)
	}
}
