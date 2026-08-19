import { expect, test, vi } from 'vitest'

const savedPackage = {
	id: 'pkg-1',
	userId: 'stable-user-1',
	name: '@test/discord-gateway',
	kodyId: 'discord-gateway',
	description: 'Dispatch Discord gateway events.',
	tags: ['discord', 'events'],
	searchText: 'discord gateway websocket',
	sourceId: 'source-1',
	hasApp: true,
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
}

const tokenRecord = {
	id: 'token-1',
	user_id: 'stable-user-1',
	package_id: 'pkg-1',
	token_hash: 'stored-hash',
	name: 'Personal client',
	export_names_json: '["*"]',
	sources_json: '["personal-client"]',
	created_at: new Date(0).toISOString(),
	updated_at: new Date(0).toISOString(),
	last_used_at: null,
	revoked_at: null,
	exportNames: ['*'],
	sources: ['personal-client'],
}

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
	searchSavedPackagesByUserId: vi.fn(),
	getSavedPackageById: vi.fn(),
	listPackageInvocationTokensByPackageId: vi.fn(async () => [tokenRecord]),
	hashPackageInvocationBearerToken: vi.fn(async () => 'hashed-raw-token'),
	insertPackageInvocationToken: vi.fn(async () => undefined),
	updatePackageInvocationToken: vi.fn(async () => true),
	revokePackageInvocationToken: vi.fn(async () => true),
	reinstatePackageInvocationToken: vi.fn(async () => true),
	deletePackageInvocationToken: vi.fn(async () => true),
	getAppBaseUrl: () => 'https://example.com',
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/auth-session.ts', () => ({
	readAuthSessionResult: async () => ({ session: null, setCookie: null }),
}))

vi.mock('#app/auth-redirect.ts', () => ({
	redirectToLogin: () => new Response(null, { status: 302 }),
	redirectToLoginWhenUnauthenticated: () => new Response(null, { status: 302 }),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: async () => new Response('ok'),
}))

vi.mock('#worker/app-base-url.ts', () => ({
	getAppBaseUrl: (...args: Array<unknown>) => mockModule.getAppBaseUrl(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	searchSavedPackagesByUserId: (...args: Array<unknown>) =>
		mockModule.searchSavedPackagesByUserId(...args),
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/package-invocations/repo.ts', () => ({
	listPackageInvocationTokensByPackageId: (...args: Array<unknown>) =>
		mockModule.listPackageInvocationTokensByPackageId(...args),
	hashPackageInvocationBearerToken: (...args: Array<unknown>) =>
		mockModule.hashPackageInvocationBearerToken(...args),
	insertPackageInvocationToken: (...args: Array<unknown>) =>
		mockModule.insertPackageInvocationToken(...args),
	updatePackageInvocationToken: (...args: Array<unknown>) =>
		mockModule.updatePackageInvocationToken(...args),
	revokePackageInvocationToken: (...args: Array<unknown>) =>
		mockModule.revokePackageInvocationToken(...args),
	reinstatePackageInvocationToken: (...args: Array<unknown>) =>
		mockModule.reinstatePackageInvocationToken(...args),
	deletePackageInvocationToken: (...args: Array<unknown>) =>
		mockModule.deletePackageInvocationToken(...args),
}))

const { createAccountPackagesApiHandler } =
	await import('./account-packages.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		COOKIE_SECRET: 'secret',
	} as Env
}

function resetTokenMocks() {
	mockModule.hashPackageInvocationBearerToken.mockClear()
	mockModule.insertPackageInvocationToken.mockClear()
	mockModule.updatePackageInvocationToken.mockClear()
	mockModule.revokePackageInvocationToken.mockClear()
	mockModule.reinstatePackageInvocationToken.mockClear()
	mockModule.deletePackageInvocationToken.mockClear()
	mockModule.listPackageInvocationTokensByPackageId.mockClear()
	mockModule.listPackageInvocationTokensByPackageId.mockResolvedValue([
		tokenRecord,
	])
}

