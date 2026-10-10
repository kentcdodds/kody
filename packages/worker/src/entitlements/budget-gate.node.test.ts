import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	deriveRequestContext,
	requestLineage,
} from '#worker/request-context/request-context.ts'
import { DatabaseSync } from 'node:sqlite'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	assertWithinOrgBudget,
	orgBudgetForJobExecution,
	shouldMutateBudgetMtdForMonth,
} from './budget-gate.ts'

test('orgBudgetForJobExecution attributes scheduled runs to automation budget', () => {
	expect(
		orgBudgetForJobExecution({
			orgId: ownerIdFromStored('org-1'),
			orgSlug: 'acme',
			source: { kind: 'schedule', jobId: 'job-1' },
		}),
	).toEqual({
		orgId: ownerIdFromStored('org-1'),
		orgSlug: 'acme',
		automationSource: 'schedule',
		actorUserId: null,
	})
})

test('orgBudgetForJobExecution uses inherited actor for run-now lineage', () => {
	const userId = personIdFromStored('user-1')
	expect(
		orgBudgetForJobExecution({
			orgId: ownerIdFromStored('org-1'),
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
		orgId: ownerIdFromStored('org-1'),
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

test('assertWithinOrgBudget skips the gate only when the org row is missing', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	await expect(
		assertWithinOrgBudget({
			db,
			env: {} as never,
			orgId: ownerIdFromStored('missing-org'),
			actorUserId: 'person-1',
			automationSource: null,
			estimatedDeltaMicroUsd: 1,
		}),
	).resolves.toBeUndefined()
})

test('assertWithinOrgBudget fails closed when the org lookup errors', async () => {
	const db = {
		prepare() {
			throw new Error('D1 unavailable')
		},
	} as unknown as D1Database
	await expect(
		assertWithinOrgBudget({
			db,
			env: {} as never,
			orgId: ownerIdFromStored('org-1'),
			actorUserId: 'person-1',
			automationSource: null,
			estimatedDeltaMicroUsd: 1,
		}),
	).rejects.toThrow('D1 unavailable')
})
