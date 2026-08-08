import { type EntitlementResource } from '#universal/plans.ts'

export type EntitlementResourceGroup = 'daily' | 'counts' | 'storage' | 'limits'

export type EntitlementResourceVisibilityKind = 'counter' | 'per_unit_max'

export const entitlementResourceGroupLabels: Record<
	EntitlementResourceGroup,
	string
> = {
	daily: 'Daily rates',
	counts: 'Resource counts',
	storage: 'Storage',
	limits: 'Per-item limits',
}

export const entitlementResourceGroupNotes: Partial<
	Record<EntitlementResourceGroup, string>
> = {
	daily: 'Counters reset at UTC midnight.',
}

export type EntitlementResourceVisibility = {
	group: EntitlementResourceGroup
	kind: EntitlementResourceVisibilityKind
	whatCounts: string
	howToReduce: string
}

/**
 * Plain-language copy for account usage UI and the `usage_get` capability.
 * Keep factual and terse; update when enforcement semantics change.
 */
export const entitlementResourceVisibility: Record<
	EntitlementResource,
	EntitlementResourceVisibility
> = {
	repos: {
		group: 'counts',
		kind: 'counter',
		whatCounts: 'Plain repos you created for package and agent work.',
		howToReduce: 'Delete repos you no longer need.',
	},
	saved_packages: {
		group: 'counts',
		kind: 'counter',
		whatCounts: 'Saved packages published to your account.',
		howToReduce: 'Remove packages you no longer use.',
	},
	scheduled_jobs: {
		group: 'counts',
		kind: 'counter',
		whatCounts: 'Scheduled jobs waiting to run on a schedule.',
		howToReduce: 'Delete jobs you no longer need.',
	},
	package_services: {
		group: 'counts',
		kind: 'counter',
		whatCounts: 'Package services currently running.',
		howToReduce: 'Stop services you are not using.',
	},
	persistent_package_services: {
		group: 'counts',
		kind: 'counter',
		whatCounts: 'Persistent (long-lived) package services currently running.',
		howToReduce:
			'Stop persistent services you do not need, or upgrade for more concurrent slots.',
	},
	repo_sessions: {
		group: 'counts',
		kind: 'counter',
		whatCounts: 'Active editing sessions opened by agents against your repos.',
		howToReduce:
			'Discard finished sessions with repo_discard_session; idle sessions are cleaned up automatically after 7 days.',
	},
	email_sends_per_day: {
		group: 'daily',
		kind: 'counter',
		whatCounts: 'Outbound email send attempts today (UTC).',
		howToReduce: 'Send fewer messages today, or upgrade your plan.',
	},
	email_receives_per_day: {
		group: 'daily',
		kind: 'counter',
		whatCounts: 'Inbound email messages accepted for storage today (UTC).',
		howToReduce:
			'Reduce inbound volume (filters, fewer public addresses), or upgrade your plan.',
	},
	stored_email_messages: {
		group: 'counts',
		kind: 'counter',
		whatCounts: 'Email messages stored in your mailboxes.',
		howToReduce: 'Delete old messages you no longer need.',
	},
	email_message_bytes: {
		group: 'limits',
		kind: 'per_unit_max',
		whatCounts:
			'Maximum raw MIME size allowed for a single stored email message.',
		howToReduce:
			'Keep attachments and bodies smaller, or upgrade for a higher per-message cap.',
	},
	secrets: {
		group: 'counts',
		kind: 'counter',
		whatCounts: 'Secret entries in non-expired secret buckets.',
		howToReduce: 'Delete secrets you no longer need.',
	},
	storage_bytes: {
		group: 'storage',
		kind: 'counter',
		whatCounts:
			'Durable payload bytes across D1-backed data plus inventoried package, job, execute, service, and repo-session storage buckets.',
		howToReduce: 'Delete stored content you no longer need.',
	},
	concurrent_workflows: {
		group: 'counts',
		kind: 'counter',
		whatCounts: 'Workflow runs currently active on your account.',
		howToReduce:
			'Wait for workflows to finish or cancel runs you no longer need.',
	},
	execute_calls_per_day: {
		group: 'daily',
		kind: 'counter',
		whatCounts: 'MCP execute tool runs today (UTC), including failed attempts.',
		howToReduce: 'Run fewer execute calls today, or upgrade your plan.',
	},
	outbound_fetches_per_day: {
		group: 'daily',
		kind: 'counter',
		whatCounts:
			'Sandbox outbound HTTP fetches through the fetch gateway today (UTC).',
		howToReduce: 'Fetch less from user code today, or upgrade your plan.',
	},
}

/** All entitlement resources in display order (grouped). */
export const accountUsageEntitlementResources = [
	'email_sends_per_day',
	'email_receives_per_day',
	'execute_calls_per_day',
	'outbound_fetches_per_day',
	'repos',
	'saved_packages',
	'scheduled_jobs',
	'package_services',
	'persistent_package_services',
	'repo_sessions',
	'stored_email_messages',
	'secrets',
	'concurrent_workflows',
	'storage_bytes',
	'email_message_bytes',
] as const satisfies ReadonlyArray<EntitlementResource>

export const entitlementResourceGroupOrder: Array<EntitlementResourceGroup> = [
	'daily',
	'counts',
	'storage',
	'limits',
]
