/**
 * The closed set of metered usage event types.
 *
 * Kept dependency-free (no `cloudflare:workers` import) so other universal
 * modules — most notably the feature-flag registry, which declares success
 * metrics against these types — can import it from the browser bundle.
 * The write path and event schema live in `record-usage.ts`.
 */

export const usageEventTypes = [
	'execute',
	'package_export',
	'package_static_call',
	'job_run',
	'workflow_run',
	'realtime_session',
	'outbound_fetch',
	'email_send',
	'email_received',
	'dynamic_worker_day',
	'durable_object_gb_seconds',
	'durable_object_rows_read',
] as const

export type UsageEventType = (typeof usageEventTypes)[number]

/**
 * High-volume observe-only metrics. They still roll up for admin drill-down
 * and monthly overage math (rows-read) but must not drive fleet event-count
 * rankings or entitlement-pressure candidate selection. Rows-read warnings
 * use a dedicated compute-include sweep, not this exclusion list. Duration
 * is never billed.
 */
export const observeOnlyUsageEventTypes = [
	'durable_object_gb_seconds',
	'durable_object_rows_read',
] as const satisfies ReadonlyArray<UsageEventType>

/**
 * Analytics Engine points that store a coalesced unit count in `double3`
 * instead of bytes. Hourly rollups sum that count (weighted by
 * `_sample_interval`) into `usage_rollups.event_count`.
 */
export const coalescedCountUsageEventTypes = [
	'durable_object_gb_seconds',
	'durable_object_rows_read',
] as const satisfies ReadonlyArray<UsageEventType>

export function isCoalescedCountUsageEventType(
	eventType: UsageEventType,
): eventType is (typeof coalescedCountUsageEventTypes)[number] {
	return (coalescedCountUsageEventTypes as ReadonlyArray<string>).includes(
		eventType,
	)
}
