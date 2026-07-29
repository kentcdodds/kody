import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(async () => ({
		sessionUserId: '42',
		userId: 42,
		username: 'test-user',
		email: 'user@example.com',
		displayName: 'user',
		artifactOwnerIds: [],
		mcpUser: {
			userId: 'stable-user-1',
			email: 'user@example.com',
			username: 'test-user',
			displayName: 'user',
		},
	})),
	readAuthSessionResult: async () => ({ session: null, setCookie: null }),
	getAppBaseUrl: () => 'https://example.com',
	hashPackageInvocationBearerToken: vi.fn(async () => 'hashed-raw-token'),
	insertPackageInvocationToken: vi.fn(async () => undefined),
	listPackageInvocationTokensByUserId: vi.fn(async () => [
		{
			id: 'token-1',
			user_id: 'stable-user-1',
			token_hash: 'stored-hash',
			name: 'Personal client',
			email: 'user@example.com',
			display_name: 'user',
			package_ids_json: '[]',
			package_kody_ids_json: '["*"]',
			export_names_json: '["*"]',
			sources_json: '["personal-client"]',
			created_at: new Date(0).toISOString(),
			updated_at: new Date(0).toISOString(),
			last_used_at: null,
			revoked_at: null,
			packageIds: [],
			packageKodyIds: ['*'],
			exportNames: ['*'],
			sources: ['personal-client'],
		},
	]),
	revokePackageInvocationToken: vi.fn(async () => true),
	reinstatePackageInvocationToken: vi.fn(async () => true),
	deletePackageInvocationToken: vi.fn(async () => true),
	updatePackageInvocationToken: vi.fn(async () => true),
	listSavedPackagesByUserId: vi.fn(async () => [
		{
			id: 'pkg-1',
			userId: 'stable-user-1',
			name: '@test/discord-gateway',
			kodyId: 'discord-gateway',
			description: '',
			tags: [],
			searchText: null,
			sourceId: 'source-1',
			hasApp: false,
			hidden: false,
			isPrivate: false,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		},
	]),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/auth-session.ts', () => ({
	readAuthSessionResult: (...args: Array<unknown>) =>
		mockModule.readAuthSessionResult(...args),
}))

vi.mock('#app/auth-redirect.ts', () => ({
	redirectToLogin: () => new Response(null, { status: 302 }),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: async () => new Response('ok'),
}))

vi.mock('#worker/app-base-url.ts', () => ({
	getAppBaseUrl: (...args: Array<unknown>) => mockModule.getAppBaseUrl(...args),
}))

vi.mock('#worker/package-invocations/repo.ts', () => ({
	hashPackageInvocationBearerToken: (...args: Array<unknown>) =>
		mockModule.hashPackageInvocationBearerToken(...args),
	insertPackageInvocationToken: (...args: Array<unknown>) =>
		mockModule.insertPackageInvocationToken(...args),
	listPackageInvocationTokensByUserId: (...args: Array<unknown>) =>
		mockModule.listPackageInvocationTokensByUserId(...args),
	reinstatePackageInvocationToken: (...args: Array<unknown>) =>
		mockModule.reinstatePackageInvocationToken(...args),
	revokePackageInvocationToken: (...args: Array<unknown>) =>
		mockModule.revokePackageInvocationToken(...args),
	deletePackageInvocationToken: (...args: Array<unknown>) =>
		mockModule.deletePackageInvocationToken(...args),
	updatePackageInvocationToken: (...args: Array<unknown>) =>
		mockModule.updatePackageInvocationToken(...args),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	packageInvocationScopeWildcard: '*',
	normalizeExportName: (exportName: string) => {
		const trimmed = exportName.trim()
		if (!trimmed) throw new Error('Package export name must not be empty.')
		if (trimmed === '.' || trimmed === './') return '.'
		return trimmed.startsWith('./') ? trimmed : `./${trimmed}`
	},
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByUserId(...args),
}))

