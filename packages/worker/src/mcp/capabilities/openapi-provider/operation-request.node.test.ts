import { expect, test, vi } from 'vitest'
import * as secretService from '#mcp/secrets/service.ts'
import * as usageModule from '#worker/usage/record-usage.ts'
import { type OpenApiBinding } from '#worker/openapi/binding-shared.ts'
import { executeOpenApiOperationRequest } from './operation-request.ts'

const bindingBase: OpenApiBinding = {
	name: 'widgets',
	specUrl: 'https://specs.example/openapi.json',
	apiBaseUrl: 'https://api.widgets.example',
	description: null,
	auth: { kind: 'none' },
	selection: { tags: ['widgets'] },
	includeDestructive: false,
	specTitle: 'Widgets',
	specVersion: '1',
	updatedAt: '2026-07-09T00:00:00.000Z',
	operations: [],
}

const getWidget = {
	slug: 'getwidget',
	operationId: 'getWidget',
	method: 'get' as const,
	path: '/widgets/{widgetId}',
	summary: 'Get widget',
	description: null,
	tags: ['widgets'],
	deprecated: false,
	parameters: [
		{
			name: 'widgetId',
			location: 'path' as const,
			required: true,
			description: null,
			schema: { type: 'string' },
		},
	],
	requestBody: null,
}

const createWidget = {
	slug: 'createwidget',
	operationId: 'createWidget',
	method: 'post' as const,
	path: '/widgets',
	summary: 'Create',
	description: null,
	tags: ['widgets'],
	deprecated: false,
	parameters: [],
	requestBody: {
		required: true,
		contentType: 'application/json',
		schema: { type: 'object' },
	},
}