test('packages API lists with filters, ignores invalid values, and rejects unknown actions', async () => {
	mockModule.searchSavedPackagesByUserId.mockResolvedValue({
		items: [savedPackage],
		total: 1,
	})
	mockModule.getSavedPackageById.mockResolvedValue(savedPackage)
	const env = createEnv()
	const handler = createAccountPackagesApiHandler(env)

	const defaults = await handler.handler({
		request: new Request('https://example.com/account/packages.json'),
		params: {},
	} as never)
	expect(defaults.status).toBe(200)
	expect(defaults.headers.get('Cache-Control')).toBe('no-store')
	expect(mockModule.searchSavedPackagesByUserId).toHaveBeenCalledWith(
		env.APP_DB,
		{
			userId: 'stable-user-1',
			query: '',
			hasApp: null,
			sort: 'updated',
			limit: 20,
			offset: 0,
		},
	)
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()
	await expect(defaults.json()).resolves.toMatchObject({
		ok: true,
		email: 'user@example.com',
		username: 'test-user',
		invocationUrlOrigin: 'https://example.com',
		packages: [
			expect.objectContaining({
				id: 'pkg-1',
				kodyId: 'discord-gateway',
				hasApp: true,
			}),
		],
		selectedPackage: null,
		page: 1,
		pageSize: 20,
		total: 1,
		query: '',
		appFilter: 'all',
		sort: 'updated',
	})

	mockModule.searchSavedPackagesByUserId.mockClear()
	mockModule.getSavedPackageById.mockClear()
	mockModule.searchSavedPackagesByUserId.mockResolvedValue({
		items: [savedPackage],
		total: 1,
	})
	mockModule.getSavedPackageById.mockResolvedValue(savedPackage)
	mockModule.listPackageInvocationTokensByPackageId.mockResolvedValue([
		tokenRecord,
	])

	const filtered = await handler.handler({
		request: new Request(
			'https://example.com/account/packages.json?q=discord&app=with&sort=name&page=3&pageSize=10&selected=pkg-1',
		),
		params: {},
	} as never)
	expect(filtered.status).toBe(200)
	expect(mockModule.searchSavedPackagesByUserId).toHaveBeenCalledWith(
		env.APP_DB,
		{
			userId: 'stable-user-1',
			query: 'discord',
			hasApp: true,
			sort: 'name',
			limit: 10,
			offset: 20,
		},
	)
	expect(mockModule.getSavedPackageById).toHaveBeenCalledWith(env.APP_DB, {
		userId: 'stable-user-1',
		packageId: 'pkg-1',
	})
	expect(
		mockModule.listPackageInvocationTokensByPackageId,
	).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: 'stable-user-1',
		packageId: 'pkg-1',
	})
	const filteredPayload = await filtered.json()
	expect(filteredPayload).toMatchObject({
		ok: true,
		page: 3,
		pageSize: 10,
		query: 'discord',
		appFilter: 'with',
		sort: 'name',
		selectedPackage: {
			id: 'pkg-1',
			searchText: 'discord gateway websocket',
			tokens: [
				{
					id: 'token-1',
					name: 'Personal client',
					exportNames: ['*'],
					sources: ['personal-client'],
				},
			],
		},
	})
	expect(JSON.stringify(filteredPayload)).not.toContain('stored-hash')

	mockModule.searchSavedPackagesByUserId.mockClear()
	mockModule.getSavedPackageById.mockResolvedValue(null)
	mockModule.searchSavedPackagesByUserId.mockResolvedValue({
		items: [savedPackage],
		total: 1,
	})

	const invalid = await handler.handler({
		request: new Request(
			'https://example.com/account/packages.json?app=bogus&sort=bogus&selected=missing-package',
		),
		params: {},
	} as never)
	expect(invalid.status).toBe(200)
	expect(mockModule.searchSavedPackagesByUserId).toHaveBeenCalledWith(
		env.APP_DB,
		expect.objectContaining({ hasApp: null, sort: 'updated' }),
	)
	await expect(invalid.json()).resolves.toMatchObject({
		ok: true,
		selectedPackage: null,
		appFilter: 'all',
		sort: 'updated',
	})

	const postResponse = await handler.handler({
		request: new Request('https://example.com/account/packages.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'anything' }),
		}),
		params: {},
	} as never)
	expect(postResponse.status).toBe(400)

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null as never)
	const unauthorizedResponse = await handler.handler({
		request: new Request('https://example.com/account/packages.json'),
		params: {},
	} as never)
	expect(unauthorizedResponse.status).toBe(401)
})

