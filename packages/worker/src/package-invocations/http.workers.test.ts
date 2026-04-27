import { expect, test, vi } from 'vitest'
import type * as PackageInvocationServiceModule from './service.ts'
import {
	handlePackageInvocationApiRequest,
	isPackageInvocationApiRequest,
} from './http.ts'
import { hashPackageInvocationBearerToken } from './repo.ts'

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

async function createEnv(
	options: {
		tokenRow?: {
			package_ids_json?: string
			package_kody_ids_json?: string
			export_names_json?: string
			sources_json?: string
			revoked_at?: string | null
		}
		touchChanges?: number
	} = {},
) {
	const tokenRows = [
		{
			id: 'discord-gateway',
			user_id: 'user-123',
			token_hash: await hashPackageInvocationBearerToken('private-token-123'),
			name: 'Discord gateway',
			email: 'me@example.com',
			display_name: 'me',
			package_ids_json: options.tokenRow?.package_ids_json ?? '[]',
			package_kody_ids_json:
				options.tokenRow?.package_kody_ids_json ??
				JSON.stringify(['discord-gateway']),
			export_names_json:
				options.tokenRow?.export_names_json ??
				JSON.stringify(['./dispatch-message-created']),
			sources_json:
				options.tokenRow?.sources_json ?? JSON.stringify(['discord-gateway']),
			created_at: '2026-04-27T00:00:00.000Z',
			updated_at: '2026-04-27T00:00:00.000Z',
			last_used_at: null,
			revoked_at: options.tokenRow?.revoked_at ?? null,
		},
	]
	return {
		APP_DB: {
			prepare(query: string) {
				return {
					bind(...params: Array<unknown>) {
						return {
							async first<T = Record<string, unknown>>() {
								if (query.includes('FROM package_invocation_tokens')) {
									const tokenHash = String(params[0] ?? '')
									return (tokenRows.find(
										(row) =>
											row.token_hash === tokenHash && row.revoked_at === null,
									) ?? null) as T | null
								}
								return null
							},
							async run() {
								if (query.includes('UPDATE package_invocation_tokens')) {
									const id = String(params[2] ?? '')
									const row = tokenRows.find(
										(entry) => entry.id === id && entry.revoked_at === null,
									)
									if (!row) {
										return { meta: { changes: 0, last_row_id: 0 } }
									}
									if (options.touchChanges !== undefined) {
										return {
											meta: {
												changes: options.touchChanges,
												last_row_id: 0,
											},
										}
									}
									row.last_used_at = String(params[0])
									row.updated_at = String(params[1])
									return { meta: { changes: 1, last_row_id: 0 } }
								}
								return { meta: { changes: 0, last_row_id: 0 } }
							},
						}
					},
				}
			},
		} as unknown as D1Database,
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
		await createEnv(),
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
		await createEnv(),
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

test('package invocation API fails closed when token touch loses revocation race', async () => {
	const response = await handlePackageInvocationApiRequest(
		new Request(
			'https://example.com/api/package-invocations/discord-gateway/dispatch-message-created',
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer private-token-123',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ idempotencyKey: 'evt-1' }),
			},
		),
		await createEnv({ touchChanges: 0 }),
	)

	expect(response.status).toBe(401)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: {
			code: 'unauthorized',
			message: 'Invalid package invocation token.',
		},
	})
	expect(invocationMockModule.invokePackageExport).not.toHaveBeenCalled()
})

test('package invocation API fails closed when token scope JSON is malformed', async () => {
	const response = await handlePackageInvocationApiRequest(
		new Request(
			'https://example.com/api/package-invocations/discord-gateway/dispatch-message-created',
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer private-token-123',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ idempotencyKey: 'evt-1' }),
			},
		),
		await createEnv({
			tokenRow: {
				package_kody_ids_json: '{bad json',
			},
		}),
	)

	expect(response.status).toBe(401)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: {
			code: 'unauthorized',
			message: 'Invalid package invocation token.',
		},
	})
	expect(invocationMockModule.invokePackageExport).not.toHaveBeenCalled()
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
		await createEnv(),
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
		await createEnv(),
	)

	expect(invocationMockModule.invokePackageExport).toHaveBeenCalledWith({
		env: expect.any(Object),
		baseUrl: 'https://example.com',
		token: {
			tokenId: 'discord-gateway',
			userId: 'user-123',
			email: 'me@example.com',
			displayName: 'me',
			packageIds: [],
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
