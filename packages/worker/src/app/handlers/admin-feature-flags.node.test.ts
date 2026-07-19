import { expect, test, vi } from 'vitest'
import { type PermissionString, type RoleName } from '#app/permissions.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#app/audit-log.ts')>()
	return {
		...actual,
		getRequestIp: () => '127.0.0.1',
		logAuditEvent: (...args: Parameters<typeof actual.logAuditEvent>) =>
			logAuditEventSpy(...args),
	}
})

type GlobalRow = {
	key: string
	enabled: number
	rollout_percent: number | null
	note: string
	updated_by: number | null
	updated_at: string
}

type OverrideRow = {
	flag_key: string
	user_id: number
	enabled: number
	updated_by: number | null
	updated_at: string
}

type UserRow = {
	id: number
	username: string
}

function createAdminActor(roles: Array<RoleName>) {
	const permissions: Array<PermissionString> = roles.includes('admin')
		? ['read:user:any', 'update:user:any']
		: ['read:user:own']
	return {
		sessionUserId: '1',
		userId: 1,
		email: 'admin@example.com',
		username: 'admin-user',
		displayName: 'admin-user',
		roles,
		permissions,
		artifactOwnerIds: ['1'],
		mcpUser: {
			userId: 'stable-admin',
			email: 'admin@example.com',
			username: 'admin-user',
			displayName: 'admin-user',
		},
	}
}