function createEnv(entries: Map<string, string> = new Map()) {
	const db = {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T>() {
							if (
								normalizedQuery.includes('from value_buckets') ||
								normalizedQuery.includes('from secret_buckets')
							) {
								return {
									id: 'bucket-1',
									user_id: String(params[0] ?? 'user-1'),
									scope: 'user',
									binding_key: '',
									expires_at: null,
									created_at: '2026-03-29T00:00:00.000Z',
									updated_at: '2026-03-29T00:00:00.000Z',
								} as T
							}
							if (
								normalizedQuery.includes('from value_entries') &&
								normalizedQuery.includes('where bucket_id = ? and name = ?')
							) {
								const name = String(params[1])
								const value = entries.get(name)
								return value == null
									? null
									: ({
											bucket_id: 'bucket-1',
											name,
											description: '',
											value,
											created_at: '2026-03-29T00:00:00.000Z',
											updated_at: '2026-03-29T00:00:00.000Z',
										} as T)
							}
							return null
						},
						async run() {
							if (normalizedQuery.startsWith('insert into secret_entries')) {
								return { meta: { changes: 1 } }
							}
							if (normalizedQuery.startsWith('insert into value_entries')) {
								const name = String(params[1])
								const value = String(params[3])
								entries.set(name, value)
								return { meta: { changes: 1 } }
							}
							return { meta: { changes: 1 } }
						},
						async all<T>() {
							return { results: [] as Array<T>, meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	return {
		APP_DB: db,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
}

test('builds URL with path params and query serialization', async () => {
	const usageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const fetchStub = vi.fn(async (request: Request) => {
		expect(request.url).toBe(
			'https://api.widgets.example/widgets/abc%2F123?limit=10&tag=a&tag=b',
		)
		expect(request.method).toBe('GET')
		return new Response(JSON.stringify({ id: 'abc/123' }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	})

	try {
		const result = await executeOpenApiOperationRequest({
			env: createEnv(),
			userId: 'user-1',
			binding: bindingBase,
			operation: getWidget,
			args: {
				params: { widgetId: 'abc/123' },
				query: { limit: 10, tag: ['a', 'b'], skip: null },
			},
			globalFetch: fetchStub as unknown as typeof fetch,
		})

		expect(result.ok).toBe(true)
		expect(result.body).toEqual({ id: 'abc/123' })
		expect(result.truncated).toBe(false)
		expect(fetchStub).toHaveBeenCalledTimes(1)
	} finally {
		usageSpy.mockRestore()
	}
})

test('preserves apiBaseUrl path segments when building operation URLs', async () => {
	const usageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const fetchStub = vi.fn(async (request: Request) => {
		expect(request.url).toBe('https://api.widgets.example/v1/widgets/abc')
		return new Response('{}', {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	})

	try {
		const result = await executeOpenApiOperationRequest({
			env: createEnv(),
			userId: 'user-1',
			binding: {
				...bindingBase,
				apiBaseUrl: 'https://api.widgets.example/v1',
			},
			operation: getWidget,
			args: { params: { widgetId: 'abc' } },
			globalFetch: fetchStub as unknown as typeof fetch,
		})
		expect(result.ok).toBe(true)
		expect(fetchStub).toHaveBeenCalledTimes(1)
	} finally {
		usageSpy.mockRestore()
	}
})

test('rejects absolute and protocol-relative operation paths', async () => {
	for (const path of ['https://evil.example/steal', '//evil.example/steal']) {
		await expect(
			executeOpenApiOperationRequest({
				env: createEnv(),
				userId: 'user-1',
				binding: {
					...bindingBase,
					apiBaseUrl: 'https://api.widgets.example',
				},
				operation: {
					...getWidget,
					path,
					parameters: [],
				},
				args: {},
				globalFetch: vi.fn() as unknown as typeof fetch,
			}),
		).rejects.toThrow(/must be relative to the binding apiBaseUrl/)
	}
})

test('injects auth headers and overrides caller attempts', async () => {
	const usageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue({
			found: true,
			value: 'resolved-secret',
			scope: 'user',
			allowedHosts: ['api.widgets.example'],
			allowedCapabilities: [],
		})
	const seen: Array<Headers> = []
	const fetchStub = vi.fn(async (request: Request) => {
		seen.push(request.headers)
		return new Response('{}', {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	})

	try {
		await executeOpenApiOperationRequest({
			env: createEnv(),
			userId: 'user-1',
			binding: {
				...bindingBase,
				auth: { kind: 'bearerSecret', secretName: 'apiToken' },
			},
			operation: createWidget,
			args: {
				headers: {
					Authorization: 'Bearer attacker',
					'X-Custom': 'ok',
				},
				body: { name: 'w' },
			},
			globalFetch: fetchStub as unknown as typeof fetch,
		})
		expect(seen[0]?.get('authorization')).toBe('Bearer resolved-secret')
		expect(seen[0]?.get('x-custom')).toBe('ok')

		await executeOpenApiOperationRequest({
			env: createEnv(),
			userId: 'user-1',
			binding: {
				...bindingBase,
				auth: {
					kind: 'headerSecret',
					headerName: 'X-Api-Key',
					secretName: 'apiKey',
				},
			},
			operation: getWidget,
			args: {
				params: { widgetId: '1' },
				headers: { 'X-Api-Key': 'attacker' },
			},
			globalFetch: fetchStub as unknown as typeof fetch,
		})
		expect(seen[1]?.get('x-api-key')).toBe('resolved-secret')

		await executeOpenApiOperationRequest({
			env: createEnv(),
			userId: 'user-1',
			binding: {
				...bindingBase,
				auth: {
					kind: 'basicSecrets',
					usernameSecret: 'userSecret',
					passwordSecret: 'passSecret',
				},
			},
			operation: getWidget,
			args: { params: { widgetId: '1' } },
			globalFetch: fetchStub as unknown as typeof fetch,
		})
		// Basic auth expands to base64(username:password) via gateway.
		expect(seen[2]?.get('authorization')).toMatch(/^Basic /)
	} finally {
		resolveSpy.mockRestore()
		usageSpy.mockRestore()
	}
})

test('returns truncated flag for oversized non-json bodies', async () => {
	const usageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const big = 'x'.repeat(350_000)
	try {
		const result = await executeOpenApiOperationRequest({
			env: createEnv(),
			userId: 'user-1',
			binding: bindingBase,
			operation: getWidget,
			args: { params: { widgetId: '1' } },
			globalFetch: vi.fn(
				async () =>
					new Response(big, {
						status: 200,
						headers: { 'content-type': 'text/plain' },
					}),
			) as unknown as typeof fetch,
		})
		expect(result.truncated).toBe(true)
		expect(typeof result.body).toBe('string')
		expect((result.body as string).length).toBeLessThan(big.length)
	} finally {
		usageSpy.mockRestore()
	}
})

test('integration auth 401 triggers host-side refresh retry', async () => {
	const usageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue({
			found: true,
			value: 'token-value',
			scope: 'user',
			allowedHosts: ['api.spotify.com', 'accounts.spotify.com'],
			allowedCapabilities: [],
		})
	const saveSecretSpy = vi
		.spyOn(secretService, 'saveSecret')
		.mockResolvedValue({
			name: 'spotifyAccessToken',
			scope: 'user',
			description: '',
			appId: null,
			createdAt: '2026-03-29T00:00:00.000Z',
			updatedAt: '2026-03-29T00:00:00.000Z',
			ttlMs: null,
			allowedHosts: [],
			allowedCapabilities: [],
			allowedPackages: [],
		})

	const entries = new Map<string, string>([
		[
			'_integration:spotify',
			JSON.stringify({
				name: 'spotify',
				tokenUrl: 'https://accounts.spotify.com/api/token',
				apiBaseUrl: 'https://api.spotify.com/v1',
				flow: 'pkce',
				clientIdValueName: 'spotify-client-id',
				clientSecretSecretName: null,
				accessTokenSecretName: 'spotifyAccessToken',
				refreshTokenSecretName: 'spotifyRefreshToken',
				requiredHosts: ['api.spotify.com', 'accounts.spotify.com'],
			}),
		],
		['spotify-client-id', 'client-id-value'],
	])

	try {
		let apiCalls = 0
		let firstUnauthorizedResponse: Response | null = null
		const fetchStub = vi.fn(async (request: Request) => {
			if (request.url.includes('/api/token')) {
				expect(await request.text()).toContain('grant_type=refresh_token')
				return new Response(
					JSON.stringify({
						access_token: 'new-access',
						refresh_token: 'new-refresh',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				)
			}
			apiCalls += 1
			if (apiCalls === 1) {
				const response = new Response(JSON.stringify({ error: 'expired' }), {
					status: 401,
					headers: { 'content-type': 'application/json' },
				})
				firstUnauthorizedResponse = response
				return response
			}
			expect(request.headers.get('authorization')).toBe('Bearer token-value')
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		})

		const result = await executeOpenApiOperationRequest({
			env: createEnv(entries),
			userId: 'user-1',
			binding: {
				...bindingBase,
				apiBaseUrl: 'https://api.spotify.com/v1',
				auth: { kind: 'integration', provider: 'spotify' },
			},
			operation: {
				...getWidget,
				path: '/me',
				parameters: [],
			},
			args: {},
			globalFetch: fetchStub as unknown as typeof fetch,
		})

		expect(result.ok).toBe(true)
		expect(result.body).toEqual({ ok: true })
		expect(apiCalls).toBe(2)
		expect(saveSecretSpy).toHaveBeenCalled()
		expect(firstUnauthorizedResponse).not.toBeNull()
		expect(firstUnauthorizedResponse!.bodyUsed).toBe(true)
	} finally {
		resolveSpy.mockRestore()
		saveSecretSpy.mockRestore()
		usageSpy.mockRestore()
	}
})

test('passes application/json-seq request bodies through as strings', async () => {
	const usageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const payload = '{"id":1}\n{"id":2}\n'
	const fetchStub = vi.fn(async (request: Request) => {
		// Non-JSON content types are not auto-set; callers supply them via headers.
		expect(request.headers.get('content-type')).toBe('application/json-seq')
		// Must not JSON.stringify a string body (which would wrap it in quotes).
		expect(await request.text()).toBe(payload)
		return new Response('ok', {
			status: 200,
			headers: { 'content-type': 'text/plain' },
		})
	})

	try {
		const result = await executeOpenApiOperationRequest({
			env: createEnv(),
			userId: 'user-1',
			binding: bindingBase,
			operation: {
				...createWidget,
				requestBody: {
					required: true,
					contentType: 'application/json-seq',
					schema: null,
				},
			},
			args: {
				headers: { 'content-type': 'application/json-seq' },
				body: payload,
			},
			globalFetch: fetchStub as unknown as typeof fetch,
		})
		expect(result.ok).toBe(true)
		expect(fetchStub).toHaveBeenCalledTimes(1)
	} finally {
		usageSpy.mockRestore()
	}
})
