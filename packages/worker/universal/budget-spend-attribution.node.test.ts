import { expect, test } from 'vitest'
import { buildBudgetSpendActorWeights } from './budget-spend-attribution.ts'

test('buildBudgetSpendActorWeights ignores include-covered units', () => {
	const shares = buildBudgetSpendActorWeights({
		includes: [
			{ meter: 'unique_worker_days', include: 10 },
			{ meter: 'durable_object_rows_read', include: 0 },
		],
		dailyUnits: [
			{
				day: '2026-10-01',
				meter: 'unique_worker_days',
				actorUserId: 'member-a',
				automationSource: '',
				units: 10,
			},
			{
				day: '2026-10-02',
				meter: 'unique_worker_days',
				actorUserId: 'member-b',
				automationSource: '',
				units: 5,
			},
		],
	})
	expect(shares).toHaveLength(1)
	expect(shares[0]).toEqual({
		actorUserId: 'member-b',
		automationSource: null,
		weight: 20_000,
	})
})

test('buildBudgetSpendActorWeights prefers automation_source over actor', () => {
	const shares = buildBudgetSpendActorWeights({
		includes: [{ meter: 'unique_worker_days', include: 0 }],
		dailyUnits: [
			{
				day: '2026-10-01',
				meter: 'unique_worker_days',
				actorUserId: 'org-id',
				automationSource: 'schedule',
				units: 2,
			},
		],
	})
	expect(shares).toEqual([
		{
			actorUserId: null,
			automationSource: 'schedule',
			weight: 8_000,
		},
	])
})

test('buildBudgetSpendActorWeights returns empty when everything is covered', () => {
	const shares = buildBudgetSpendActorWeights({
		includes: [{ meter: 'unique_worker_days', include: 100 }],
		dailyUnits: [
			{
				day: '2026-10-01',
				meter: 'unique_worker_days',
				actorUserId: 'member-a',
				automationSource: '',
				units: 5,
			},
		],
	})
	expect(shares).toEqual([])
})
