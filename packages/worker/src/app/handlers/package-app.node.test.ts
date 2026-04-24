import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(async () => ({
		email: 'user@example.com',
		displayName: 'User',
		mcpUser: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'User',
		},
	})),
	redirectToLogin: vi.fn(() => new Response(null, { status: 302 })),
	getAppBaseUrl: vi.fn(() => 'https://example.com'),
	getSavedPackageByKodyId: vi.fn(async () => ({
		id: 'package-1',
		userId: 'user-1',
		name: '@kody/example',
		kodyId: 'example',
		description: 'Example package',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: true,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	})),
	loadPackageSourceBySourceId: vi.fn(async () => {
		throw new Error('bundle failed')
	}),
	createPackageAppCallerContext: vi.fn(),
	buildPackageAppWorker: vi.fn(),
	packageRealtimeConnect: vi.fn(
		async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
	),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/auth-redirect.ts', () => ({
	redirectToLogin: (...args: Array<unknown>) =>
		mockModule.redirectToLogin(...args),
}))

vi.mock('#app/app-base-url.ts', () => ({
	getAppBaseUrl: (...args: Array<unknown>) => mockModule.getAppBaseUrl(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('#worker/package-runtime/package-app.ts', () => ({
	createPackageAppCallerContext: (...args: Array<unknown>) =>
		mockModule.createPackageAppCallerContext(...args),
	buildPackageAppWorker: (...args: Array<unknown>) =>
		mockModule.buildPackageAppWorker(...args),
}))

vi.mock('#worker/package-runtime/realtime-session.ts', () => ({
	packageRealtimeSessionRpc: (..._args: Array<unknown>) => ({
		connect: (...args: Array<unknown>) => mockModule.packageRealtimeConnect(...args),
	}),
}))

const { handlePackageAppRequest } = await import('./package-app.ts')

test('handlePackageAppRequest returns a plain 500 when package app runtime setup fails', async () => {
	const response = await handlePackageAppRequest(
		new Request('https://example.com/packages/example'),
		{} as Env,
	)

	expect(response.status).toBe(500)
	await expect(response.text()).resolves.toBe('Internal Server Error')
})

test('handlePackageAppRequest routes websocket package paths to realtime session manager', async () => {
	const request = new Request('https://example.com/packages/example/ws/chat', {
		headers: {
			Upgrade: 'websocket',
		},
	})

	const response = await handlePackageAppRequest(request, {} as Env)

	expect(response.status).toBe(200)
	expect(mockModule.packageRealtimeConnect).toHaveBeenCalledTimes(1)
	expect(mockModule.packageRealtimeConnect).toHaveBeenCalledWith(request, 'chat')
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()
})

test('handlePackageAppRequest routes websocket paths to realtime session manager when explicitKodyId is provided', async () => {
	const request = new Request('https://example.com/ws/chat', {
		headers: {
			Upgrade: 'websocket',
		},
	})

	const response = await handlePackageAppRequest(request, {} as Env, 'example')

	expect(response.status).toBe(200)
	expect(mockModule.packageRealtimeConnect).toHaveBeenCalledTimes(1)
	expect(mockModule.packageRealtimeConnect).toHaveBeenCalledWith(request, 'chat')
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()
})
