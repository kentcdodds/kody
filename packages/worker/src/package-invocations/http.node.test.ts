import { expect, test, vi } from 'vitest'
import type * as PackageInvocationServiceModule from './service.ts'
import {
	handlePackageInvocationApiRequest,
	isPackageInvocationApiRequest,
} from './http.ts'
import { hashPackageInvocationBearerToken } from './repo.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { AccountDeletionInProgressError } from '#worker/account/deletion-state.ts'

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
			package_id?: string
			export_names_json?: string
			revoked_at?: string | null
		}
		touchChanges?: number
		touchError?: Error
	} = {},
) {
	const tokenUserId = await createStableUserIdFromEmail('me@example.com')
	const packageId = options.tokenRow?.package_id ?? 'pkg-discord-gateway'
	const tokenRows = [
		{
			id: 'token-1',
			user_id: tokenUserId,
			package_id: packageId,
			token_hash: await hashPackageInvocationBearerToken('private-token-123'),
			name: 'Discord gateway',
			export_names_json:
				options.tokenRow?.export_names_json ??
				JSON.stringify(['./dispatch-message-created']),
			created_at: '2026-04-27T00:00:00.000Z',
			updated_at: '2026-04-27T00:00:00.000Z',
			last_used_at: null,
			revoked_at: options.tokenRow?.revoked_at ?? null,
		},
	]
	const savedPackage = {
		id: packageId,
		user_id: tokenUserId,
		name: '@test/discord-gateway',
		kody_id: 'discord-gateway',
		description: 'Dispatch Discord gateway events.',
		tags_json: '[]',
		search_text: null,
		source_id: 'source-1',
		has_app: 0,
		hidden: 0,
		is_private: 0,
		created_at: '2026-04-27T00:00:00.000Z',
		updated_at: '2026-04-27T00:00:00.000Z',
	}
	return {
		APP_DB: {
			prepare(query: string) {
				return {
					bind(...params: Array<unknown>) {
						return {
							async first<T = Record<string, unknown>>() {
								if (query.includes('FROM users')) {
									if (query.includes('stable_user_id = ?')) {
										return (
											params[0] === tokenUserId ? { deleting_at: null } : null
										) as T | null
									}
									const username = String(params[0] ?? '')
									return (
										username === 'my-user'
											? {
													id: 1,
													username: 'my-user',
													email: 'me@example.com',
													password_hash: 'hash',
													stable_user_id: tokenUserId,
													created_at: '2026-04-27T00:00:00.000Z',
													updated_at: '2026-04-27T00:00:00.000Z',
												}
											: null
									) as T | null
								}
								if (query.includes('FROM saved_packages')) {
									const kodyId = String(params[0] ?? '')
									const userId = String(params[1] ?? '')
									return (
										kodyId === savedPackage.kody_id &&
										userId === savedPackage.user_id
											? savedPackage
											: null
									) as T | null
								}
								if (query.includes('FROM package_invocation_tokens')) {
									const userId = String(params[0] ?? '')
									const rowPackageId = String(params[1] ?? '')
									const tokenHash = String(params[2] ?? '')
									return (tokenRows.find(
										(row) =>
											row.user_id === userId &&
											row.package_id === rowPackageId &&
											row.token_hash === tokenHash &&
											row.revoked_at === null,
									) ?? null) as T | null
								}
								return null
							},
							async all<T = Record<string, unknown>>() {
								return { results: [] as Array<T> }
							},
							async run() {
								if (query.includes('UPDATE package_invocation_tokens')) {
									if (options.touchError) {
										throw options.touchError
									}
									const id = String(params[1] ?? '')
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
	} as unknown as Env
}

function createContext() {
	return {
		waitUntil: vi.fn(),
		passThroughOnException: vi.fn(),
	} as unknown as ExecutionContext
}

test('package invocation API rejects missing, invalid, and malformed tokens before invoking exports', async () => {
	expect(
		isPackageInvocationApiRequest(
			'/@my-user/api/package-invocations/discord-gateway/dispatch-message-created',
		),
	).toBe(true)
	expect(
		isPackageInvocationApiRequest(
			'/api/package-invocations/discord-gateway/dispatch-message-created',
		),
	).toBe(true)
	expect(isPackageInvocationApiRequest('/api/me')).toBe(false)

	const route =
		'https://example.com/@my-user/api/package-invocations/discord-gateway/dispatch-message-created'
	const body = JSON.stringify({ idempotencyKey: 'evt-1' })

	const missingTokenResponse = await handlePackageInvocationApiRequest(
		new Request(route, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
		}),
		await createEnv(),
		createContext(),
	)

	expect(missingTokenResponse.status).toBe(401)
	expect(missingTokenResponse.headers.get('WWW-Authenticate')).toBe(
		'Bearer realm="package-invocations"',
	)
	await expect(missingTokenResponse.json()).resolves.toEqual({
		ok: false,
		error: {
			code: 'unauthorized',
			message: 'Unauthorized',
		},
	})

	const invalidTokenResponse = await handlePackageInvocationApiRequest(
		new Request(route, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer wrong-token',
				'Content-Type': 'application/json',
			},
			body,
		}),
		await createEnv(),
		createContext(),
	)

	expect(invalidTokenResponse.status).toBe(401)
	await expect(invalidTokenResponse.json()).resolves.toEqual({
		ok: false,
		error: {
			code: 'unauthorized',
			message: 'Invalid package invocation token.',
		},
	})

	invocationMockModule.invokePackageExport.mockClear()
	invocationMockModule.invokePackageExport.mockResolvedValue({
		status: 200,
		body: { ok: true },
	})

	const lastUsedWriteMiss = await handlePackageInvocationApiRequest(
		new Request(route, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer private-token-123',
				'Content-Type': 'application/json',
			},
			body,
		}),
		await createEnv({ touchChanges: 0 }),
		createContext(),
	)

	expect(lastUsedWriteMiss.status).toBe(200)
	expect(invocationMockModule.invokePackageExport).toHaveBeenCalled()

	await expect(
		handlePackageInvocationApiRequest(
			new Request(route, {
				method: 'POST',
				headers: {
					Authorization: 'Bearer private-token-123',
					'Content-Type': 'application/json',
				},
				body,
			}),
			await createEnv({
				tokenRow: {
					export_names_json: '{bad json',
				},
			}),
			createContext(),
		),
	).rejects.toThrow(
		'Invalid package invocation token record: export_names_json must be valid JSON.',
	)
	expect(invocationMockModule.invokePackageExport).toHaveBeenCalledTimes(1)
})

test('unscoped package invocation route reports missing owner slug instead of token failure', async () => {
	invocationMockModule.invokePackageExport.mockClear()

	const response = await handlePackageInvocationApiRequest(
		new Request(
			'https://example.com/api/package-invocations/discord-gateway/dispatch-message-created',
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer wrong-token',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ idempotencyKey: 'evt-unscoped' }),
			},
		),
		await createEnv(),
		createContext(),
	)

	expect(response.status).toBe(404)
	expect(response.headers.get('WWW-Authenticate')).toBeNull()
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: {
			code: 'owner_slug_required',
			message:
				'Package invocation endpoints must include the package owner slug: POST /@:username/api/package-invocations/:kodyId/:exportName.',
		},
	})
	expect(invocationMockModule.invokePackageExport).not.toHaveBeenCalled()
})

