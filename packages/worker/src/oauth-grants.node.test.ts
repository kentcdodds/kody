import { expect, test } from 'vitest'
import {
	listUserOAuthGrantsForClient,
	revokeAllOAuthGrantsBestEffort,
	revokeAllOAuthGrantsForUser,
} from '#worker/oauth-grants.ts'

test('revokeAllOAuthGrantsForUser pages grants and revokes every id', async () => {
	const revoked: Array<string> = []
	const helpers = {
		async listUserGrants(_userId: string, options?: { cursor?: string }) {
			if (options?.cursor === 'page-2') {
				return {
					items: [{ id: 'grant-3', clientId: 'client-b' }],
				}
			}
			return {
				items: [
					{ id: 'grant-1', clientId: 'client-a' },
					{ id: 'grant-2', clientId: 'client-a' },
				],
				cursor: 'page-2',
			}
		},
		async revokeGrant(grantId: string, userId: string) {
			expect(userId).toBe('user-1')
			revoked.push(grantId)
		},
	}

	await expect(
		revokeAllOAuthGrantsForUser({ helpers, userId: 'user-1' }),
	).resolves.toBe(3)
	expect(revoked).toEqual(['grant-1', 'grant-2', 'grant-3'])
	expect(
		await listUserOAuthGrantsForClient(helpers, 'user-1', 'client-a'),
	).toEqual([
		{ id: 'grant-1', clientId: 'client-a' },
		{ id: 'grant-2', clientId: 'client-a' },
	])
})

test('revokeAllOAuthGrantsBestEffort records listing and revoke failures', async () => {
	const warnings: Array<string> = []
	const listingFailure = await revokeAllOAuthGrantsBestEffort({
		helpers: {
			async listUserGrants() {
				throw new Error('kv list failed')
			},
			async revokeGrant() {
				throw new Error('should not run')
			},
		},
		userId: 'user-1',
		warnings,
	})
	expect(listingFailure).toBe(0)
	expect(warnings[0]).toContain('kv list failed')

	const revokeWarnings: Array<string> = []
	const revoked = await revokeAllOAuthGrantsBestEffort({
		helpers: {
			async listUserGrants() {
				return {
					items: [
						{ id: 'ok', clientId: 'client-a' },
						{ id: 'bad', clientId: 'client-a' },
					],
				}
			},
			async revokeGrant(grantId: string) {
				if (grantId === 'bad') throw new Error('revoke boom')
			},
		},
		userId: 'user-1',
		warnings: revokeWarnings,
	})
	expect(revoked).toBe(1)
	expect(revokeWarnings[0]).toContain('grant bad')
	expect(revokeWarnings[0]).toContain('revoke boom')
})
