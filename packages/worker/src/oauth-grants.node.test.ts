import { expect, test } from 'vitest'
import {
	listUserOAuthGrantsForClient,
	revokeAllOAuthGrantsBestEffort,
	revokeAllOAuthGrantsForUser,
} from '#worker/oauth-grants.ts'

function createPagingGrantHelpers(input: {
	pages: Array<{
		items: Array<{ id: string; clientId: string }>
		cursor?: string
	}>
	revoked?: Array<string>
}) {
	const revoked = input.revoked ?? []
	return {
		revoked,
		helpers: {
			async listUserGrants(_userId: string, options?: { cursor?: string }) {
				const livePages = input.pages.map((page) => ({
					...page,
					items: page.items.filter((grant) => !revoked.includes(grant.id)),
				}))
				if (options?.cursor === 'page-2') {
					return livePages[1] ?? { items: [] }
				}
				return livePages[0] ?? { items: [] }
			},
			async revokeGrant(grantId: string, userId: string) {
				expect(userId).toBe('user-1')
				revoked.push(grantId)
			},
		},
	}
}

test('revokeAllOAuthGrantsForUser pages grants and revokes every id', async () => {
	const { helpers, revoked } = createPagingGrantHelpers({
		pages: [
			{
				items: [
					{ id: 'grant-1', clientId: 'client-a', scope: ['profile'] },
					{ id: 'grant-2', clientId: 'client-a', scope: ['profile'] },
				],
				cursor: 'page-2',
			},
			{
				items: [{ id: 'grant-3', clientId: 'client-b', scope: ['profile'] }],
			},
		],
	})

	await expect(
		revokeAllOAuthGrantsForUser({ helpers, userId: 'user-1' }),
	).resolves.toBe(3)
	expect(revoked).toEqual(['grant-1', 'grant-2', 'grant-3'])
	expect(
		await listUserOAuthGrantsForClient(helpers, 'user-1', 'client-a'),
	).toEqual([])
})

test('revokeAllOAuthGrantsForUser revokes a grant created during the first pass', async () => {
	const revoked: Array<string> = []
	let listCalls = 0
	const helpers = {
		async listUserGrants() {
			listCalls += 1
			if (listCalls === 1) {
				return {
					items: [{ id: 'grant-a', clientId: 'client-a', scope: ['profile'] }],
				}
			}
			if (listCalls === 2) {
				return {
					items: [
						{
							id: 'grant-interleaved',
							clientId: 'client-b',
							scope: ['profile'],
						},
					],
				}
			}
			return { items: [] }
		},
		async revokeGrant(grantId: string) {
			revoked.push(grantId)
		},
	}

	await expect(
		revokeAllOAuthGrantsForUser({ helpers, userId: 'user-1' }),
	).resolves.toBe(2)
	expect(revoked).toEqual(['grant-a', 'grant-interleaved'])
})

test('revokeAllOAuthGrantsForUser fails closed when grants remain after max passes', async () => {
	await expect(
		revokeAllOAuthGrantsForUser({
			helpers: {
				async listUserGrants() {
					return {
						items: [
							{ id: 'grant-stuck', clientId: 'client-a', scope: ['profile'] },
						],
					}
				},
				async revokeGrant() {
					return
				},
			},
			userId: 'user-1',
		}),
	).rejects.toThrow('oauth_grants_still_present')
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
						{ id: 'ok', clientId: 'client-a', scope: ['profile'] },
						{ id: 'bad', clientId: 'client-a', scope: ['profile'] },
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
