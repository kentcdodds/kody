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

test('account retention disposition coverage matches retention policy coverage', () => {
	expect([...getAccountRetentionDispositionCoverage()].sort()).toEqual(
		[...getRetentionPolicyCoverage()].sort(),
	)
})

test('every scheduled retention disposition is backed by retentionPolicies', () => {
	const policyTables = new Set(retentionPolicies.map((policy) => policy.table))
	const scheduledTables = accountRetentionDispositions
		.filter((disposition) => disposition.kind === 'scheduled_policy')
		.map((disposition) => disposition.table)
	expect(scheduledTables.sort()).toEqual([...policyTables].sort())
	for (const table of scheduledTables) {
		expect(
			policyTables.has(table),
			`missing retention policy for ${table}`,
		).toBe(true)
	}
})

test('non-scheduled retention dispositions are documented exemptions', () => {
	const exemptions = new Map(
		retentionPolicyExemptions.map((exemption) => [
			exemption.table,
			exemption.reason,
		]),
	)
	const nonScheduled = accountRetentionDispositions.filter(
		(disposition) => disposition.kind !== 'scheduled_policy',
	)
	expect(nonScheduled.map((disposition) => disposition.table).sort()).toEqual(
		[...exemptions.keys()].sort(),
	)
	for (const disposition of nonScheduled) {
		expect(exemptions.get(disposition.table)).toBe(disposition.reason)
	}
})

test('retention disposition exemptions keep their explicit cleanup semantics', () => {
	expect(accountRetentionDispositions).toEqual(
		expect.arrayContaining([
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
		]),
	)
	// The schema-growth heuristic in retention.node.test.ts remains the broader
	// guardrail for discovering new growth-pattern tables.
	expect(getRetentionPolicyCoverage().has('mcp_memories')).toBe(true)
})
