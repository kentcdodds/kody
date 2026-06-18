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
			name: 'Raycast',
			email: 'user@example.com',
			display_name: 'user',
			package_ids_json: '[]',
			package_kody_ids_json: '["*"]',
			export_names_json: '["*"]',
			sources_json: '["raycast"]',
			created_at: new Date(0).toISOString(),
			updated_at: new Date(0).toISOString(),
			last_used_at: null,
			revoked_at: null,
			packageIds: [],
			packageKodyIds: ['*'],
			exportNames: ['*'],
			sources: ['raycast'],
		},
	]),
	revokePackageInvocationToken: vi.fn(async () => true),
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

vi.mock('#app/layout.ts', () => ({
	Layout: () => null,
}))

vi.mock('#app/render.ts', () => ({
	render: () => new Response('ok'),
}))

vi.mock('#app/app-base-url.ts', () => ({
	getAppBaseUrl: (...args: Array<unknown>) => mockModule.getAppBaseUrl(...args),
}))

vi.mock('#worker/package-invocations/repo.ts', () => ({
	hashPackageInvocationBearerToken: (...args: Array<unknown>) =>
		mockModule.hashPackageInvocationBearerToken(...args),
	insertPackageInvocationToken: (...args: Array<unknown>) =>
		mockModule.insertPackageInvocationToken(...args),
	listPackageInvocationTokensByUserId: (...args: Array<unknown>) =>
		mockModule.listPackageInvocationTokensByUserId(...args),
	revokePackageInvocationToken: (...args: Array<unknown>) =>
		mockModule.revokePackageInvocationToken(...args),
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
	mockModule.listSavedPackagesByUserId.mockClear()
}

test('package invocation token API lists token metadata without token hashes', async () => {
	resetMocks()
	const handler = createAccountPackageInvocationTokensApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request(
			'https://example.com/account/package-invocation-tokens.json',
		),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	const text = await response.text()
	expect(text).not.toContain('stored-hash')
	expect(JSON.parse(text)).toEqual({
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
				name: 'Raycast',
				packageIds: [],
				packageKodyIds: ['*'],
				exportNames: ['*'],
				sources: ['raycast'],
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
				lastUsedAt: null,
				revokedAt: null,
			},
		],
	})
})

test('package invocation token API hashes raw tokens and stores Raycast wildcard scopes', async () => {
	resetMocks()
	const env = createEnv()
	const handler = createAccountPackageInvocationTokensApiHandler(env)
	const response = await handler.handler({
		request: new Request(
			'https://example.com/account/package-invocation-tokens.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'create',
					name: 'Personal Raycast',
					rawToken: 'raw-raycast-token',
					packageKodyIds: ['*'],
					exportNames: ['*'],
					sources: ['raycast'],
				}),
			},
		),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	expect(mockModule.hashPackageInvocationBearerToken).toHaveBeenCalledWith(
		'raw-raycast-token',
	)
	expect(mockModule.insertPackageInvocationToken).toHaveBeenCalledWith({
		db: env.APP_DB,
		row: expect.objectContaining({
			userId: 'stable-user-1',
			name: 'Personal Raycast',
			tokenHash: 'hashed-raw-token',
			email: 'user@example.com',
			displayName: 'user',
			packageIds: [],
			packageKodyIds: ['*'],
			exportNames: ['*'],
			sources: ['raycast'],
		}),
	})
	const text = await response.text()
	expect(text).not.toContain('raw-raycast-token')
	expect(JSON.parse(text)).toMatchObject({
		ok: true,
		selectedTokenId: expect.any(String),
	})
})

test('package invocation token API rejects concrete package scopes not owned by the user', async () => {
	resetMocks()
	const handler = createAccountPackageInvocationTokensApiHandler(createEnv())
	const response = await handler.handler({
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

	expect(response.status).toBe(400)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: 'Unknown package Kody id: other-package',
	})
	expect(mockModule.insertPackageInvocationToken).not.toHaveBeenCalled()
})

test('package invocation token API revokes tokens by signed-in stable user id', async () => {
	resetMocks()
	const env = createEnv()
	const handler = createAccountPackageInvocationTokensApiHandler(env)
	const response = await handler.handler({
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

	expect(response.status).toBe(200)
	expect(mockModule.revokePackageInvocationToken).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: 'stable-user-1',
		id: 'token-1',
	})
	await expect(response.json()).resolves.toMatchObject({ ok: true })
})
