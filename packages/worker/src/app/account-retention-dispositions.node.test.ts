import { expect, test } from 'vitest'
import {
	accountRetentionDispositions,
	getAccountRetentionDispositionCoverage,
} from './account-retention-dispositions.ts'
import {
	getRetentionPolicyCoverage,
	retentionPolicies,
	retentionPolicyExemptions,
} from './retention.ts'

test('retention dispositions stay aligned with scheduled policies and documented exemptions', () => {
	expect([...getAccountRetentionDispositionCoverage()].sort()).toEqual(
		[...getRetentionPolicyCoverage()].sort(),
	)

	const policyTables = new Set(retentionPolicies.map((policy) => policy.table))
	const scheduledTables = accountRetentionDispositions
		.filter((disposition) => disposition.kind === 'scheduled_policy')
		.map((disposition) => disposition.table)
	expect(scheduledTables.sort()).toEqual([...policyTables].sort())

	const exemptionTables = new Set(
		retentionPolicyExemptions.map((exemption) => exemption.table),
	)
	const nonScheduled = accountRetentionDispositions.filter(
		(disposition) => disposition.kind !== 'scheduled_policy',
	)
	expect(nonScheduled.map((disposition) => disposition.table).sort()).toEqual(
		[...exemptionTables].sort(),
	)
	expect(
		nonScheduled
			.filter((disposition) => disposition.table.startsWith('system_email_'))
			.map((disposition) => disposition.table)
			.sort(),
	).toEqual([
		'system_email_attachments',
		'system_email_delivery_events',
		'system_email_messages',
		'system_email_threads',
	])
	expect(
		nonScheduled
			.filter((disposition) => disposition.table.startsWith('system_email_'))
			.every((disposition) => disposition.kind === 'alternate_cleanup'),
	).toBe(true)
	expect(
		nonScheduled
			.filter((disposition) => disposition.table.startsWith('system_email_'))
			.every(
				(disposition) =>
					disposition.kind === 'alternate_cleanup' &&
					disposition.reason.includes('dedicated'),
			),
	).toBe(true)
	expect(
		nonScheduled.some(
			(disposition) => disposition.table === 'entitlement_daily_counters',
		),
	).toBe(false)
	expect(getRetentionPolicyCoverage().has('entitlement_daily_counters')).toBe(
		false,
	)
	expect(
		nonScheduled.some(
			(disposition) =>
				disposition.table === 'mcp_memories' &&
				disposition.kind === 'durable_forever',
		),
	).toBe(true)
	expect(
		nonScheduled.some(
			(disposition) =>
				disposition.table === 'user_storage_buckets' &&
				disposition.kind === 'durable_forever',
		),
	).toBe(true)
	expect(
		nonScheduled.some((disposition) => disposition.table === 'workflow_runs'),
	).toBe(false)
	expect(
		nonScheduled.some(
			(disposition) => disposition.table === 'user_package_run_successes',
		),
	).toBe(false)
	// The schema-growth heuristic in retention.node.test.ts remains the broader
	// guardrail for discovering new growth-pattern tables.
	expect(getRetentionPolicyCoverage().has('mcp_memories')).toBe(true)
})
