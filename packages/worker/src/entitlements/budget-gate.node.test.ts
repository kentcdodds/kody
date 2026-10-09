import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	deriveRequestContext,
	requestLineage,
} from '#worker/request-context/request-context.ts'
import {
	orgBudgetForJobExecution,
	shouldMutateBudgetMtdForMonth,
} from './budget-gate.ts'

test('orgBudgetForJobExecution attributes scheduled runs to automation budget', () => {
	expect(
		orgBudgetForJobExecution({
			orgId: 'org-1',
			orgSlug: 'acme',
			source: { kind: 'schedule', jobId: 'job-1' },
		}),
	).toEqual({
		orgId: 'org-1',
		orgSlug: 'acme',
		automationSource: 'schedule',
		actorUserId: null,
	})
})

test('orgBudgetForJobExecution uses inherited actor for run-now lineage', () => {
	const userId = personIdFromStored('user-1')
	expect(
		orgBudgetForJobExecution({
			orgId: 'org-1',
			orgSlug: 'acme',
			source: {
				kind: 'inherited',
				lineage: requestLineage(
					deriveRequestContext({
						user: { userId, username: 'sam' },
						source: { kind: 'session' },
					}),
				),
			},
		}),
	).toEqual({
		orgId: 'org-1',
		orgSlug: 'acme',
		actorUserId: userId,
		actorUsername: 'sam',
	})
})

test('shouldMutateBudgetMtdForMonth allows only the live UTC month', () => {
	const now = new Date('2026-04-10T12:00:00.000Z')
	expect(shouldMutateBudgetMtdForMonth('2026-04', now)).toBe(true)
	expect(shouldMutateBudgetMtdForMonth('2026-03', now)).toBe(false)
})
