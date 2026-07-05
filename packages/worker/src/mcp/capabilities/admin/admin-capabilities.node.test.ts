import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { adminAuditLogQueryCapability } from './admin-audit-log-query.ts'
import { adminUserGetCapability } from './admin-user-get.ts'
import { adminUserListCapability } from './admin-user-list.ts'

type UserRow = {
	id: number
	username: string
	email: string
	created_at: string
	updated_at: string
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

function normalizeQuery(query: string) {
	return query.replace(/\s+/g, ' ').trim().toLowerCase()
}

function createAdminCapabilityTestDb(input: {
	users: Array<UserRow>
	userRoles: Array<UserRoleRow>
}) {
	const users = input.users.map((user) => ({ ...user }))
	const userRoles = input.userRoles.map((row) => ({ ...row }))
	const auditEvents: Array<AuditEventRow> = []

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
							'select id, username, email, created_at, updated_at from users where email = ? collate nocase',
						)
					) {
						const email = String(params[0]).toLowerCase()
						return (users.find((user) => user.email.toLowerCase() === email) ??
							null) as T | null
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
					return { results: [] as Array<T> }
				},
				async run() {
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

	return { db, auditEvents }
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
		'admin_audit_log_query',
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
})
