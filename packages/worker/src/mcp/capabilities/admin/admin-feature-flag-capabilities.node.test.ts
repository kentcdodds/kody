import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

vi.unmock('#app/audit-log.ts')
import { adminFeatureFlagListCapability } from './admin-feature-flag-list.ts'
import { adminFeatureFlagOverrideCapability } from './admin-feature-flag-override.ts'
import { adminFeatureFlagSetCapability } from './admin-feature-flag-set.ts'

type UserRow = {
	id: number
	username: string
	email: string
	stable_user_id: string | null
}

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

type AuditEventRow = {
	id: number
	category: string
	action: string
	result: string
	email_hash: string | null
	ip_hash: string | null
	client_id: string | null
	path: string | null
	reason: string | null
	timestamp: string
}

function normalizeQuery(query: string) {
	return query.replace(/\s+/g, ' ').trim().toLowerCase()
}

function createFeatureFlagCapabilityTestDb(input: {
	users: Array<UserRow>
	globals?: Array<GlobalRow>
	overrides?: Array<OverrideRow>
}) {
	const users = input.users.map((user) => ({ ...user }))
	const globals = new Map(
		(input.globals ?? []).map((row) => [row.key, { ...row }]),
	)
	const overrides = new Map(
		(input.overrides ?? []).map((row) => [
			`${row.flag_key}:${row.user_id}`,
			{ ...row },
		]),
	)
	const auditEvents: Array<AuditEventRow> = []
	let clock = 0

	function nextTimestamp() {
		clock += 1
		return `2026-07-19T00:00:${String(clock).padStart(2, '0')}.000Z`
	}

	function createStatement(query: string, params: Array<unknown> = []) {
		const normalized = normalizeQuery(query)
		return {
			bind(...nextParams: Array<unknown>) {
				return createStatement(query, nextParams)
			},
			async first<T>() {
				if (
					normalized.includes('from users') &&
					normalized.includes('where stable_user_id = ?')
				) {
					const stableUserId = String(params[0])
					return (users.find((user) => user.stable_user_id === stableUserId) ??
						null) as T | null
				}
				if (
					normalized.includes('select id from users where id = ?') ||
					(normalized.includes('from users') &&
						normalized.includes('where id = ?') &&
						!normalized.includes('stable_user_id'))
				) {
					return (users.find((user) => user.id === Number(params[0])) ??
						null) as T | null
				}
				if (normalized.includes('select id from users where username = ?')) {
					const username = String(params[0])
					const user = users.find((row) => row.username === username)
					return user ? ({ id: user.id } as T) : null
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
				return null
			},
			async all<T>() {
				if (
					normalized.includes('from feature_flags') &&
					!normalized.includes('where')
				) {
					return {
						results: [...globals.values()].map((row) => ({
							...row,
						})) as Array<T>,
					}
				}
				if (
					normalized.includes('from feature_flag_user_overrides o') &&
					normalized.includes('join users u')
				) {
					const rows = [...overrides.values()]
						.map((row) => {
							const user = users.find((entry) => entry.id === row.user_id)
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
					return { results: rows as Array<T> }
				}
				if (
					normalized.includes('from feature_flag_user_overrides') &&
					normalized.includes('where user_id = ?')
				) {
					const userId = Number(params[0])
					return {
						results: [...overrides.values()]
							.filter((row) => row.user_id === userId)
							.map((row) => ({
								flag_key: row.flag_key,
								enabled: row.enabled,
							})) as Array<T>,
					}
				}
				if (
					normalized.startsWith(
						'select id, email, stable_user_id from users',
					) &&
					!normalized.includes('where')
				) {
					return {
						results: users.map((user) => ({
							id: user.id,
							email: user.email,
							stable_user_id: user.stable_user_id,
						})) as Array<T>,
					}
				}
				return { results: [] as Array<T> }
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
					const existed = overrides.delete(`${params[0]}:${params[1]}`)
					return { meta: { changes: existed ? 1 : 0 } }
				}
				if (normalized.startsWith('insert into audit_events')) {
					auditEvents.push({
						id: auditEvents.length + 1,
						category: String(params[0]),
						action: String(params[1]),
						result: String(params[2]),
						email_hash: params[3] ? String(params[3]) : null,
						ip_hash: params[4] ? String(params[4]) : null,
						client_id: params[5] ? String(params[5]) : null,
						path: params[6] ? String(params[6]) : null,
						reason: params[7] ? String(params[7]) : null,
						timestamp: String(params[8]),
					})
				}
				return { meta: { changes: 1 } }
			},
		}
	}

	const db = {
		prepare(query: string) {
			return createStatement(query)
		},
	} as unknown as D1Database

	return { db, auditEvents, globals, overrides, users }
}

function createAdminCapabilityContext(db: D1Database) {
	return {
		env: { APP_DB: db } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: 'admin-stable',
				email: 'admin@example.com',
				displayName: 'admin',
				roles: ['admin'],
			},
		}),
	}
}

test('admin feature flag MCP capabilities: list, set, override, and audit wiring', async () => {
	const { db, auditEvents, globals, overrides } =
		createFeatureFlagCapabilityTestDb({
			users: [
				{
					id: 1,
					username: 'admin',
					email: 'admin@example.com',
					stable_user_id: 'admin-stable',
				},
				{
					id: 2,
					username: 'jane',
					email: 'jane@example.com',
					stable_user_id: 'jane-stable',
				},
			],
		})
	const ctx = createAdminCapabilityContext(db)

	const listResult = await adminFeatureFlagListCapability.handler({}, ctx)
	expect(listResult.flags).toEqual([
		expect.objectContaining({
			key: 'demo-indicator',
			description: expect.any(String),
			defaultEnabled: false,
			stale: false,
			global: null,
			overrides: [],
		}),
	])
	expect(listResult.flags[0]?.description).not.toHaveLength(0)

	const setResult = await adminFeatureFlagSetCapability.handler(
		{
			key: 'demo-indicator',
			enabled: true,
			rolloutPercent: 25,
			note: 'gradual rollout',
		},
		ctx,
	)
	expect(setResult.flag).toMatchObject({
		key: 'demo-indicator',
		global: {
			enabled: true,
			rolloutPercent: 25,
			note: 'gradual rollout',
			updatedBy: 1,
		},
	})
	expect(globals.get('demo-indicator')).toMatchObject({
		enabled: 1,
		rollout_percent: 25,
		updated_by: 1,
	})

	await expect(
		adminFeatureFlagSetCapability.handler(
			{ key: 'not-a-real-flag', enabled: true },
			ctx,
		),
	).rejects.toThrow(/Unknown feature flag key/)

	const setByUsername = await adminFeatureFlagOverrideCapability.handler(
		{ key: 'demo-indicator', username: 'jane', enabled: true },
		ctx,
	)
	expect(setByUsername).toMatchObject({
		cleared: false,
		flag: {
			key: 'demo-indicator',
			overrides: [
				expect.objectContaining({
					userId: 2,
					username: 'jane',
					enabled: true,
				}),
			],
		},
	})
	expect(overrides.get('demo-indicator:2')).toMatchObject({
		enabled: 1,
		updated_by: 1,
	})

	const cleared = await adminFeatureFlagOverrideCapability.handler(
		{ key: 'demo-indicator', userId: 2, clear: true },
		ctx,
	)
	expect(cleared.cleared).toBe(true)
	expect(cleared.flag.overrides).toEqual([])
	expect(overrides.has('demo-indicator:2')).toBe(false)

	expect(auditEvents.map((event) => event.result)).toEqual([
		'success',
		'success',
		'failure',
		'success',
		'success',
	])
})
