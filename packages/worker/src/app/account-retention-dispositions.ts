export type AccountRetentionDisposition =
	| { table: string; kind: 'scheduled_policy' }
	| { table: string; kind: 'alternate_cleanup'; reason: string }
	| { table: string; kind: 'durable_forever'; reason: string }

export const accountRetentionDispositions: ReadonlyArray<AccountRetentionDisposition> =
	[
		{ table: 'package_invocations', kind: 'scheduled_policy' },
		{
			table: 'mcp_memory_conversation_suppressions',
			kind: 'scheduled_policy',
		},
		{ table: 'workflow_runs', kind: 'scheduled_policy' },
		{ table: 'platform_feedback', kind: 'scheduled_policy' },
		{ table: 'published_bundle_artifacts', kind: 'scheduled_policy' },
		{ table: 'email_delivery_events', kind: 'scheduled_policy' },
		{ table: 'email_messages', kind: 'scheduled_policy' },
		{ table: 'email_attachments', kind: 'scheduled_policy' },
		{ table: 'email_threads', kind: 'scheduled_policy' },
		{ table: 'entitlement_daily_counters', kind: 'scheduled_policy' },
		{ table: 'usage_rollups', kind: 'scheduled_policy' },
		{ table: 'audit_events', kind: 'scheduled_policy' },
		{ table: 'stripe_webhook_events', kind: 'scheduled_policy' },
		{
			table: 'archived_job_artifacts',
			kind: 'alternate_cleanup',
			reason:
				'Archived job artifact rows are bounded by retain_until and cleaned by the job artifact cleanup path.',
		},
		{
			table: 'mcp_memories',
			kind: 'durable_forever',
			reason:
				'Memories are durable user-curated content removed by explicit user action or account deletion, not by time-based retention.',
		},
		{
			table: 'user_package_run_successes',
			kind: 'durable_forever',
			reason:
				'Per-package activation success counters must outlive retention-pruned run history; they are removed only by account deletion.',
		},
		{
			table: 'user_storage_buckets',
			kind: 'durable_forever',
			reason:
				'Per-user durable storage bucket ownership is current state for backup, export, and deletion enumeration; it is removed only by account deletion.',
		},
	] as const

export function getAccountRetentionDispositionCoverage(): Set<string> {
	return new Set(
		accountRetentionDispositions.map((disposition) => disposition.table),
	)
}
