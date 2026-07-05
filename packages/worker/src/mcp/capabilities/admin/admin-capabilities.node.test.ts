import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { adminAuditLogQueryCapability } from './admin-audit-log-query.ts'
import { adminUsageOverviewCapability } from './admin-usage-overview.ts'
import { adminUserCreateCapability } from './admin-user-create.ts'
import { adminUserGetCapability } from './admin-user-get.ts'
import { adminUserListCapability } from './admin-user-list.ts'

type UserRow = {
	id: number
	username: string
	email: string
	plan?: string | null
	created_at: string
	updated_at: string
	password_hash?: string
	email_verified_at?: string | null
}

type UserRoleRow = {
	user_id: number
	role_name: string
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

type PasswordResetRow = {
	user_id: number
	token_hash: string
	expires_at: number
}

function normalizeQuery(query: string) {
	return query.replace(/\s+/g, ' ').trim().toLowerCase()
}

function createAdminCapabilityTestDb(input: {
	users: Array<UserRow>
	userRoles: Array<UserRoleRow>
}) {
	let nextUserId = Math.max(0, ...input.users.map((user) => user.id)) + 1
	const users = input.users.map((user) => ({ ...user }))
	const userRoles = input.userRoles.map((row) => ({ ...row }))
	const auditEvents: Array<AuditEventRow> = []
	const passwordResets: Array<PasswordResetRow> = []

	function selectAuditEvents(
		normalizedQuery: string,
		params: Array<unknown>,
		options: { paginated: boolean },
	) {
		const filterParams = options.paginated ? params.slice(0, -2) : params
		let index = 0
		let rows = [...auditEvents]
		if (normalizedQuery.includes('action = ?')) {
			const action = String(filterParams[index++])
			rows = rows.filter((row) => row.action === action)
		}
		if (normalizedQuery.includes('category = ?')) {
			const category = String(filterParams[index++])
			rows = rows.filter((row) => row.category === category)
		}
		if (normalizedQuery.includes('result = ?')) {
			const result = String(filterParams[index++])
			rows = rows.filter((row) => row.result === result)
		}
		if (normalizedQuery.includes('email_hash = ?')) {
			const emailHash = String(filterParams[index++])
			rows = rows.filter((row) => row.email_hash === emailHash)
		}
		if (normalizedQuery.includes('timestamp >= ?')) {
			const startTime = String(filterParams[index++])
			rows = rows.filter((row) => row.timestamp >= startTime)
		}
		if (normalizedQuery.includes('timestamp <= ?')) {
			const endTime = String(filterParams[index++])
			rows = rows.filter((row) => row.timestamp <= endTime)
		}
		rows.sort(
			(left, right) =>
				right.timestamp.localeCompare(left.timestamp) || right.id - left.id,
		)
		if (!options.paginated) return rows
		const limit = Number(params.at(-2))
		const offset = Number(params.at(-1))
		return rows.slice(offset, offset + limit)
	}

	function countForQuery(normalizedQuery: string) {
		const tableNames = [
			'saved_packages',
			'jobs',
			'repo_sessions',
			'package_runtime_runs',
			'secret_entries',
			'workflow_runs',
		] as const
		for (const table of tableNames) {
			if (normalizedQuery.includes(`from ${table}`)) return 0
		}
		return null
	}

	const db = {
		prepare(query: string) {
			const normalizedQuery = normalizeQuery(query)
			const createStatement = (params: Array<unknown>) => ({
				async first<T>() {
					if (normalizedQuery.includes('select count(*) as total from users')) {
						return { total: users.length } as T
					}
					if (
						normalizedQuery.includes(
							'select id, username, email, created_at, updated_at from users where id = ?',
						)
					) {
						return (users.find((user) => user.id === params[0]) ??
							null) as T | null
					}
					if (
						normalizedQuery.includes(
							'select id, username, email, plan from users where id = ?',
						)
					) {
						return (users.find((user) => user.id === Number(params[0])) ??
							null) as T | null
					}
					if (
						normalizedQuery.includes(
							'select id, username, email, created_at, updated_at from users where email = ? collate nocase',
						)
					) {
						const email = String(params[0]).toLowerCase()
						return (users.find((user) => user.email.toLowerCase() === email) ??
							null) as T | null
					}
					if (normalizedQuery.includes('select id from users where email')) {
						const email = String(params[0]).toLowerCase()
						const user = users.find((row) => row.email.toLowerCase() === email)
						return user ? ({ id: user.id } as T) : null
					}
					if (normalizedQuery.includes('select id from users where username')) {
						const username = String(params[0]).toLowerCase()
						const user = users.find(
							(row) => row.username.toLowerCase() === username,
						)
						return user ? ({ id: user.id } as T) : null
					}
					if (
						normalizedQuery.includes(
							'select count(*) as total from audit_events',
						)
					) {
						return {
							total: selectAuditEvents(normalizedQuery, params, {
								paginated: false,
							}).length,
						} as T
					}
					if (normalizedQuery.includes('from entitlement_daily_counters')) {
						return null
					}
					const count = countForQuery(normalizedQuery)
					if (count !== null) return { count } as T
					return null
				},
				async all<T>() {
					if (
						normalizedQuery.includes(
							'select id, username, email, created_at, updated_at from users order by id asc limit ? offset ?',
						)
					) {
						const pageSize = Number(params[0])
						const offset = Number(params[1])
						return {
							results: users
								.sort((left, right) => left.id - right.id)
								.slice(offset, offset + pageSize) as Array<T>,
						}
					}
					if (
						normalizedQuery.includes(
							'select id, username, email, plan from users order by id asc limit ? offset ?',
						)
					) {
						const pageSize = Number(params[0])
						const offset = Number(params[1])
						return {
							results: users
								.sort((left, right) => left.id - right.id)
								.slice(offset, offset + pageSize)
								.map((user) => ({
									id: user.id,
									username: user.username,
									email: user.email,
									plan: user.plan ?? null,
								})) as Array<T>,
						}
					}
					if (normalizedQuery.includes('where ur.user_id in')) {
						const userIds = params.map((value) => Number(value))
						return {
							results: userRoles
								.filter((row) => userIds.includes(row.user_id))
								.map((row) => ({
									user_id: row.user_id,
									role_name: row.role_name,
								})) as Array<T>,
						}
					}
					if (normalizedQuery.includes('from audit_events')) {
						return {
							results: selectAuditEvents(normalizedQuery, params, {
								paginated: true,
							}) as Array<T>,
						}
					}
					if (normalizedQuery.includes('from usage_rollups')) {
						return { results: [] as Array<T> }
					}
					return { results: [] as Array<T> }
				},
				async run() {
					if (normalizedQuery.startsWith('insert into users')) {
						const [username, email, passwordHash, emailVerifiedAt] = params
						if (
							users.some(
								(row) =>
									row.email.toLowerCase() === String(email ?? '').toLowerCase(),
							)
						) {
							throw new Error('UNIQUE constraint failed: users.email')
						}
						if (
							users.some(
								(row) =>
									row.username.toLowerCase() ===
									String(username ?? '').toLowerCase(),
							)
						) {
							throw new Error('UNIQUE constraint failed: users.username')
						}
						const now = new Date().toISOString()
						const user = {
							id: nextUserId,
							username: String(username),
							email: String(email),
							created_at: now,
							updated_at: now,
							password_hash: String(passwordHash),
							email_verified_at: String(emailVerifiedAt),
						}
						nextUserId += 1
						users.push(user)
						return { meta: { changes: 1, last_row_id: user.id } }
					}
					if (normalizedQuery.includes('insert or ignore into user_roles')) {
						const userId = Number(params[0])
						const roleName = String(params[1])
						if (
							!userRoles.some(
								(row) => row.user_id === userId && row.role_name === roleName,
							)
						) {
							userRoles.push({ user_id: userId, role_name: roleName })
						}
						return { meta: { changes: 1, last_row_id: 0 } }
					}
					if (normalizedQuery.startsWith('delete from password_resets')) {
						const userId = Number(params[0])
						for (let index = passwordResets.length - 1; index >= 0; index--) {
							if (passwordResets[index]?.user_id === userId) {
								passwordResets.splice(index, 1)
							}
						}
						return { meta: { changes: 1, last_row_id: 0 } }
					}
					if (normalizedQuery.startsWith('insert into password_resets')) {
						const [userId, tokenHash, expiresAt] = params
						passwordResets.push({
							user_id: Number(userId),
							token_hash: String(tokenHash),
							expires_at: Number(expiresAt),
						})
						return { meta: { changes: 1, last_row_id: 1 } }
					}
					if (normalizedQuery.startsWith('delete from users')) {
						const userId = Number(params[0])
						const index = users.findIndex((user) => user.id === userId)
						if (index >= 0) users.splice(index, 1)
						return { meta: { changes: index >= 0 ? 1 : 0, last_row_id: 0 } }
					}
					if (normalizedQuery.includes('insert into audit_events')) {
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
			})
			return {
				...createStatement([]),
				bind(...params: Array<unknown>) {
					return createStatement(params)
				},
			}
		},
	} as unknown as D1Database

	return { db, auditEvents, passwordResets, userRoles, users }
}

function createAdminCapabilityContext(db: D1Database) {
	return {
		env: { APP_DB: db } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: 'admin-user',
				email: 'admin@example.com',
				displayName: 'admin',
				roles: ['admin'],
			},
		}),
	}
}

