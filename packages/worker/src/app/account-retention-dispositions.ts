export type AccountRetentionDisposition =
	| { table: string; kind: 'scheduled_policy' }
	| { table: string; kind: 'alternate_cleanup'; reason: string }
	| { table: string; kind: 'durable_forever'; reason: string }

export const accountRetentionDispositions: ReadonlyArray<AccountRetentionDisposition> =
	[
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
		{ table: 'usage_rollups', kind: 'scheduled_policy' },
		{ table: 'feature_flag_exposure_rollups', kind: 'scheduled_policy' },
		{ table: 'stripe_webhook_events', kind: 'scheduled_policy' },
		{
			table: 'archived_job_artifacts',
			kind: 'alternate_cleanup',
			reason:
				'Archived job artifact rows are bounded by retain_until and cleaned by the job artifact cleanup path.',
		},
		{
			table: 'jobs',
			kind: 'alternate_cleanup',
			reason:
				'Ad-hoc jobs are cleaned by the hourly job_retention sweeper using account/platform retention windows; package-owned and preserved jobs are durable until explicit delete, package sync, or account deletion.',
		},
		{
			table: 'system_email_delivery_events',
			kind: 'alternate_cleanup',
			reason:
				'Operator-owned D1 delivery events are excluded from account retention; step 4b will route the existing 90-day system-email retention policy to this dedicated table.',
		},
		{
			table: 'system_email_messages',
			kind: 'alternate_cleanup',
			reason:
				'Operator-owned D1 messages are excluded from account retention; step 4b will route the existing 90-day age and 5,000-message system cap to this dedicated table.',
		},
		{
			table: 'system_email_attachments',
			kind: 'alternate_cleanup',
			reason:
				'Operator-owned D1 attachment metadata follows dedicated system messages; step 4b will delete it through the routed system-email retention path.',
		},
		{
			table: 'system_email_threads',
			kind: 'alternate_cleanup',
			reason:
				'Operator-owned D1 threads are pruned when orphaned by dedicated system-message retention; routing begins in step 4b.',
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