function createFeatureFlagsTestEnv(
	input: {
		globals?: Array<GlobalRow>
		overrides?: Array<OverrideRow>
		users?: Array<UserRow>
	} = {},
) {
	const globals = new Map(
		(input.globals ?? []).map((row) => [row.key, { ...row }]),
	)
	const overrides = new Map(
		(input.overrides ?? []).map((row) => [
			`${row.flag_key}:${row.user_id}`,
			{ ...row },
		]),
	)
	const users = new Map((input.users ?? []).map((row) => [row.id, { ...row }]))
	let clock = 0

	function nextTimestamp() {
		clock += 1
		return `2026-07-19T00:00:${String(clock).padStart(2, '0')}.000Z`
	}

	function normalize(query: string) {
		return query.replace(/\s+/g, ' ').trim().toLowerCase()
	}

	function createStatement(query: string, params: Array<unknown> = []) {
		const normalized = normalize(query)
		return {
			bind(...nextParams: Array<unknown>) {
				return createStatement(query, nextParams)
			},
			async first<T>() {
				if (normalized.includes('select id from users where id = ?')) {
					const user = users.get(Number(params[0]))
					return (user ? { id: user.id } : null) as T | null
				}
				if (normalized.includes('select id from users where username = ?')) {
					const username = String(params[0])
					for (const user of users.values()) {
						if (user.username === username) {
							return { id: user.id } as T
						}
					}
					return null
				}
				if (
					normalized.includes('from feature_flag_user_overrides') &&
					normalized.includes('where flag_key = ? and user_id = ?')
				) {
					const row = overrides.get(`${params[0]}:${params[1]}`)
					return (row ? { enabled: row.enabled } : null) as T | null
				}
				if (
					normalized.includes('from feature_flags') &&
					normalized.includes('where key = ?')
				) {
					const row = globals.get(String(params[0]))
					return (
						row
							? {
									enabled: row.enabled,
									rollout_percent: row.rollout_percent,
								}
							: null
					) as T | null
				}
				throw new Error(`Unsupported first query: ${query}`)
			},
			async all<T>() {
				if (
					normalized.includes('from feature_flags') &&
					!normalized.includes('where')
				) {
					return {
						results: [...globals.values()].map((row) => ({ ...row })),
						meta: { changes: 0 },
					} as { results: Array<T>; meta: { changes: number } }
				}
				if (
					normalized.includes('from feature_flag_user_overrides o') &&
					normalized.includes('join users u')
				) {
					const rows = [...overrides.values()]
						.map((row) => {
							const user = users.get(row.user_id)
							if (!user) return null
							return {
								flag_key: row.flag_key,
								user_id: row.user_id,
								enabled: row.enabled,
								updated_at: row.updated_at,
								username: user.username,
							}
						})
						.filter((row) => row !== null)
						.sort((left, right) => {
							const byKey = left.flag_key.localeCompare(right.flag_key)
							if (byKey !== 0) return byKey
							return left.username.localeCompare(right.username)
						})
					return {
						results: rows,
						meta: { changes: 0 },
					} as { results: Array<T>; meta: { changes: number } }
				}
				throw new Error(`Unsupported all query: ${query}`)
			},
			async run() {
				if (
					normalized.startsWith('insert into feature_flags') &&
					normalized.includes('on conflict(key) do update')
				) {
					const key = String(params[0])
					const enabled = Number(params[1])
					const rolloutPercent =
						params[2] === null || params[2] === undefined
							? null
							: Number(params[2])
					const note = String(params[3] ?? '')
					const updatedBy = Number(params[4])
					const updatedAt = nextTimestamp()
					globals.set(key, {
						key,
						enabled,
						rollout_percent: rolloutPercent,
						note,
						updated_by: updatedBy,
						updated_at: updatedAt,
					})
					return { meta: { changes: 1 } }
				}
				if (
					normalized.startsWith('insert into feature_flag_user_overrides') &&
					normalized.includes('on conflict(flag_key, user_id) do update')
				) {
					const flagKey = String(params[0])
					const userId = Number(params[1])
					const enabled = Number(params[2])
					const updatedBy = Number(params[3])
					const updatedAt = nextTimestamp()
					overrides.set(`${flagKey}:${userId}`, {
						flag_key: flagKey,
						user_id: userId,
						enabled,
						updated_by: updatedBy,
						updated_at: updatedAt,
					})
					return { meta: { changes: 1 } }
				}
				if (
					normalized.startsWith('delete from feature_flag_user_overrides') &&
					normalized.includes('where flag_key = ? and user_id = ?')
				) {
					const mapKey = `${params[0]}:${params[1]}`
					const existed = overrides.delete(mapKey)
					return { meta: { changes: existed ? 1 : 0 } }
				}
				if (
					normalized.startsWith('delete from feature_flag_user_overrides') &&
					normalized.includes('where flag_key = ?')
				) {
					const flagKey = String(params[0])
					let changes = 0
					for (const mapKey of [...overrides.keys()]) {
						if (mapKey.startsWith(`${flagKey}:`)) {
							overrides.delete(mapKey)
							changes += 1
						}
					}
					return { meta: { changes } }
				}
				if (
					normalized.startsWith('delete from feature_flags') &&
					normalized.includes('where key = ?')
				) {
					const existed = globals.delete(String(params[0]))
					return { meta: { changes: existed ? 1 : 0 } }
				}
				throw new Error(`Unsupported run query: ${query}`)
			},
		}
	}

	return {
		COOKIE_SECRET: 'secret',
		APP_DB: {
			prepare(query: string) {
				return createStatement(query)
			},
			async batch(
				statements: Array<{
					run: () => Promise<{ meta: { changes: number } }>
				}>,
			) {
				const results = []
				for (const statement of statements) {
					results.push(await statement.run())
				}
				return results
			},
		} as unknown as D1Database,
	}
}

const { createAdminFeatureFlagsApiHandler } =
	await import('./admin-feature-flags.ts')

test('admin feature flags API returns 403 without admin role', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['user']),
	)
	const handler = createAdminFeatureFlagsApiHandler(
		createFeatureFlagsTestEnv() as unknown as Env,
	)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/feature-flags.json', {
			headers: { Accept: 'application/json' },
		}),
		params: {},
		url: new URL('https://example.com/admin/feature-flags.json'),
	} as never)
	expect(response.status).toBe(403)
})

test('admin feature flags GET returns flag list', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const handler = createAdminFeatureFlagsApiHandler(
		createFeatureFlagsTestEnv() as unknown as Env,
	)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/feature-flags.json', {
			headers: { Accept: 'application/json' },
		}),
		params: {},
		url: new URL('https://example.com/admin/feature-flags.json'),
	} as never)
	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(payload).toMatchObject({
		ok: true,
		featureFlags: [
			{
				key: 'demo-indicator',
				stale: false,
				defaultEnabled: false,
				global: null,
				overrides: [],
			},
		],
	})
})

