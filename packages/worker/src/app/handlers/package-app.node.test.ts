import { expect, test, vi } from 'vitest'
import type * as AuthRedirect from '#app/auth-redirect.ts'
import type * as AuthenticatedUser from '#app/authenticated-user.ts'
import type * as AppBaseUrl from '#worker/app-base-url.ts'
import type * as ModuleArtifacts from '#worker/package-invocations/module-artifacts.ts'
import type * as PackageSource from '#worker/package-registry/source.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'

// Handler tests exercise the local construction path. Slim-origin forward
// coverage lives in package-app-serve-slim-origin.node.test.ts.
vi.mock('#worker/runtime-worker-service.ts', () => ({
	hasLocalPackageAppRuntimeBridge: () => true,
	getRuntimeWorkerService: () => null,
	requireLocalPackageAppRuntimeBridge: () => {
		throw new Error(
			'requireLocalPackageAppRuntimeBridge should not run when buildPackageAppWorker is mocked',
		)
	},
	packageAppRuntimeBridgeMissingMessage: 'bridge-missing',
	packageAppRuntimeForwardUnavailableMessage: 'forward-unavailable',
}))

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
	readAuthenticatedAppUser: vi.fn(
		async (
			..._args: Parameters<typeof AuthenticatedUser.readAuthenticatedAppUser>
		) => ({
			username: 'test-user',
			email: 'user@example.com',
			displayName: 'User',
			mcpUser: {
				userId: 'user-1',
				email: 'user@example.com',
				username: 'test-user',
				displayName: 'User',
			},
		}),
	),
	redirectToLogin: vi.fn(
		(..._args: Parameters<typeof AuthRedirect.redirectToLogin>) =>
			new Response(null, { status: 302 }),
	),
	getAppBaseUrl: vi.fn(
		(..._args: Parameters<typeof AppBaseUrl.getAppBaseUrl>) =>
			'https://example.com',
	),
	resolveSavedPackage: vi.fn<typeof ModuleArtifacts.resolveSavedPackage>(
		async () => ({
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
			lockedAt: null,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		}),
	),
	loadPackageSourceBySourceId: vi.fn<
		typeof PackageSource.loadPackageSourceBySourceId
	>(async () => {
		throw new Error('bundle failed')
	}),
	loadInvokeManifestBySourceId: vi.fn<
		(
			...args: Parameters<typeof ModuleArtifacts.loadInvokeManifestBySourceId>
		) => Promise<unknown>
	>(async () => {
		throw new Error('manifest load failed')
	}),
	createPackageAppCallerContext: vi.fn(),
	buildPackageAppWorker: vi.fn(),
	packageRealtimeConnect: vi.fn(
		async (_request: Request, _facet?: string | null) =>
			new Response(JSON.stringify({ ok: true }), { status: 200 }),
	),
}))

vi.mock('@sentry/cloudflare', () => ({
	isInitialized: () => mockModule.isSentryInitialized(),
	getClient: () => mockModule.getSentryClient(),
	withScope: (callback: (scope: typeof mockModule.sentryScope) => void) =>
		callback(mockModule.sentryScope),
	captureException: (...args: Array<unknown>) =>
		mockModule.captureException(...args),
	instrumentDurableObjectWithSentry: (
		_getOptions: unknown,
		durableObjectClass: unknown,
	) => durableObjectClass,
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof AuthenticatedUser.readAuthenticatedAppUser>
	) => mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/auth-redirect.ts', () => ({
	redirectToLogin: (...args: Parameters<typeof AuthRedirect.redirectToLogin>) =>
		mockModule.redirectToLogin(...args),
}))

vi.mock('#worker/app-base-url.ts', () => ({
	getAppBaseUrl: (...args: Parameters<typeof AppBaseUrl.getAppBaseUrl>) =>
		mockModule.getAppBaseUrl(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (
		...args: Parameters<typeof PackageSource.loadPackageSourceBySourceId>
	) => mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: (
		...args: Parameters<typeof ModuleArtifacts.resolveSavedPackage>
	) => mockModule.resolveSavedPackage(...args),
	loadInvokeManifestBySourceId: (
		...args: Parameters<typeof ModuleArtifacts.loadInvokeManifestBySourceId>
	) => mockModule.loadInvokeManifestBySourceId(...args),
}))

vi.mock('#worker/package-runtime/package-app.ts', () => ({
	createPackageAppCallerContext: (...args: Array<unknown>) =>
		mockModule.createPackageAppCallerContext(...args),
	buildPackageAppWorker: (...args: Array<unknown>) =>
		mockModule.buildPackageAppWorker(...args),
}))

vi.mock('#worker/package-runtime/realtime-session.ts', () => ({
	packageRealtimeSessionRpc: (..._args: Array<unknown>) => ({
		connect: (...args: [request: Request, facet?: string | null]) =>
			mockModule.packageRealtimeConnect(...args),
	}),
}))

const { handlePackageAppRequest } = await import('./package-app.ts')
const nonProductionEnv = { SENTRY_ENVIRONMENT: 'test' } as unknown as Env

function servePackageEntrypoint(
	fetch: (request: Request) => Promise<Response>,
) {
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
		stub: { getEntrypoint: () => ({ fetch }) },
	})
}

