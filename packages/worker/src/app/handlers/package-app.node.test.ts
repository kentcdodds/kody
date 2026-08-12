import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'

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
		username: 'test-user',
		email: 'user@example.com',
		displayName: 'User',
		mcpUser: {
			userId: 'user-1',
			email: 'user@example.com',
			username: 'test-user',
			displayName: 'User',
		},
	})),
	redirectToLogin: vi.fn(() => new Response(null, { status: 302 })),
	getAppBaseUrl: vi.fn(() => 'https://example.com'),
	resolveSavedPackage: vi.fn(async () => ({
		id: 'package-1',
		userId: 'user-1',
		name: '@kody/example',
		kodyId: 'example',
		description: 'Example package',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: true,
		hidden: false,
		isPrivate: false,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	})),
	loadPackageSourceBySourceId: vi.fn(async () => {
		throw new Error('bundle failed')
	}),
	loadInvokeManifestBySourceId: vi.fn(async () => {
		throw new Error('manifest load failed')
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

vi.mock('#worker/app-base-url.ts', () => ({
	getAppBaseUrl: (...args: Array<unknown>) => mockModule.getAppBaseUrl(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackage(...args),
	loadInvokeManifestBySourceId: (...args: Array<unknown>) =>
		mockModule.loadInvokeManifestBySourceId(...args),
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
const nonProductionEnv = { SENTRY_ENVIRONMENT: 'test' } as Env

function resetMocks() {
	vi.clearAllMocks()
}

test('handlePackageAppRequest reports host setup failures with helpful responses and Sentry context', async () => {
	resetMocks()
	consoleError.mockImplementation(() => {})

	const response = await handlePackageAppRequest(
		new Request(
			'https://example.com/@test-user/packages/example/report?tab=errors',
		),
		nonProductionEnv,
	)

	expect(response.status).toBe(500)
	expect(response.headers.get('content-type')).toContain('text/html')
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
			hostPath: '/@test-user/packages/example/report',
		}),
	)

	const apiResponse = await handlePackageAppRequest(
		new Request('https://example.com/@test-user/packages/example/api/data', {
			headers: { accept: 'application/json' },
		}),
		nonProductionEnv,
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
		request_path: '/@test-user/packages/example/api/data',
	})
	// Both host-setup failures are logged for operators.
	expect(consoleError).toHaveBeenCalledTimes(2)
	expect(consoleError).toHaveBeenCalledWith(
		expect.any(String),
		expect.any(Error),
	)
})

test('handlePackageAppRequest does not report package entrypoint failures to Kody Sentry', async () => {
	resetMocks()
	consoleError.mockImplementation(() => {})

	mockModule.loadInvokeManifestBySourceId.mockResolvedValueOnce({
		source: {
			published_commit: 'commit-1',
			manifest_path: 'package.json',
			source_root: '/',
		},
		manifest: {
			name: '@kody/example',
			kody: { id: 'example', app: { entry: 'app.js' } },
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
		new Request('https://example.com/@test-user/packages/example'),
		nonProductionEnv,
	)

	expect(response.status).toBe(500)
	expect(mockModule.captureException).not.toHaveBeenCalled()
	// The entrypoint failure is still logged even though it is not
	// reported to Kody Sentry.
	expect(consoleError).toHaveBeenCalledWith(
		expect.any(String),
		expect.any(Error),
	)
})

test('handlePackageAppRequest routes websocket package paths to realtime session manager without owner credentials', async () => {
	resetMocks()

	const request = new Request(
		'https://example.com/@test-user/packages/example/ws/chat',
		{
			headers: {
				Upgrade: 'websocket',
				Cookie: 'kody_session=owner-session',
				Authorization: 'Bearer owner-token',
				'X-Kody-Connector-User-Id': 'user-1',
				'X-Custom-Package-Header': 'kept',
			},
		},
	)

	const response = await handlePackageAppRequest(request, nonProductionEnv)

	expect(response.status).toBe(200)
	expect(mockModule.packageRealtimeConnect).toHaveBeenCalledTimes(1)
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()

	// The realtime connect hook receives the upgrade request headers, so the
	// owner's credentials must already be gone by this point.
	const [connectRequest, facet] = mockModule.packageRealtimeConnect.mock
		.calls[0] as [Request, string]
	expect(facet).toBe('chat')
	expect(connectRequest.url).toBe(request.url)
	expect(connectRequest.headers.get('Cookie')).toBeNull()
	expect(connectRequest.headers.get('Authorization')).toBeNull()
	expect(connectRequest.headers.get('X-Kody-Connector-User-Id')).toBeNull()
	expect(connectRequest.headers.get('X-Custom-Package-Header')).toBe('kept')
})

test('handlePackageAppRequest forwards package code a request stripped of owner credentials', async () => {
	resetMocks()

	mockModule.loadInvokeManifestBySourceId.mockResolvedValueOnce({
		source: {
			published_commit: 'commit-1',
			manifest_path: 'package.json',
			source_root: '/',
		},
		manifest: {
			name: '@kody/example',
			kody: { id: 'example', app: { entry: 'app.js' } },
		},
	})
	const forwardedRequests: Array<Request> = []
	mockModule.buildPackageAppWorker.mockResolvedValueOnce({
		entrypointName: 'entry',
		stub: {
			getEntrypoint: () => ({
				async fetch(forwarded: Request) {
					forwardedRequests.push(forwarded)
					return new Response('ok')
				},
			}),
		},
	})

	const response = await handlePackageAppRequest(
		new Request('https://example.com/@test-user/packages/example/notes?tab=1', {
			method: 'POST',
			headers: {
				Cookie: 'kody_session=owner-session',
				Authorization: 'Bearer owner-token',
				'X-Kody-Connector-Session-Key': 'internal',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ note: 'hello' }),
		}),
		nonProductionEnv,
	)

	expect(response.status).toBe(200)
	const forwardedRequest = forwardedRequests[0]
	expect(forwardedRequest).toBeDefined()
	if (!forwardedRequest) return
	// Package code sees its own path and body, never the owner's credentials.
	expect(new URL(forwardedRequest.url).pathname).toBe('/notes')
	expect(new URL(forwardedRequest.url).search).toBe('?tab=1')
	expect(forwardedRequest.headers.get('Cookie')).toBeNull()
	expect(forwardedRequest.headers.get('Authorization')).toBeNull()
	expect(
		forwardedRequest.headers.get('X-Kody-Connector-Session-Key'),
	).toBeNull()
	expect(forwardedRequest.headers.get('Content-Type')).toBe('application/json')
	await expect(forwardedRequest.json()).resolves.toEqual({ note: 'hello' })
})

test('handlePackageAppRequest returns not found when the URL username does not match the signed-in user', async () => {
	resetMocks()

	const response = await handlePackageAppRequest(
		new Request('https://example.com/@other-user/packages/example'),
		nonProductionEnv,
	)

	expect(response.status).toBe(404)
	expect(mockModule.resolveSavedPackage).not.toHaveBeenCalled()
})