const { createAccountPackageInvocationTokensApiHandler } =
	await import('./account-package-invocation-tokens.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		COOKIE_SECRET: 'secret',
	} as Env
}

function resetMocks() {
	mockModule.hashPackageInvocationBearerToken.mockClear()
	mockModule.insertPackageInvocationToken.mockClear()
	mockModule.listPackageInvocationTokensByUserId.mockClear()
	mockModule.revokePackageInvocationToken.mockClear()
	mockModule.reinstatePackageInvocationToken.mockClear()
	mockModule.deletePackageInvocationToken.mockClear()
	mockModule.updatePackageInvocationToken.mockClear()
	mockModule.listSavedPackagesByUserId.mockClear()
}

test('package invocation token API lists, creates, updates, validates, revokes, reinstates, and deletes tokens', async () => {
	resetMocks()
	const env = createEnv()
	const handler = createAccountPackageInvocationTokensApiHandler(env)

	const listResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/package-invocation-tokens.json',
		),
		params: {},
	} as never)

	expect(listResponse.status).toBe(200)
	expect(listResponse.headers.get('Cache-Control')).toBe('no-store')
	const listText = await listResponse.text()
	expect(listText).not.toContain('stored-hash')
	expect(JSON.parse(listText)).toEqual({
		ok: true,
		email: 'user@example.com',
		username: 'test-user',
		invocationUrlOrigin: 'https://example.com',
		packages: [
			{
				id: 'pkg-1',
				kodyId: 'discord-gateway',
				name: '@test/discord-gateway',
			},
		],
		tokens: [
			{
				id: 'token-1',
				name: 'Personal client',
				packageIds: [],
				packageKodyIds: ['*'],
				exportNames: ['*'],
				sources: ['personal-client'],
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
				lastUsedAt: null,
				revokedAt: null,
			},
		],
	})

	const createResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/package-invocation-tokens.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'create',
					name: 'Personal automation',
					rawToken: 'raw-personal-client-token',
					packageKodyIds: ['*'],
					exportNames: ['*'],
					sources: ['personal-client'],
				}),
			},
		),
		params: {},
	} as never)

	expect(createResponse.status).toBe(200)
	expect(mockModule.hashPackageInvocationBearerToken).toHaveBeenCalledWith(
		'raw-personal-client-token',
	)
	expect(mockModule.insertPackageInvocationToken).toHaveBeenCalledWith({
		db: env.APP_DB,
		row: expect.objectContaining({
			userId: 'stable-user-1',
			name: 'Personal automation',
			tokenHash: 'hashed-raw-token',
			email: 'user@example.com',
			displayName: 'user',
			packageIds: [],
			packageKodyIds: ['*'],
			exportNames: ['*'],
			sources: ['personal-client'],
		}),
	})
	const createText = await createResponse.text()
	expect(createText).not.toContain('raw-personal-client-token')
	expect(JSON.parse(createText)).toMatchObject({
		ok: true,
		selectedTokenId: expect.any(String),
	})

	const invalidScopeResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/package-invocation-tokens.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'create',
					name: 'Bad scope',
					rawToken: 'raw-token',
					packageKodyIds: ['other-package'],
					exportNames: ['run'],
				}),
			},
		),
		params: {},
	} as never)

	expect(invalidScopeResponse.status).toBe(400)
	await expect(invalidScopeResponse.json()).resolves.toEqual({
		ok: false,
		error: 'Unknown package Kody id: other-package',
	})
	expect(mockModule.insertPackageInvocationToken).toHaveBeenCalledTimes(1)

	const updateResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/package-invocation-tokens.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'update',
					id: 'token-1',
					name: 'Updated personal client',
					packageKodyIds: ['discord-gateway'],
					exportNames: ['dispatch-message-created'],
					sources: ['updated-client'],
					tokenHash: 'should-not-be-read',
				}),
			},
		),
		params: {},
	} as never)

	expect(updateResponse.status).toBe(200)
	expect(mockModule.hashPackageInvocationBearerToken).toHaveBeenCalledTimes(1)
	expect(mockModule.updatePackageInvocationToken).toHaveBeenNthCalledWith(1, {
		db: env.APP_DB,
		userId: 'stable-user-1',
		id: 'token-1',
		name: 'Updated personal client',
		tokenHash: undefined,
		packageIds: [],
		packageKodyIds: ['discord-gateway'],
		exportNames: ['./dispatch-message-created'],
		sources: ['updated-client'],
	})
	const updateText = await updateResponse.text()
	expect(updateText).not.toContain('should-not-be-read')
	expect(updateText).not.toContain('stored-hash')
	expect(JSON.parse(updateText)).toMatchObject({
		ok: true,
		selectedTokenId: 'token-1',
	})

	const replaceTokenResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/package-invocation-tokens.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'update',
					id: 'token-1',
					name: 'Rotated personal client',
					rawToken: 'replacement-raw-token',
					packageKodyIds: ['discord-gateway'],
					exportNames: ['dispatch-message-created'],
					sources: ['rotated-client'],
				}),
			},
		),
		params: {},
	} as never)

	expect(replaceTokenResponse.status).toBe(200)
	expect(mockModule.hashPackageInvocationBearerToken).toHaveBeenCalledTimes(2)
	expect(mockModule.hashPackageInvocationBearerToken).toHaveBeenLastCalledWith(
		'replacement-raw-token',
	)
	expect(mockModule.updatePackageInvocationToken).toHaveBeenNthCalledWith(2, {
		db: env.APP_DB,
		userId: 'stable-user-1',
		id: 'token-1',
		name: 'Rotated personal client',
		tokenHash: 'hashed-raw-token',
		packageIds: [],
		packageKodyIds: ['discord-gateway'],
		exportNames: ['./dispatch-message-created'],
		sources: ['rotated-client'],
	})
	const replaceTokenText = await replaceTokenResponse.text()
	expect(replaceTokenText).not.toContain('replacement-raw-token')
	expect(JSON.parse(replaceTokenText)).toMatchObject({
		ok: true,
		selectedTokenId: 'token-1',
	})

	const invalidUpdateResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/package-invocation-tokens.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'update',
					id: 'token-1',
					name: 'Bad update',
					packageKodyIds: ['other-package'],
					exportNames: ['run'],
				}),
			},
		),
		params: {},
	} as never)

	expect(invalidUpdateResponse.status).toBe(400)
	await expect(invalidUpdateResponse.json()).resolves.toEqual({
		ok: false,
		error: 'Unknown package Kody id: other-package',
	})
	expect(mockModule.updatePackageInvocationToken).toHaveBeenCalledTimes(2)

	const revokeResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/package-invocation-tokens.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'revoke',
					id: 'token-1',
				}),
			},
		),
		params: {},
	} as never)

	expect(revokeResponse.status).toBe(200)
	expect(mockModule.revokePackageInvocationToken).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: 'stable-user-1',
		id: 'token-1',
	})
	await expect(revokeResponse.json()).resolves.toMatchObject({ ok: true })

	const reinstateResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/package-invocation-tokens.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'reinstate',
					id: 'token-1',
				}),
			},
		),
		params: {},
	} as never)

	expect(reinstateResponse.status).toBe(200)
	expect(mockModule.reinstatePackageInvocationToken).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: 'stable-user-1',
		id: 'token-1',
	})
	await expect(reinstateResponse.json()).resolves.toMatchObject({
		ok: true,
		selectedTokenId: 'token-1',
	})

	const deleteResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/package-invocation-tokens.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'delete',
					id: 'token-1',
				}),
			},
		),
		params: {},
	} as never)

	expect(deleteResponse.status).toBe(200)
	expect(mockModule.deletePackageInvocationToken).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: 'stable-user-1',
		id: 'token-1',
	})
	const deletePayload = await deleteResponse.json()
	expect(deletePayload).toMatchObject({ ok: true })
	expect(deletePayload).not.toHaveProperty('selectedTokenId')
})