function request(path: string, init?: RequestInit) {
	return handlePackageAppRequest(
		new Request(`https://example.com${path}`, init),
		nonProductionEnv,
	)
}

function headersPresent(request: Request, names: Array<string>) {
	return names.filter((name) => request.headers.has(name))
}

test('handlePackageAppRequest reports host setup failures with helpful responses and Sentry context', async () => {
	consoleError.mockImplementation(() => {})

	const response = await request(
		'/@test-user/packages/example/report?tab=errors',
	)
	expect(response.status).toBe(500)
	expect(response.headers.get('content-type')).toContain('text/html')
	expect(mockModule.captureException).toHaveBeenCalledTimes(1)
	expect(mockModule.captureException).toHaveBeenCalledWith(expect.any(Error))
	expect(mockModule.sentryScope.setLevel).toHaveBeenCalledWith('error')
	const tags = Object.fromEntries(
		mockModule.sentryScope.setTag.mock.calls as Array<[string, unknown]>,
	)
	expect(tags).toMatchObject({
		'package_app.phase': 'host-setup',
		'package_app.kody_id': 'example',
		'package_app.package_id': 'package-1',
		'package_app.source_id': 'source-1',
	})
	expect(
		[
			'package_app.forwarded_path',
			'package_app.realtime_path',
			'package_app.host_path',
		].filter((tag) => tag in tags),
	).toEqual([])
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

	const apiResponse = await request('/@test-user/packages/example/api/data', {
		headers: { accept: 'application/json' },
	})
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
	consoleError.mockImplementation(() => {})
	servePackageEntrypoint(async () => {
		throw new Error('package code failed')
	})

	const response = await request('/@test-user/packages/example')
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
	const response = await request('/@test-user/packages/example/ws/chat', {
		headers: {
			Upgrade: 'websocket',
			Cookie: 'kody_session=owner-session',
			Authorization: 'Bearer owner-token',
			'X-Kody-Connector-User-Id': 'user-1',
			'X-Custom-Package-Header': 'kept',
		},
	})

	expect(response.status).toBe(200)
	expect(mockModule.packageRealtimeConnect).toHaveBeenCalledTimes(1)
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()
	// The realtime connect hook receives the upgrade request headers, so the
	// owner's credentials must already be gone by this point.
	const [connectRequest, facet] = mockModule.packageRealtimeConnect.mock
		.calls[0] as [Request, string]
	expect(facet).toBe('chat')
	expect(connectRequest.url).toBe(
		'https://example.com/@test-user/packages/example/ws/chat',
	)
	expect(
		headersPresent(connectRequest, [
			'Cookie',
			'Authorization',
			'X-Kody-Connector-User-Id',
		]),
	).toEqual([])
	expect(connectRequest.headers.get('X-Custom-Package-Header')).toBe('kept')
})

test('handlePackageAppRequest accepts case-insensitive Upgrade values for realtime', async () => {
	mockModule.packageRealtimeConnect.mockClear()
	const response = await request('/@test-user/packages/example/ws', {
		headers: {
			Upgrade: 'WebSocket',
		},
	})
	expect(response.status).toBe(200)
	expect(mockModule.packageRealtimeConnect).toHaveBeenCalledTimes(1)
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()
})

test('handlePackageAppRequest forwards package code a request stripped of owner credentials', async () => {
	const forwardedRequests: Array<Request> = []
	servePackageEntrypoint(async (forwarded) => {
		forwardedRequests.push(forwarded)
		return new Response('ok')
	})

	const response = await request('/@test-user/packages/example/notes?tab=1', {
		method: 'POST',
		headers: {
			Cookie: 'kody_session=owner-session',
			Authorization: 'Bearer owner-token',
			'X-Kody-Connector-Session-Key': 'internal',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ note: 'hello' }),
	})

	expect(response.status).toBe(200)
	expect(forwardedRequests).toHaveLength(1)
	const [forwarded] = forwardedRequests as [Request]
	// Package code sees its own path and body, never the owner's credentials.
	const forwardedUrl = new URL(forwarded.url)
	expect(forwardedUrl.pathname + forwardedUrl.search).toBe('/notes?tab=1')
	expect(
		headersPresent(forwarded, [
			'Cookie',
			'Authorization',
			'X-Kody-Connector-Session-Key',
		]),
	).toEqual([])
	expect(forwarded.headers.get('Content-Type')).toBe('application/json')
	await expect(forwarded.json()).resolves.toEqual({ note: 'hello' })
})

test('handlePackageAppRequest returns not found when the URL username does not match the signed-in user', async () => {
	const response = await request('/@other-user/packages/example')
	expect(response.status).toBe(404)
	expect(mockModule.resolveSavedPackage).not.toHaveBeenCalled()
})
