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

vi.mock('#worker/package-registry/repo.ts', () => ({
	searchSavedPackagesByUserId: (...args: Array<unknown>) =>
		mockModule.searchSavedPackagesByUserId(...args),
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

const { createAccountPackagesApiHandler } =
	await import('./account-packages.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		COOKIE_SECRET: 'secret',
	} as Env
}

test('packages API lists with filters, ignores invalid values, and rejects bad methods', async () => {
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
	await expect(filtered.json()).resolves.toMatchObject({
		ok: true,
		page: 3,
		pageSize: 10,
		query: 'discord',
		appFilter: 'with',
		sort: 'name',
		selectedPackage: {
			id: 'pkg-1',
			searchText: 'discord gateway websocket',
		},
	})

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
	expect(postResponse.status).toBe(405)

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null as never)
	const unauthorizedResponse = await handler.handler({
		request: new Request('https://example.com/account/packages.json'),
		params: {},
	} as never)
	expect(unauthorizedResponse.status).toBe(401)
})
