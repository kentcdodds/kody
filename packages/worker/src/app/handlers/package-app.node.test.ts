import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	captureException: vi.fn(),
	getSentryClient: vi.fn(() => ({
		getOptions: () => ({ dsn: 'https://dsn' }),
	})),
	isSentryInitialized: vi.fn(() => true),
	sentryScope: {
		setLevel: vi.fn(),
		setTag: vi.fn(),
		setContext: vi.fn(),
	},
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

vi.mock('@sentry/cloudflare', () => ({
	isInitialized: (...args: Array<unknown>) =>
		mockModule.isSentryInitialized(...args),
	getClient: (...args: Array<unknown>) => mockModule.getSentryClient(...args),
	withScope: (callback: (scope: typeof mockModule.sentryScope) => void) =>
		callback(mockModule.sentryScope),
	captureException: (...args: Array<unknown>) =>
		mockModule.captureException(...args),
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
		connect: (...args: Array<unknown>) =>
			mockModule.packageRealtimeConnect(...args),
	}),
}))

const { handlePackageAppRequest } = await import('./package-app.ts')

function resetMocks() {
	vi.clearAllMocks()
}

test('handlePackageAppRequest reports host setup failures with helpful responses and Sentry context', async () => {
	resetMocks()

	const response = await handlePackageAppRequest(
		new Request('https://example.com/packages/example/report?tab=errors'),
		{} as Env,
	)

	expect(response.status).toBe(500)
	expect(response.headers.get('content-type')).toContain('text/html')
	const body = await response.text()
	expect(body).toContain('Package app could not be prepared')
	expect(body).toContain('@kody/example')
	expect(body).toContain('/packages/example/report')
	expect(mockModule.captureException).toHaveBeenCalledTimes(1)
	expect(mockModule.captureException).toHaveBeenCalledWith(expect.any(Error))
	expect(mockModule.sentryScope.setLevel).toHaveBeenCalledWith('error')
	expect(mockModule.sentryScope.setTag).toHaveBeenCalledWith(
		'package_app.phase',
		'host-setup',
	)
	expect(mockModule.sentryScope.setTag).toHaveBeenCalledWith(
		'package_app.kody_id',
		'example',
	)
	expect(mockModule.sentryScope.setTag).toHaveBeenCalledWith(
		'package_app.package_id',
		'package-1',
	)
	expect(mockModule.sentryScope.setTag).toHaveBeenCalledWith(
		'package_app.source_id',
		'source-1',
	)
	expect(mockModule.sentryScope.setTag).not.toHaveBeenCalledWith(
		'package_app.forwarded_path',
		expect.any(String),
	)
	expect(mockModule.sentryScope.setTag).not.toHaveBeenCalledWith(
		'package_app.realtime_path',
		expect.any(String),
	)
	expect(mockModule.sentryScope.setTag).not.toHaveBeenCalledWith(
		'package_app.host_path',
		expect.any(String),
	)
	expect(mockModule.sentryScope.setContext).toHaveBeenCalledWith(
		'package_app',
		expect.objectContaining({
			phase: 'host-setup',
			kodyId: 'example',
			packageId: 'package-1',
			packageName: '@kody/example',
			sourceId: 'source-1',
			forwardedPath: '/report',
			hostPath: '/packages/example/report',
		}),
	)

	const apiResponse = await handlePackageAppRequest(
		new Request('https://example.com/packages/example/api/data', {
			headers: { accept: 'application/json' },
		}),
		{} as Env,
	)

	expect(apiResponse.status).toBe(500)
	await expect(apiResponse.json()).resolves.toEqual({
		error: 'Package app could not be prepared',
		message:
			'Kody could not load or prepare this package app runtime before your request reached the package code.',
		next_step:
			'This has been reported to Kody. Try again shortly, or ask the package owner to republish the package if it keeps happening.',
		package: {
			name: '@kody/example',
			kody_id: 'example',
		},
		request_path: '/packages/example/api/data',
	})
})

test('handlePackageAppRequest does not report package entrypoint failures to Kody Sentry', async () => {
	resetMocks()

	mockModule.loadPackageSourceBySourceId.mockResolvedValueOnce({
		source: {
			published_commit: 'commit-1',
			manifest_path: 'package.json',
			source_root: '/',
		},
		files: {
			'package.json': JSON.stringify({
				name: '@kody/example',
				kody: { id: 'example', app: { entry: 'app.js' } },
			}),
			'app.js': 'export default {}',
		},
	})
	mockModule.buildPackageAppWorker.mockResolvedValueOnce({
		entrypointName: 'entry',
		stub: {
			getEntrypoint: () => ({
				async fetch() {
					throw new Error('package code failed')
				},
			}),
		},
	})

	const response = await handlePackageAppRequest(
		new Request('https://example.com/packages/example'),
		{} as Env,
	)

	expect(response.status).toBe(500)
	const body = await response.text()
	expect(body).toContain('Package app crashed')
	expect(body).toContain('its own request handler failed')
	expect(body).toContain('package runtime debug runs')
	expect(mockModule.captureException).not.toHaveBeenCalled()
})

test('handlePackageAppRequest routes websocket package paths to realtime session manager', async () => {
	resetMocks()

	const request = new Request('https://example.com/packages/example/ws/chat', {
		headers: {
			Upgrade: 'websocket',
		},
	})

	const response = await handlePackageAppRequest(request, {} as Env)

	expect(response.status).toBe(200)
	expect(mockModule.packageRealtimeConnect).toHaveBeenCalledTimes(1)
	expect(mockModule.packageRealtimeConnect).toHaveBeenCalledWith(
		request,
		'chat',
	)
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()
})

test('handlePackageAppRequest routes websocket paths to realtime session manager when explicitKodyId is provided', async () => {
	resetMocks()

	const request = new Request('https://example.com/ws/chat', {
		headers: {
			Upgrade: 'websocket',
		},
	})

	const response = await handlePackageAppRequest(request, {} as Env, 'example')

	expect(response.status).toBe(200)
	expect(mockModule.packageRealtimeConnect).toHaveBeenCalledTimes(1)
	expect(mockModule.packageRealtimeConnect).toHaveBeenCalledWith(
		request,
		'chat',
	)
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()
})

test('handlePackageAppRequest preserves root forwarding for non-websocket explicitKodyId requests', async () => {
	resetMocks()

	mockModule.loadPackageSourceBySourceId.mockResolvedValueOnce({
		source: {
			published_commit: 'commit-1',
			manifest_path: 'package.json',
			source_root: '/',
		},
		files: {
			'package.json': JSON.stringify({
				name: '@kody/example',
				kody: { id: 'example', app: { entry: 'app.js' } },
			}),
			'app.js': 'export default {}',
		},
	})
	const entrypointFetch = vi.fn(async (forwardedRequest: Request) => {
		return Response.json({ pathname: new URL(forwardedRequest.url).pathname })
	})
	mockModule.buildPackageAppWorker.mockResolvedValueOnce({
		entrypointName: 'entry',
		stub: {
			getEntrypoint: () => ({
				fetch: entrypointFetch,
			}),
		},
	})

	const response = await handlePackageAppRequest(
		new Request('https://example.com/custom/path'),
		{} as Env,
		'example',
	)

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({ pathname: '/' })
	expect(entrypointFetch).toHaveBeenCalledTimes(1)
})
