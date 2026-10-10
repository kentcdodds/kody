import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	listUserOAuthGrants,
	listUserOAuthGrantsForClient,
	revokeAllOAuthGrantsBestEffort,
	revokeAllOAuthGrantsForUser,
} from '#worker/oauth-grants.ts'

type Grant = {
	id: string
	clientId: string
	scope: Array<string>
	createdAt?: number
	redirectUri?: string
	metadata?: Record<string, unknown>
}

function grant(id: string, clientId = 'client-a', extra: Partial<Grant> = {}) {
	return { id, clientId, scope: ['profile'], ...extra }
}

function createPagingGrantHelpers(
	pages: Array<{ items: Array<Grant>; cursor?: string }>,
) {
	const revoked: Array<string> = []
	return {
		revoked,
		helpers: {
			async listUserGrants(_userId: string, options?: { cursor?: string }) {
				const page = pages[options?.cursor === 'page-2' ? 1 : 0]
				return {
					...page,
					items: (page?.items ?? []).filter(
						(item) => !revoked.includes(item.id),
					),
				}
			},
			async revokeGrant(grantId: string, userId: string) {
				expect(userId).toBe('user-1')
				revoked.push(grantId)
			},
		},
	}
}

function staticGrants(
	items: Array<Grant>,
	revokeGrant: (grantId: string) => Promise<void> = async () => {},
) {
	return { listUserGrants: async () => ({ items }), revokeGrant }
}

test('listUserOAuthGrants keeps createdAt, redirectUri, and metadata across pages', async () => {
	const pageGrants = [
		grant('grant-1', 'client-a', {
			scope: ['mcp'],
			createdAt: 1_700_000_000,
			redirectUri: 'https://chatgpt.com/callback',
			metadata: { label: 'chatgpt' },
		}),
		grant('grant-2', 'client-b', {
			scope: ['mcp'],
			createdAt: 1_700_000_100,
			redirectUri: 'https://claude.ai/api/mcp/auth_callback',
			metadata: { label: 'claude' },
		}),
	]
	const { helpers } = createPagingGrantHelpers([
		{ items: [pageGrants[0]!], cursor: 'page-2' },
		{ items: [pageGrants[1]!] },
	])
	await expect(listUserOAuthGrants(helpers, 'user-1')).resolves.toEqual(
		pageGrants,
	)

	await expect(
		listUserOAuthGrants(
			staticGrants([
				grant('skip-me', '', { scope: ['mcp'] }),
				grant('keep-me', ' client-c ', { scope: ['mcp'] }),
			]),
			'user-1',
		),
	).resolves.toEqual([
		{ id: 'skip-me', clientId: '', scope: ['mcp'] },
		{ id: 'keep-me', clientId: 'client-c', scope: ['mcp'] },
	])
})

test('revokeAllOAuthGrantsForUser pages grants and revokes every id, including blank clientIds', async () => {
	const { helpers, revoked } = createPagingGrantHelpers([
		{
			items: [grant('grant-1'), grant('grant-blank', ''), grant('grant-2')],
			cursor: 'page-2',
		},
		{ items: [grant('grant-3', 'client-b')] },
	])

	await expect(
		revokeAllOAuthGrantsForUser({
			helpers,
			userId: ownerIdFromStored('user-1'),
		}),
	).resolves.toBe(4)
	expect(revoked).toEqual(['grant-1', 'grant-blank', 'grant-2', 'grant-3'])
	expect(
		await listUserOAuthGrantsForClient(helpers, 'user-1', 'client-a'),
	).toEqual([])
})

test('revokeAllOAuthGrantsForUser revokes a grant created during the first pass', async () => {
	const revoked: Array<string> = []
	const listPasses = [
		[grant('grant-a')],
		[grant('grant-interleaved', 'client-b')],
	]
	const helpers = {
		async listUserGrants() {
			return { items: listPasses.shift() ?? [] }
		},
		async revokeGrant(grantId: string) {
			revoked.push(grantId)
		},
	}

	await expect(
		revokeAllOAuthGrantsForUser({
			helpers,
			userId: ownerIdFromStored('user-1'),
		}),
	).resolves.toBe(2)
	expect(revoked).toEqual(['grant-a', 'grant-interleaved'])
})

test('revokeAllOAuthGrantsForUser fails closed when grants remain after max passes', async () => {
	await expect(
		revokeAllOAuthGrantsForUser({
			helpers: staticGrants([grant('grant-stuck')]),
			userId: ownerIdFromStored('user-1'),
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
		userId: ownerIdFromStored('user-1'),
		warnings,
	})
	expect(listingFailure).toBe(0)
	expect(warnings[0]).toContain('kv list failed')

	const revokeWarnings: Array<string> = []
	const revoked = await revokeAllOAuthGrantsBestEffort({
		helpers: staticGrants([grant('ok'), grant('bad')], async (grantId) => {
			if (grantId === 'bad') throw new Error('revoke boom')
		}),
		userId: ownerIdFromStored('user-1'),
		warnings: revokeWarnings,
	})
	expect(revoked).toBe(1)
	expect(revokeWarnings[0]).toContain('grant bad')
	expect(revokeWarnings[0]).toContain('revoke boom')
})
