import { base64ToBytes, bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	resolvePackageOwnerContext: vi.fn(),
	servePackageAppRequest: vi.fn(),
	findPlainRepoPromotionHint: vi.fn(),
	getPackageAppBaseUrl: vi.fn(() => 'https://apps.example.com'),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
}))

vi.mock('#worker/package-registry/package-owner.ts', () => ({
	packageScopeInputDescription: 'package scope',
	resolvePackageOwnerContext: (...args: Array<unknown>) =>
		mockModule.resolvePackageOwnerContext(...args),
}))

vi.mock('#worker/repo/user-repos.ts', () => ({
	findPlainRepoPromotionHint: (...args: Array<unknown>) =>
		mockModule.findPlainRepoPromotionHint(...args),
	buildPlainRepoPromotionErrorMessage: (lookup: string) =>
		`Promote plain repo before package lookup (${lookup}).`,
}))

vi.mock('#worker/app-base-url.ts', () => ({
	getPackageAppBaseUrl: (...args: Array<unknown>) =>
		mockModule.getPackageAppBaseUrl(...args),
}))

vi.mock('#worker/package-runtime/package-app-serve.ts', () => ({
	parsePackageAppPath: (pathname: string) => {
		const match = pathname.match(/^\/@([^/]+)\/packages\/([^/]+)(\/.*)?$/)
		if (!match) return null
		return {
			username: decodeURIComponent(match[1] ?? ''),
			kodyId: decodeURIComponent(match[2] ?? ''),
			restPath: match[3] || '/',
		}
	},
	servePackageAppRequest: (...args: Array<unknown>) =>
		mockModule.servePackageAppRequest(...args),
}))

const { packageAppFetchCapability } = await import('./package-app-fetch.ts')

function createContext(input?: {
	packageId?: string
	appId?: string
	storageId?: string
	executionOrigin?: 'interactive' | 'background'
}) {
	mockModule.resolvePackageOwnerContext.mockResolvedValue({
		ownerUserId: 'user-1',
		ownerScope: 'kody',
		ownerEmail: 'kody@example.com',
		actorUserId: 'user-1',
		delegated: false,
	})
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			executionOrigin: input?.executionOrigin ?? 'interactive',
			user: {
				userId: 'user-1',
				email: 'kody@example.com',
				displayName: 'Kody',
				username: 'kody',
			},
			storageContext:
				input?.packageId || input?.appId || input?.storageId
					? {
							sessionId: null,
							appId: input.appId ?? null,
							packageId: input.packageId ?? null,
							storageId: input.storageId ?? null,
						}
					: null,
		}),
	}
}

function savedPackage(overrides?: { hasApp?: boolean }) {
	return {
		id: 'package-1',
		userId: 'user-1',
		name: '@kody/demo-app',
		kodyId: 'demo-app',
		description: 'Demo app',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: overrides?.hasApp ?? true,
		hidden: false,
		isPrivate: false,
		createdAt: '2026-08-08T00:00:00.000Z',
		updatedAt: '2026-08-08T00:00:00.000Z',
	}
}

test('package_app_fetch dispatches synthetic in-process app requests against hosted URLs', async () => {
	mockModule.getSavedPackageByKodyId.mockResolvedValue(savedPackage())
	mockModule.servePackageAppRequest.mockResolvedValue(
		new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: {
				'content-type': 'application/json',
				'content-length': '999',
			},
		}),
	)

	const result = await packageAppFetchCapability.handler(
		{
			kody_id: 'demo-app',
			path: '/api/health',
			method: 'GET',
			headers: {
				Host: 'forged.example.com',
				'CF-Ray': 'forged',
				'X-Forwarded-For': '127.0.0.1',
				Origin: 'https://caller.example.com',
				'X-Test': 'kept',
			},
		},
		createContext(),
	)

	expect(result).toEqual({
		status: 200,
		headers: { 'content-type': 'application/json' },
		body: '{"ok":true}',
		truncated: false,
	})
	expect(mockModule.servePackageAppRequest).toHaveBeenCalledWith(
		expect.objectContaining({
			dispatch: { synthetic: true },
			owner: expect.objectContaining({
				userId: 'user-1',
				username: 'kody',
			}),
			packagePath: {
				username: 'kody',
				kodyId: 'demo-app',
				restPath: '/api/health',
			},
		}),
	)
	const request = mockModule.servePackageAppRequest.mock.calls[0]?.[0]?.request
	expect(request).toBeInstanceOf(Request)
	expect(request.url).toBe(
		'https://apps.example.com/@kody/packages/demo-app/api/health',
	)
	expect(request.headers.get('Host')).toBeNull()
	expect(request.headers.get('CF-Ray')).toBeNull()
	expect(request.headers.get('X-Forwarded-For')).toBeNull()
	expect(request.headers.get('Origin')).toBe('https://caller.example.com')
	expect(request.headers.get('X-Test')).toBe('kept')
})

