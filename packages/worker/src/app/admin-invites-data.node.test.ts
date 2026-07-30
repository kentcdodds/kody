import { expect, test } from 'vitest'
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

test('loadAdminInvitesData rejects an invalid stored invite plan', async () => {
	await expect(
		loadAdminInvitesData({
			APP_DB: createAdminInvitesTestDb([
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
		} as Env),
	).rejects.toThrow('Stored plan is not a registered plan name.')
})