test('admin capabilities list and get account metadata and query sanitized audit rows', async () => {
	const { db, auditEvents } = createAdminCapabilityTestDb({
		users: [
			{
				id: 1,
				username: 'admin',
				email: 'admin@example.com',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-02 00:00:00',
			},
			{
				id: 2,
				username: 'jane',
				email: 'jane@example.com',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
		],
		userRoles: [
			{ user_id: 1, role_name: 'admin' },
			{ user_id: 1, role_name: 'user' },
			{ user_id: 2, role_name: 'user' },
		],
	})
	const ctx = createAdminCapabilityContext(db)

	const list = await adminUserListCapability.handler({ pageSize: 10 }, ctx)
	expect(list).toMatchObject({
		total: 2,
		page: 1,
		pageSize: 10,
		users: [
			expect.objectContaining({
				id: 1,
				email: 'admin@example.com',
				roles: ['admin', 'user'],
			}),
			expect.objectContaining({
				id: 2,
				email: 'jane@example.com',
				roles: ['user'],
			}),
		],
	})

	const getByEmail = await adminUserGetCapability.handler(
		{ email: 'JANE@example.com' },
		ctx,
	)
	expect(getByEmail.user).toMatchObject({
		id: 2,
		username: 'jane',
		email: 'jane@example.com',
		roles: ['user'],
	})

	const usage = await adminUsageOverviewCapability.handler(
		{ pageSize: 10 },
		ctx,
	)
	expect(usage).toMatchObject({
		total: 2,
		page: 1,
		pageSize: 10,
		users: [
			expect.objectContaining({
				id: 1,
				email: 'admin@example.com',
				currentMonthUsage: expect.arrayContaining([
					expect.objectContaining({ metric: 'execute', eventCount: 0 }),
				]),
			}),
			expect.objectContaining({
				id: 2,
				email: 'jane@example.com',
			}),
		],
		selectedUser: expect.objectContaining({
			id: 1,
			entitlementConsumption: expect.any(Array),
			monthUsage: expect.any(Array),
		}),
	})

	const audit = await adminAuditLogQueryCapability.handler(
		{ action: 'admin_user_get', limit: 10 },
		ctx,
	)
	expect(audit.total).toBe(1)
	expect(audit.events).toEqual([
		expect.objectContaining({
			action: 'admin_user_get',
			category: 'admin',
			result: 'success',
			email_hash: expect.any(String),
			reason: 'mcp_admin_capability',
		}),
	])
	expect(audit.events[0]).not.toHaveProperty('email')
	expect(auditEvents.map((event) => event.action)).toEqual([
		'admin_user_list',
		'admin_user_get',
		'admin_usage_overview',
		'admin_audit_log_query',
	])
})

test('admin_user_create creates an account with a setup link and audit metadata', async () => {
	const { db, auditEvents, passwordResets, userRoles, users } =
		createAdminCapabilityTestDb({
			users: [
				{
					id: 1,
					username: 'admin',
					email: 'admin@example.com',
					created_at: '2026-01-01 00:00:00',
					updated_at: '2026-01-02 00:00:00',
				},
			],
			userRoles: [{ user_id: 1, role_name: 'admin' }],
		})
	const ctx = createAdminCapabilityContext(db)

	const result = await adminUserCreateCapability.handler(
		{ email: 'Person+Launch@Example.com' },
		ctx,
	)

	expect(result.createdUser).toMatchObject({
		userId: 2,
		email: 'person+launch@example.com',
		username: 'person-launch',
		setupTokenExpiresAt: expect.any(Number),
	})
	expect(result.createdUser.setupLink).toMatch(
		/^https:\/\/example\.com\/reset-password\?token=[0-9a-f]{64}$/,
	)
	expect(users.find((user) => user.id === 2)).toMatchObject({
		email: 'person+launch@example.com',
		username: 'person-launch',
		password_hash: 'admin_created_no_usable_password',
		email_verified_at: expect.any(String),
	})
	expect(userRoles).toContainEqual({ user_id: 2, role_name: 'user' })
	expect(passwordResets).toEqual([
		expect.objectContaining({
			user_id: 2,
			token_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
			expires_at: result.createdUser.setupTokenExpiresAt,
		}),
	])
	expect(auditEvents).toEqual([
		expect.objectContaining({
			action: 'admin_user_create',
			result: 'success',
			reason: 'target_user_id=2;target_email=***@example.com',
		}),
	])
})

test('admin capabilities reject non-admin direct handler calls', async () => {
	const { db } = createAdminCapabilityTestDb({
		users: [],
		userRoles: [],
	})
	await expect(
		adminUserListCapability.handler(
			{},
			{
				env: { APP_DB: db } as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
					user: {
						userId: 'user-1',
						email: 'user@example.com',
						displayName: 'user',
						roles: ['user'],
					},
				}),
			},
		),
	).rejects.toThrow(
		'MCP user lacks required role "admin" for capability "admin_user_list".',
	)
	await expect(
		adminUsageOverviewCapability.handler(
			{},
			{
				env: { APP_DB: db } as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
					user: {
						userId: 'user-1',
						email: 'user@example.com',
						displayName: 'user',
						roles: ['user'],
					},
				}),
			},
		),
	).rejects.toThrow(
		'MCP user lacks required role "admin" for capability "admin_usage_overview".',
	)
})
