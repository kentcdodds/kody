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
		nonScheduled.some(
			(disposition) =>
				disposition.table === 'archived_job_artifacts' &&
				disposition.kind === 'alternate_cleanup',
		),
	).toBe(true)
	expect(
		nonScheduled.some(
			(disposition) =>
				disposition.table === 'jobs' &&
				disposition.kind === 'alternate_cleanup',
		),
	).toBe(true)
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
				disposition.table === 'user_package_run_successes' &&
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
	// The schema-growth heuristic in retention.node.test.ts remains the broader
	// guardrail for discovering new growth-pattern tables.
	expect(getRetentionPolicyCoverage().has('mcp_memories')).toBe(true)
})
