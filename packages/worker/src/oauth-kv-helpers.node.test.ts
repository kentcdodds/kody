import { expect, test } from 'vitest'
import { createKvOAuthHelpers } from './oauth-kv-helpers.ts'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'

function grantRecord(input: {
	id: string
	userId: string
	clientId: string
	scope?: Array<string>
}) {
	return JSON.stringify({
		id: input.id,
		clientId: input.clientId,
		userId: input.userId,
		scope: input.scope ?? ['mcp'],
		metadata: { label: input.id },
		createdAt: 1_700_000_000,
		encryptedProps: 'opaque',
		authCodeId: null,
	})
}

function tokenRecord(input: { userId: string; grantId: string; id: string }) {
	return JSON.stringify({
		id: input.id,
		grantId: input.grantId,
		userId: input.userId,
		createdAt: 1_700_000_000,
		expiresAt: 1_700_003_600,
		wrappedEncryptionKey: 'opaque',
	})
}

function seedProviderKv() {
	return createMemoryKvNamespace({
		'client:client-a': JSON.stringify({ clientId: 'client-a' }),
		'client:client-b': JSON.stringify({ clientId: 'client-b' }),
		'grant:user-aaa:grant-1': grantRecord({
			id: 'grant-1',
			userId: 'user-aaa',
			clientId: 'client-a',
			scope: ['mcp', 'profile'],
		}),
		'grant:user-aaa:grant-2': grantRecord({
			id: 'grant-2',
			userId: 'user-aaa',
			clientId: 'client-b',
		}),
		'grant:user-bbb:grant-3': grantRecord({
			id: 'grant-3',
			userId: 'user-bbb',
			clientId: 'client-a',
		}),
		'token:user-aaa:grant-1:tok-1': tokenRecord({
			userId: 'user-aaa',
			grantId: 'grant-1',
			id: 'tok-1',
		}),
		'token:user-aaa:grant-1:tok-2': tokenRecord({
			userId: 'user-aaa',
			grantId: 'grant-1',
			id: 'tok-2',
		}),
		'token:user-aaa:grant-2:tok-3': tokenRecord({
			userId: 'user-aaa',
			grantId: 'grant-2',
			id: 'tok-3',
		}),
		'token:user-bbb:grant-3:tok-4': tokenRecord({
			userId: 'user-bbb',
			grantId: 'grant-3',
			id: 'tok-4',
		}),
	})
}

test('listUserGrants returns only the user’s grants in provider summary shape and pages with cursors', async () => {
	const { kv } = seedProviderKv()
	const helpers = createKvOAuthHelpers(kv)

	const all = await helpers.listUserGrants('user-aaa')
	expect(all.cursor).toBeUndefined()
	expect(all.items).toEqual([
		{
			id: 'grant-1',
			clientId: 'client-a',
			userId: 'user-aaa',
			scope: ['mcp', 'profile'],
			metadata: { label: 'grant-1' },
			createdAt: 1_700_000_000,
			expiresAt: undefined,
			redirectUri: undefined,
		},
		{
			id: 'grant-2',
			clientId: 'client-b',
			userId: 'user-aaa',
			scope: ['mcp'],
			metadata: { label: 'grant-2' },
			createdAt: 1_700_000_000,
			expiresAt: undefined,
			redirectUri: undefined,
		},
	])

	const firstPage = await helpers.listUserGrants('user-aaa', { limit: 1 })
	expect(firstPage.items.map((grant) => grant.id)).toEqual(['grant-1'])
	expect(firstPage.cursor).toBeDefined()
	const secondPage = await helpers.listUserGrants('user-aaa', {
		limit: 1,
		cursor: firstPage.cursor,
	})
	expect(secondPage.items.map((grant) => grant.id)).toEqual(['grant-2'])
	expect(secondPage.cursor).toBeUndefined()

	expect((await helpers.listUserGrants('user-none')).items).toEqual([])
})

test('revokeGrant deletes the grant and every token under it and nothing of another user', async () => {
	const { kv, store } = seedProviderKv()
	const helpers = createKvOAuthHelpers(kv)

	await helpers.revokeGrant('grant-1', 'user-aaa')

	expect([...store.keys()].sort()).toEqual([
		'client:client-a',
		'client:client-b',
		'grant:user-aaa:grant-2',
		'grant:user-bbb:grant-3',
		'token:user-aaa:grant-2:tok-3',
		'token:user-bbb:grant-3:tok-4',
	])

	await expect(
		helpers.revokeGrant('grant-missing', 'user-aaa'),
	).resolves.toBeUndefined()
})

test('revokeGrant pages through more tokens than one list call returns', async () => {
	const { kv, store } = createMemoryKvNamespace({
		'grant:user-aaa:grant-1': grantRecord({
			id: 'grant-1',
			userId: 'user-aaa',
			clientId: 'client-a',
		}),
	})
	for (let index = 0; index < 1_250; index++) {
		store.set(
			`token:user-aaa:grant-1:tok-${String(index).padStart(4, '0')}`,
			tokenRecord({
				userId: 'user-aaa',
				grantId: 'grant-1',
				id: `tok-${index}`,
			}),
		)
	}

	await createKvOAuthHelpers(kv).revokeGrant('grant-1', 'user-aaa')

	expect(store.size).toBe(0)
})

test('deleteClient revokes every grant issued to the client across users and removes the client key', async () => {
	const { kv, store } = seedProviderKv()
	const helpers = createKvOAuthHelpers(kv)

	await helpers.deleteClient('client-a')

	expect([...store.keys()].sort()).toEqual([
		'client:client-b',
		'grant:user-aaa:grant-2',
		'token:user-aaa:grant-2:tok-3',
	])
})
