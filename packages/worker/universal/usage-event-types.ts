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
] as const

export type UsageEventType = (typeof usageEventTypes)[number]

/**
 * High-volume observe-only metrics. They still roll up for admin drill-down
 * but must not drive fleet event-count rankings, entitlement-pressure
 * candidate selection, or customer usage emails.
 */
export const observeOnlyUsageEventTypes = [
	'durable_object_gb_seconds',
] as const satisfies ReadonlyArray<UsageEventType>