test('packages API creates, updates, revokes, reinstates, and deletes package tokens', async () => {
	resetTokenMocks()
	mockModule.searchSavedPackagesByUserId.mockResolvedValue({
		items: [savedPackage],
		total: 1,
	})
	mockModule.getSavedPackageById.mockResolvedValue(savedPackage)
	const env = createEnv()
	const handler = createAccountPackagesApiHandler(env)

	const createResponse = await handler.handler({
		request: new Request('https://example.com/account/packages.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'create-token',
				packageId: 'pkg-1',
				name: 'Personal automation',
				rawToken: 'raw-personal-client-token',
				exportNames: ['*'],
				sources: ['personal-client'],
			}),
		}),
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
			packageId: 'pkg-1',
			name: 'Personal automation',
			tokenHash: 'hashed-raw-token',
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

	const missingExportResponse = await handler.handler({
		request: new Request('https://example.com/account/packages.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'create-token',
				packageId: 'pkg-1',
				name: 'Bad scope',
				rawToken: 'raw-token',
			}),
		}),
		params: {},
	} as never)
	expect(missingExportResponse.status).toBe(400)
	await expect(missingExportResponse.json()).resolves.toEqual({
		ok: false,
		error: 'Choose at least one export scope.',
	})

	const updateResponse = await handler.handler({
		request: new Request('https://example.com/account/packages.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'update-token',
				packageId: 'pkg-1',
				id: 'token-1',
				name: 'Updated personal client',
				exportNames: ['dispatch-message-created'],
				sources: ['updated-client'],
				tokenHash: 'should-not-be-read',
			}),
		}),
		params: {},
	} as never)

	expect(updateResponse.status).toBe(200)
	expect(mockModule.hashPackageInvocationBearerToken).toHaveBeenCalledTimes(1)
	expect(mockModule.updatePackageInvocationToken).toHaveBeenNthCalledWith(1, {
		db: env.APP_DB,
		userId: 'stable-user-1',
		packageId: 'pkg-1',
		id: 'token-1',
		name: 'Updated personal client',
		tokenHash: undefined,
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
		request: new Request('https://example.com/account/packages.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'update-token',
				packageId: 'pkg-1',
				id: 'token-1',
				name: 'Rotated personal client',
				rawToken: 'replacement-raw-token',
				exportNames: ['dispatch-message-created'],
				sources: ['rotated-client'],
			}),
		}),
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
		packageId: 'pkg-1',
		id: 'token-1',
		name: 'Rotated personal client',
		tokenHash: 'hashed-raw-token',
		exportNames: ['./dispatch-message-created'],
		sources: ['rotated-client'],
	})

	const revokeResponse = await handler.handler({
		request: new Request('https://example.com/account/packages.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'revoke-token',
				packageId: 'pkg-1',
				id: 'token-1',
			}),
		}),
		params: {},
	} as never)
	expect(revokeResponse.status).toBe(200)
	expect(mockModule.revokePackageInvocationToken).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: 'stable-user-1',
		packageId: 'pkg-1',
		id: 'token-1',
	})

	const reinstateResponse = await handler.handler({
		request: new Request('https://example.com/account/packages.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'reinstate-token',
				packageId: 'pkg-1',
				id: 'token-1',
			}),
		}),
		params: {},
	} as never)
	expect(reinstateResponse.status).toBe(200)
	expect(mockModule.reinstatePackageInvocationToken).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: 'stable-user-1',
		packageId: 'pkg-1',
		id: 'token-1',
	})
	await expect(reinstateResponse.json()).resolves.toMatchObject({
		ok: true,
		selectedTokenId: 'token-1',
	})

	const deleteResponse = await handler.handler({
		request: new Request('https://example.com/account/packages.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'delete-token',
				packageId: 'pkg-1',
				id: 'token-1',
			}),
		}),
		params: {},
	} as never)
	expect(deleteResponse.status).toBe(200)
	expect(mockModule.deletePackageInvocationToken).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: 'stable-user-1',
		packageId: 'pkg-1',
		id: 'token-1',
	})
	const deletePayload = await deleteResponse.json()
	expect(deletePayload).toMatchObject({ ok: true })
	expect(deletePayload).not.toHaveProperty('selectedTokenId')
})
