/**
 * The closed set of metered usage event types.
 *
 * Kept dependency-free (no `cloudflare:workers` import) so client-safe
 * modules — most notably the feature-flag registry, which declares success
 * metrics against these types — can import it under the client tsconfig.
 * The write path and event schema live in `record-usage.ts`.
 */

export const usageEventTypes = [
	'execute',
	'package_export',
	'package_static_call',
	'job_run',
	'workflow_run',
	'service_runtime',
	'realtime_session',
	'outbound_fetch',
	'email_send',
	'email_received',
] as const

export type UsageEventType = (typeof usageEventTypes)[number]
