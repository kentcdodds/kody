import { expect, test, vi } from 'vitest'
import type * as PackageInvocationServiceModule from './service.ts'
import {
	handlePackageInvocationApiRequest,
	isPackageInvocationApiRequest,
} from './http.ts'

const invocationMockModule = vi.hoisted(() => ({
	invokePackageExport: vi.fn(),
}))

vi.mock('./service.ts', async () => {
	const actual =
		await vi.importActual<typeof PackageInvocationServiceModule>('./service.ts')
	return {
		...actual,
		invokePackageExport: (...args: Array<unknown>) =>
			invocationMockModule.invokePackageExport(...args),
	}
})

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: {
			get: async () => null,
			put: async () => undefined,
			delete: async () => undefined,
		},
		COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
		JOB_MANAGER: {
			idFromName: () => ({ toString: () => 'job-manager-id' }),
			get: () => ({}) as DurableObjectStub,
		} as DurableObjectNamespace,
		STORAGE_RUNNER: {
			idFromName: () => ({ toString: () => 'storage-runner-id' }),
			get: () => ({}) as DurableObjectStub,
		} as DurableObjectNamespace,
		PACKAGE_REALTIME_SESSION: {
			idFromName: () => ({ toString: () => 'package-realtime-id' }),
			get: () => ({}) as DurableObjectStub,
		} as DurableObjectNamespace,
		PACKAGE_SERVICE_INSTANCE: {
			idFromName: () => ({ toString: () => 'package-service-id' }),
			get: () => ({}) as DurableObjectStub,
		} as DurableObjectNamespace,
		PACKAGE_INVOCATION_TOKENS: JSON.stringify({
			'discord-gateway': {
				token: 'private-token-123',
				userId: 'user-123',
				email: 'me@example.com',
				displayName: 'me',
				packageKodyIds: ['discord-gateway'],
				exportNames: ['./dispatch-message-created'],
				sources: ['discord-gateway'],
			},
		}),
	} as unknown as Env
}

test('isPackageInvocationApiRequest matches the external package invocation route', () => {
	expect(
		isPackageInvocationApiRequest(
			'/api/package-invocations/discord-gateway/dispatch-message-created',
		),
	).toBe(true)
	expect(isPackageInvocationApiRequest('/api/me')).toBe(false)
})

test('package invocation API returns 401 when bearer token is missing', async () => {
	const response = await handlePackageInvocationApiRequest(
		new Request(
			'https://example.com/api/package-invocations/discord-gateway/dispatch-message-created',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ idempotencyKey: 'evt-1' }),
			},
		),
		createEnv(),
	)

	expect(response.status).toBe(401)
	expect(response.headers.get('WWW-Authenticate')).toBe(
		'Bearer realm="package-invocations"',
	)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: {
			code: 'unauthorized',
			message: 'Unauthorized',
		},
	})
})

test('package invocation API returns 401 for invalid private tokens', async () => {
	const response = await handlePackageInvocationApiRequest(
		new Request(
			'https://example.com/api/package-invocations/discord-gateway/dispatch-message-created',
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer wrong-token',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ idempotencyKey: 'evt-1' }),
			},
		),
		createEnv(),
	)

	expect(response.status).toBe(401)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: {
			code: 'unauthorized',
			message: 'Invalid package invocation token.',
		},
	})
})

test('package invocation API validates the JSON body shape', async () => {
	const response = await handlePackageInvocationApiRequest(
		new Request(
			'https://example.com/api/package-invocations/discord-gateway/dispatch-message-created',
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer private-token-123',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ params: [] }),
			},
		),
		createEnv(),
	)

	expect(response.status).toBe(400)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: {
			code: 'invalid_params',
			message: 'params must be a JSON object when provided.',
		},
	})
})

test('package invocation API invokes the package export with the scoped token context', async () => {
	invocationMockModule.invokePackageExport.mockResolvedValue({
		status: 200,
		body: {
			ok: true,
			exportName: './dispatch-message-created',
			idempotency: {
				key: 'evt-1',
				replayed: false,
			},
			result: { reply: 'hello discord' },
			logs: ['ran'],
		},
	})

	const response = await handlePackageInvocationApiRequest(
		new Request(
			'https://example.com/api/package-invocations/discord-gateway/dispatch-message-created',
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer private-token-123',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					params: { content: 'hi' },
					idempotencyKey: 'evt-1',
					source: 'discord-gateway',
					topic: 'discord.message.created',
				}),
			},
		),
		createEnv(),
	)

	expect(invocationMockModule.invokePackageExport).toHaveBeenCalledWith({
		env: expect.any(Object),
		baseUrl: 'https://example.com',
		token: {
			tokenId: 'discord-gateway',
			userId: 'user-123',
			email: 'me@example.com',
			displayName: 'me',
			packageKodyIds: ['discord-gateway'],
			exportNames: ['./dispatch-message-created'],
			sources: ['discord-gateway'],
		},
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-1',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		ok: true,
		exportName: './dispatch-message-created',
		idempotency: {
			key: 'evt-1',
			replayed: false,
		},
		result: { reply: 'hello discord' },
		logs: ['ran'],
	})
})
