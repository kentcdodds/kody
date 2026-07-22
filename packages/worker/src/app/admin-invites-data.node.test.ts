import { expect, test } from 'vitest'
import {
	inviteAssignablePlanNames,
	residualUnlimitedInvitePlanWarningTag,
	unknownStoredPlanWarningTag,
} from '#worker/entitlements/plans.ts'
import {
	consoleWarn,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'
import { loadAdminInvitesData } from './admin-invites-data.ts'

function createAdminInvitesTestDb(
	invites: Array<{
		code: string
		created_by: number | null
		created_by_email: string | null
		note: string
		max_uses: number
		use_count: number
		expires_at: string | null
		revoked_at: string | null
		created_at: string
		plan: string
	}>,
) {
	const db = {
		prepare(_query: string) {
			return {
				async all<T>() {
					return { results: invites as Array<T> }
				},
			}
		},
	} as unknown as D1Database
	return db
}

test('loadAdminInvitesData coerces unknown and residual unlimited invite plans to max', async () => {
	silenceExpectedConsoleWarns([
		unknownStoredPlanWarningTag,
		residualUnlimitedInvitePlanWarningTag,
	])
	const data = await loadAdminInvitesData({
		APP_DB: createAdminInvitesTestDb([
			{
				code: 'KNOWN-PRO',
				created_by: 1,
				created_by_email: 'admin@example.com',
				note: '',
				max_uses: 1,
				use_count: 0,
				expires_at: null,
				revoked_at: null,
				created_at: '2026-07-05T00:00:00.000Z',
				plan: 'pro',
			},
			{
				code: 'RESIDUAL-UNLIMITED',
				created_by: 1,
				created_by_email: 'admin@example.com',
				note: '',
				max_uses: 1,
				use_count: 0,
				expires_at: null,
				revoked_at: null,
				created_at: '2026-07-04T12:00:00.000Z',
				plan: 'unlimited',
			},
			{
				code: 'UNKNOWN-PLAN',
				created_by: 1,
				created_by_email: 'admin@example.com',
				note: '',
				max_uses: 1,
				use_count: 0,
				expires_at: null,
				revoked_at: null,
				created_at: '2026-07-04T00:00:00.000Z',
				plan: 'enterprise-2099',
			},
		]),
	} as Env)

	expect(data.availablePlans).toEqual([...inviteAssignablePlanNames])
	expect(data.availablePlans).toHaveLength(4)
	expect(data.availablePlans).not.toContain('unlimited')
	expect(data.invites).toEqual([
		expect.objectContaining({ code: 'KNOWN-PRO', plan: 'pro' }),
		expect.objectContaining({ code: 'RESIDUAL-UNLIMITED', plan: 'max' }),
		expect.objectContaining({ code: 'UNKNOWN-PLAN', plan: 'max' }),
	])
	expect(consoleWarn).toHaveBeenCalledWith(
		residualUnlimitedInvitePlanWarningTag,
	)
	expect(consoleWarn).toHaveBeenCalledWith(unknownStoredPlanWarningTag)
})
