/**
 * Per-user usage metering.
 *
 * One event schema covers every metered chokepoint (execute runs, package
 * export invocations, job runs, workflow runs, package service runtime,
 * realtime websocket sessions, gateway fetches, email sends). Events are
 * written to two sinks:
 *
 * - Workers Analytics Engine (`USAGE_EVENTS`) for high-cardinality analysis.
 * - The D1 `usage_rollups` table (per-user, per-metric, per-month counters)
 *   which future quota enforcement can read cheaply.
 *
 * `recordUsage` never throws and never rejects; metering must not break the
 * paths it observes. In local dev and tests where a binding is missing it
 * degrades to a debug log. See
 * `docs/contributing/architecture/usage-metering.md`.
 */

export type UsageEventType =
	| 'execute'
	| 'package_export'
	| 'job_run'
	| 'workflow_run'
	| 'service_runtime'
	| 'realtime_session'
	| 'outbound_fetch'
	| 'email_send'

export type UsageOutcome = 'success' | 'error'

export type UsageEvent = {
	/** Owning user. Required: every usage event is scoped to one user. */
	userId: string
	eventType: UsageEventType
	/**
	 * Identifier of the metered entity when one exists (package id, job id,
	 * workflow run id, service instance name, email message id, fetch host).
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

/**
 * Record one usage event to Analytics Engine and the D1 rollup table.
 *
 * Guarantees:
 * - Never throws and never rejects: failures are logged at debug level.
 * - Each sink degrades independently when its binding is unavailable.
 *
 * Callers should `await` it (cheap: one `writeDataPoint` plus one D1 upsert)
 * or hand the promise to `ctx.waitUntil(...)` inside Durable Objects.
 */
export async function recordUsage(
	env: UsageEnv,
	event: UsageEvent,
): Promise<void> {
	try {
		if (!event.userId) {
			console.debug('usage-event-skipped', 'missing userId', event.eventType)
			return
		}
		const timestamp = event.timestamp ?? new Date().toISOString()
		writeUsageDataPoint(env, event, timestamp)
		await writeUsageRollup(env, event, timestamp)
	} catch (error) {
		console.warn('usage-event-record-failed', error)
	}
}

function writeUsageDataPoint(
	env: UsageEnv,
	event: UsageEvent,
	timestamp: string,
) {
	if (!env.USAGE_EVENTS) {
		console.debug('usage-event-local', JSON.stringify({ ...event, timestamp }))
		return
	}
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