test('package_app_fetch resolves owned packages by package_id', async () => {
	mockModule.getSavedPackageById.mockResolvedValue(savedPackage())
	mockModule.servePackageAppRequest.mockResolvedValue(
		new Response('ok', { status: 200 }),
	)

	const result = await packageAppFetchCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)

	expect(result).toEqual({
		status: 200,
		headers: { 'content-type': 'text/plain;charset=UTF-8' },
		body: 'ok',
		truncated: false,
	})
	expect(mockModule.getSavedPackageById).toHaveBeenCalledWith(
		{},
		{ userId: 'user-1', packageId: 'package-1' },
	)
	expect(mockModule.getSavedPackageByKodyId).not.toHaveBeenCalled()
})

test('package_app_fetch rejects invalid callers, paths, and missing packages', async () => {
	await expect(
		packageAppFetchCapability.handler({}, createContext()),
	).rejects.toThrow('Provide exactly one of `package_id` or `kody_id`.')
	await expect(
		packageAppFetchCapability.handler(
			{ package_id: 'package-1', kody_id: 'demo-app' },
			createContext(),
		),
	).rejects.toThrow('Provide exactly one of `package_id` or `kody_id`.')

	await expect(
		packageAppFetchCapability.handler(
			{ kody_id: 'demo-app' },
			createContext({ packageId: 'package-1' }),
		),
	).rejects.toThrow(
		'package_app_fetch is unavailable from package runtime contexts.',
	)
	await expect(
		packageAppFetchCapability.handler(
			{ kody_id: 'demo-app' },
			createContext({ executionOrigin: 'background' }),
		),
	).rejects.toThrow(
		'package_app_fetch is unavailable from package runtime contexts.',
	)

	mockModule.getSavedPackageByKodyId.mockResolvedValue(savedPackage())
	await expect(
		packageAppFetchCapability.handler(
			{
				kody_id: 'demo-app',
				headers: { Upgrade: 'websocket' },
			},
			createContext(),
		),
	).rejects.toThrow(
		'package_app_fetch does not support websocket Upgrade requests.',
	)
	await expect(
		packageAppFetchCapability.handler(
			{ kody_id: 'demo-app', path: '/../other-package/probe' },
			createContext(),
		),
	).rejects.toThrow(
		'package_app_fetch path must not contain parent traversal segments.',
	)
	await expect(
		packageAppFetchCapability.handler(
			{
				kody_id: 'demo-app',
				method: 'POST',
				body: 'x'.repeat(102_401),
			},
			createContext(),
		),
	).rejects.toThrow('request body exceeds 102400 bytes')
	expect(mockModule.servePackageAppRequest).not.toHaveBeenCalled()

	mockModule.getSavedPackageByKodyId.mockResolvedValue(null)
	mockModule.findPlainRepoPromotionHint.mockResolvedValue(null)
	await expect(
		packageAppFetchCapability.handler({ kody_id: 'missing' }, createContext()),
	).rejects.toThrow('Saved package not found for this user.')

	mockModule.findPlainRepoPromotionHint.mockResolvedValue({ id: 'repo-1' })
	await expect(
		packageAppFetchCapability.handler({ kody_id: 'missing' }, createContext()),
	).rejects.toThrow('Promote plain repo before package lookup')

	mockModule.getSavedPackageByKodyId.mockResolvedValue(
		savedPackage({ hasApp: false }),
	)
	await expect(
		packageAppFetchCapability.handler({ kody_id: 'demo-app' }, createContext()),
	).rejects.toThrow('has no declared app')
})

test('package_app_fetch truncates oversized bodies and encodes binary as base64', async () => {
	mockModule.getSavedPackageByKodyId.mockResolvedValue(savedPackage())
	const oversized = 'x'.repeat(102_401)
	mockModule.servePackageAppRequest.mockResolvedValue(
		new Response(oversized, {
			status: 200,
			headers: { 'content-type': 'text/plain' },
		}),
	)

	await expect(
		packageAppFetchCapability.handler({ kody_id: 'demo-app' }, createContext()),
	).resolves.toEqual({
		status: 200,
		headers: { 'content-type': 'text/plain' },
		body: 'x'.repeat(102_400),
		truncated: true,
	})

	const binary = new TextEncoder().encode('valid utf-8 binary bytes')
	mockModule.servePackageAppRequest.mockResolvedValue(
		new Response(binary, {
			status: 200,
			headers: { 'content-type': 'application/octet-stream' },
		}),
	)
	await expect(
		packageAppFetchCapability.handler({ kody_id: 'demo-app' }, createContext()),
	).resolves.toEqual({
		status: 200,
		headers: { 'content-type': 'application/octet-stream' },
		body: bytesToBase64(binary),
		truncated: false,
	})

	const largeBinary = new TextEncoder().encode('b'.repeat(102_400))
	mockModule.servePackageAppRequest.mockResolvedValue(
		new Response(largeBinary, {
			status: 200,
			headers: { 'content-type': 'application/octet-stream' },
		}),
	)
	const capped = await packageAppFetchCapability.handler(
		{ kody_id: 'demo-app' },
		createContext(),
	)
	const decoded = base64ToBytes(capped.body)
	expect(decoded).toEqual(largeBinary.slice(0, decoded.byteLength))
	expect(capped.body.length).toBeLessThanOrEqual(102_400)
	expect(capped.truncated).toBe(true)
})
