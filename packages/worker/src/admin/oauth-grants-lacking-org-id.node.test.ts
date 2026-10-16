import { expect, test, vi } from 'vitest'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import {
	mergeOauthGrantsLackingOrgIdByClient,
	oauthGrantsLackingOrgIdRevokeConfirm,
	parseOauthGrantKvKey,
	readOauthGrantClientId,
	runOauthGrantsLackingOrgIdRevoke,
} from './oauth-grants-lacking-org-id.ts'

const revokeGrant = vi.fn<(grantId: string, userId: string) => Promise<void>>(
	async () => undefined,
)

vi.mock('#worker/oauth-helpers.ts', () => ({
	resolveOAuthHelpers: async () => ({
		listUserGrants: async () => ({ items: [] }),
		revokeGrant,
	}),
}))

vi.mock('#worker/oauth-refresh-family.ts', () => ({
	forgetRefreshFamilyGrant: vi.fn(async () => undefined),
}))

function grantJson(input: {
	id: string
	userId: string
	clientId: string
	orgId?: string
}) {
	return JSON.stringify({
		id: input.id,
		clientId: input.clientId,
		userId: input.userId,
		scope: ['mcp'],
		metadata: input.orgId ? { orgId: input.orgId } : { label: input.id },
		createdAt: 1_700_000_000,
		encryptedProps: 'opaque',
	})
}

test('parseOauthGrantKvKey accepts grant:userId:grantId only', () => {
	expect(parseOauthGrantKvKey('grant:user-a:grant-1')).toEqual({
		userId: 'user-a',
		grantId: 'grant-1',
	})
	expect(parseOauthGrantKvKey('grant:user-a:grant:extra')).toBeNull()
	expect(parseOauthGrantKvKey('token:user-a:grant-1:tok')).toBeNull()
	expect(parseOauthGrantKvKey('grant::grant-1')).toBeNull()
})

test('readOauthGrantClientId falls back to (unknown)', () => {
	expect(readOauthGrantClientId({ clientId: ' https://client.example ' })).toBe(
		'https://client.example',
	)
	expect(readOauthGrantClientId({ clientId: '  ' })).toBe('(unknown)')
	expect(readOauthGrantClientId(null)).toBe('(unknown)')
})

test('dry-run counts grants lacking metadata.orgId and does not revoke', async () => {
	revokeGrant.mockClear()
	const { kv } = createMemoryKvNamespace({
		'grant:user-a:grant-1': grantJson({
			id: 'grant-1',
			userId: 'user-a',
			clientId: 'client-cursor',
		}),
		'grant:user-a:grant-2': grantJson({
			id: 'grant-2',
			userId: 'user-a',
			clientId: 'client-claude',
			orgId: 'org-stamped',
		}),
		'grant:user-b:grant-3': grantJson({
			id: 'grant-3',
			userId: 'user-b',
			clientId: 'client-cursor',
		}),
		'client:client-cursor': JSON.stringify({ clientId: 'client-cursor' }),
	})

	const result = await runOauthGrantsLackingOrgIdRevoke({
		env: { OAUTH_KV: kv } as Env,
		dryRun: true,
	})

	expect(result).toMatchObject({
		dryRun: true,
		scanned: 3,
		withOrgId: 1,
		lackingOrgId: 2,
		revoked: 0,
		usersLackingOrgId: 2,
		complete: true,
		nextCursor: null,
		failures: [],
	})
	expect(result.byClient).toEqual([{ clientId: 'client-cursor', count: 2 }])
	expect(revokeGrant).not.toHaveBeenCalled()
	expect(oauthGrantsLackingOrgIdRevokeConfirm).toBe(
		'revoke grants lacking metadata.orgId',
	)
})

test('apply revokes lacking grants and a second pass finds zero', async () => {
	revokeGrant.mockClear()
	const { kv } = createMemoryKvNamespace({
		'grant:user-a:grant-1': grantJson({
			id: 'grant-1',
			userId: 'user-a',
			clientId: 'client-cursor',
		}),
		'grant:user-a:grant-2': grantJson({
			id: 'grant-2',
			userId: 'user-a',
			clientId: 'client-claude',
			orgId: 'org-stamped',
		}),
		'grant:user-b:grant-3': grantJson({
			id: 'grant-3',
			userId: 'user-b',
			clientId: 'client-cursor',
		}),
	})
	revokeGrant.mockImplementation(async (grantId: string, userId: string) => {
		await kv.delete(`grant:${userId}:${grantId}`)
	})

	const applied = await runOauthGrantsLackingOrgIdRevoke({
		env: { OAUTH_KV: kv } as Env,
		dryRun: false,
	})
	expect(applied).toMatchObject({
		dryRun: false,
		scanned: 3,
		lackingOrgId: 2,
		revoked: 2,
		withOrgId: 1,
		failures: [],
		complete: true,
	})
	expect(revokeGrant).toHaveBeenCalledTimes(2)

	const second = await runOauthGrantsLackingOrgIdRevoke({
		env: { OAUTH_KV: kv } as Env,
		dryRun: true,
	})
	expect(second).toMatchObject({
		scanned: 1,
		withOrgId: 1,
		lackingOrgId: 0,
		revoked: 0,
		usersLackingOrgId: 0,
		byClient: [],
		complete: true,
	})
})

test('apply records per-grant failures without aborting the page', async () => {
	revokeGrant.mockClear()
	revokeGrant.mockImplementation(async (grantId: string) => {
		if (grantId === 'grant-1') throw new Error('kv_unavailable')
	})
	const { kv } = createMemoryKvNamespace({
		'grant:user-a:grant-1': grantJson({
			id: 'grant-1',
			userId: 'user-a',
			clientId: 'client-a',
		}),
		'grant:user-a:grant-2': grantJson({
			id: 'grant-2',
			userId: 'user-a',
			clientId: 'client-b',
		}),
	})

	const result = await runOauthGrantsLackingOrgIdRevoke({
		env: { OAUTH_KV: kv } as Env,
		dryRun: false,
	})
	expect(result.revoked).toBe(1)
	expect(result.failures).toEqual([
		{
			grantId: 'grant-1',
			userId: 'user-a',
			clientId: 'client-a',
			error: 'kv_unavailable',
		},
	])
})

test('mergeOauthGrantsLackingOrgIdByClient sums pages', () => {
	expect(
		mergeOauthGrantsLackingOrgIdByClient([
			[
				{ clientId: 'a', count: 2 },
				{ clientId: 'b', count: 1 },
			],
			[{ clientId: 'a', count: 3 }],
		]),
	).toEqual([
		{ clientId: 'a', count: 5 },
		{ clientId: 'b', count: 1 },
	])
})