test('admin feature flags set_global happy path', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	logAuditEventSpy.mockClear()
	const handler = createAdminFeatureFlagsApiHandler(
		createFeatureFlagsTestEnv() as unknown as Env,
	)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/feature-flags.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'set_global',
				key: 'demo-indicator',
				enabled: true,
				rolloutPercent: 25,
				note: 'canary',
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/feature-flags.json'),
	} as never)
	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(payload).toMatchObject({
		ok: true,
		featureFlags: [
			{
				key: 'demo-indicator',
				global: {
					enabled: true,
					rolloutPercent: 25,
					note: 'canary',
					updatedBy: 1,
				},
			},
		],
	})
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'feature_flag_set_global',
			result: 'success',
			reason: 'key=demo-indicator;enabled=true;rollout_percent=25',
		}),
	)
})

test('admin feature flags set_global with bad key returns 400', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const handler = createAdminFeatureFlagsApiHandler(
		createFeatureFlagsTestEnv() as unknown as Env,
	)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/feature-flags.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'set_global',
				key: 'not-a-real-flag',
				enabled: true,
				rolloutPercent: null,
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/feature-flags.json'),
	} as never)
	expect(response.status).toBe(400)
	await expect(response.json()).resolves.toMatchObject({
		ok: false,
		error: 'Unknown or invalid feature flag key.',
	})
})

test('admin feature flags delete_stale on registry key returns 400', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const handler = createAdminFeatureFlagsApiHandler(
		createFeatureFlagsTestEnv() as unknown as Env,
	)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/feature-flags.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'delete_stale',
				key: 'demo-indicator',
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/feature-flags.json'),
	} as never)
	expect(response.status).toBe(400)
	await expect(response.json()).resolves.toMatchObject({
		ok: false,
		error:
			'Cannot delete registry feature flag "demo-indicator". Remove it from the code registry first.',
	})
})

test('admin feature flags set_global rejects overlong notes', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const handler = createAdminFeatureFlagsApiHandler(
		createFeatureFlagsTestEnv() as unknown as Env,
	)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/feature-flags.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'set_global',
				key: 'demo-indicator',
				enabled: true,
				rolloutPercent: null,
				note: 'x'.repeat(501),
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/feature-flags.json'),
	} as never)
	expect(response.status).toBe(400)
	await expect(response.json()).resolves.toMatchObject({
		ok: false,
		error: 'note must be at most 500 characters.',
	})
})

test('admin feature flags set_user_override validates user identity and existence', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const handler = createAdminFeatureFlagsApiHandler(
		createFeatureFlagsTestEnv({
			users: [
				{ id: 1, username: 'admin-user' },
				{ id: 2, username: 'jane' },
			],
		}) as unknown as Env,
	)

	const neither = await handler.handler({
		request: new Request('https://example.com/admin/feature-flags.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'set_user_override',
				key: 'demo-indicator',
				enabled: true,
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/feature-flags.json'),
	} as never)
	expect(neither.status).toBe(400)
	await expect(neither.json()).resolves.toMatchObject({
		ok: false,
		error: 'Provide either userId or username.',
	})

	const both = await handler.handler({
		request: new Request('https://example.com/admin/feature-flags.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'set_user_override',
				key: 'demo-indicator',
				enabled: true,
				userId: 2,
				username: 'jane',
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/feature-flags.json'),
	} as never)
	expect(both.status).toBe(400)
	await expect(both.json()).resolves.toMatchObject({
		ok: false,
		error: 'Provide either userId or username, not both.',
	})

	const missingId = await handler.handler({
		request: new Request('https://example.com/admin/feature-flags.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'set_user_override',
				key: 'demo-indicator',
				enabled: true,
				userId: 404,
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/feature-flags.json'),
	} as never)
	expect(missingId.status).toBe(404)
	await expect(missingId.json()).resolves.toMatchObject({
		ok: false,
		error: 'User not found.',
	})

	const byUsername = await handler.handler({
		request: new Request('https://example.com/admin/feature-flags.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'set_user_override',
				key: 'demo-indicator',
				enabled: true,
				username: 'jane',
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/feature-flags.json'),
	} as never)
	expect(byUsername.status).toBe(200)
	await expect(byUsername.json()).resolves.toMatchObject({
		ok: true,
		featureFlags: [
			{
				key: 'demo-indicator',
				overrides: [
					expect.objectContaining({
						userId: 2,
						username: 'jane',
						enabled: true,
					}),
				],
			},
		],
	})
})