test('package invocation API validates requests and invokes exports with scoped token context', async () => {
	const invalidBodyResponse = await handlePackageInvocationApiRequest(
		new Request(
			'https://example.com/@my-user/api/package-invocations/discord-gateway/dispatch-message-created',
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
		createContext(),
	)

	expect(invalidBodyResponse.status).toBe(400)
	await expect(invalidBodyResponse.json()).resolves.toEqual({
		ok: false,
		error: {
			code: 'invalid_params',
			message: 'params must be a JSON object when provided.',
		},
	})

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

	const ctx = createContext()
	const expectedUserId = await createStableUserIdFromEmail('me@example.com')
	const invokeResponse = await handlePackageInvocationApiRequest(
		new Request(
			'https://example.com/@my-user/api/package-invocations/discord-gateway/dispatch-message-created',
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
		ctx,
	)

	expect(invocationMockModule.invokePackageExport).toHaveBeenCalledWith({
		env: expect.any(Object),
		baseUrl: 'https://example.com',
		token: {
			tokenId: 'token-1',
			userId: expectedUserId,
			email: 'me@example.com',
			packageId: 'pkg-discord-gateway',
			exportNames: ['./dispatch-message-created'],
		},
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-1',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
		waitUntil: expect.any(Function),
	})
	expect(invokeResponse.status).toBe(200)
	expect(ctx.waitUntil).toHaveBeenCalled()
	await expect(invokeResponse.json()).resolves.toEqual({
		ok: true,
		exportName: './dispatch-message-created',
		idempotency: {
			key: 'evt-1',
			replayed: false,
		},
		result: { reply: 'hello discord' },
		logs: ['ran'],
	})

	invocationMockModule.invokePackageExport.mockClear()
	invocationMockModule.invokePackageExport.mockResolvedValue({
		status: 200,
		body: {
			ok: true,
			exportName: '.',
			idempotency: {
				key: 'evt-root',
				replayed: false,
			},
			result: { ok: true },
			logs: [],
		},
	})

	const rootResponse = await handlePackageInvocationApiRequest(
		new Request(
			'https://example.com/@my-user/api/package-invocations/discord-gateway/__root__',
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer private-token-123',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					params: { content: 'hi' },
					idempotencyKey: 'evt-root',
					source: 'discord-gateway',
				}),
			},
		),
		await createEnv({
			tokenRow: {
				export_names_json: JSON.stringify(['.']),
			},
		}),
		createContext(),
	)

	expect(invocationMockModule.invokePackageExport).toHaveBeenCalledWith(
		expect.objectContaining({
			request: expect.objectContaining({
				exportName: '.',
			}),
		}),
	)
	expect(rootResponse.status).toBe(200)
})

test('package invocation maps a lease acquisition race to account_deleting', async () => {
	invocationMockModule.invokePackageExport.mockRejectedValue(
		new AccountDeletionInProgressError(),
	)
	const response = await handlePackageInvocationApiRequest(
		new Request(
			'https://example.com/@my-user/api/package-invocations/discord-gateway/dispatch-message-created',
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer private-token-123',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					idempotencyKey: 'lease-race',
				}),
			},
		),
		await createEnv(),
		createContext(),
	)
	expect(response.status).toBe(409)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: {
			code: 'account_deleting',
			message:
				'Account deletion is in progress; user-owned writes are disabled.',
		},
	})
})
