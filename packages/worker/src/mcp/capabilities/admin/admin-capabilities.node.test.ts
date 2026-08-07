import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

// These tests assert real `audit_events` rows written through the actual
// audit pipeline, so opt out of the shared audit-log-spy setup mock.
vi.unmock('#worker/audit-log.ts')
import { adminAuditLogQueryCapability } from './admin-audit-log-query.ts'
import { adminSystemEmailGetCapability } from './admin-system-email-get.ts'
import { adminSystemEmailListCapability } from './admin-system-email-list.ts'
import { adminUserUsageCapability } from './admin-user-usage.ts'
import { adminUserCreateCapability } from './admin-user-create.ts'
import { adminUserGetCapability } from './admin-user-get.ts'
import { adminUserListCapability } from './admin-user-list.ts'
import { adminUserUpdateCapability } from './admin-user-update.ts'
import { createInMemoryRunLogUsageEnv } from '#worker/test-support/run-log-usage.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { loadAdminUserByTarget } from '#worker/admin/users-data.ts'

type UserRow = {
	id: number
	username: string
	email: string
	stable_user_id: string
	plan?: string
	suspended_at?: string | null
	email_outbound_paused_at?: string | null
	created_at: string
	updated_at: string
	password_hash?: string
	email_verified_at?: string | null
}

function adminTestUser(
	input: Omit<UserRow, 'stable_user_id'> & { stable_user_id?: string },
): UserRow {
	return {
		...input,
		plan: input.plan ?? 'free',
		suspended_at: input.suspended_at ?? null,
		email_outbound_paused_at: input.email_outbound_paused_at ?? null,
		stable_user_id:
			input.stable_user_id ?? testStableUserIdFromEmail(input.email),
	}
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

type SystemEmailMessageRow = {
	id: string
	user_id: string
	inbox_id: string | null
	from_address: string | null
	envelope_from: string | null
	to_addresses_json?: string
	cc_addresses_json?: string
	reply_to_addresses_json?: string
	headers_json?: string
	text_body?: string | null
	html_body?: string | null
	raw_mime_key?: string | null
	subject: string | null
	processing_status: string
	raw_size: number
	received_at: string | null
	created_at: string
}

type EmailInboxAddressRow = {
	inbox_id: string
	user_id: string
	local_part: string
}

function normalizeQuery(query: string) {
	return query.replace(/\s+/g, ' ').trim().toLowerCase()
}

function createAdminCapabilityTestDb(input: {
	users: Array<UserRow>
	userRoles: Array<UserRoleRow>
	systemEmailMessages?: Array<SystemEmailMessageRow>
	emailInboxAddresses?: Array<EmailInboxAddressRow>
}) {
	let nextUserId = Math.max(0, ...input.users.map((user) => user.id)) + 1
	const users = input.users.map((user) => ({ ...user }))
	const userRoles = input.userRoles.map((row) => ({ ...row }))
	const auditEvents: Array<AuditEventRow> = []
	const passwordResets: Array<PasswordResetRow> = []
	const systemEmailMessages = (input.systemEmailMessages ?? []).map((row) => ({
		...row,
	}))
	const emailInboxAddresses = (input.emailInboxAddresses ?? []).map((row) => ({
		...row,
	}))

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
			'secret_entries',
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
					if (
						normalizedQuery.includes(
							'select authority, graph_mismatch_count, provider_link_count from system_email_graph_authority',
						)
					) {
						return {
							authority: 'dedicated',
							graph_mismatch_count: 0,
							provider_link_count: 0,
						} as T
					}
					if (normalizedQuery.includes('as unsupported')) {
						return { unsupported: 0 } as T
					}
					if (normalizedQuery.includes('select count(*) as total from users')) {
						return { total: users.length } as T
					}
					if (
						normalizedQuery.includes(
							'select id, stable_user_id, username, email, email_verified_at, plan, suspended_at, email_outbound_paused_at, created_at, updated_at from users where stable_user_id = ?',
						)
					) {
						return (users.find((user) => user.stable_user_id === params[0]) ??
							null) as T | null
					}
					if (
						normalizedQuery.includes(
							'select id, username, email, plan, stripe_plan, stable_user_id from users where stable_user_id = ?',
						)
					) {
						const user = users.find((row) => row.stable_user_id === params[0])
						return (
							user
								? {
										id: user.id,
										username: user.username,
										email: user.email,
										plan: user.plan ?? 'free',
										stripe_plan: null,
										stable_user_id: user.stable_user_id,
									}
								: null
						) as T | null
					}
					if (
						normalizedQuery.includes(
							'select id, stable_user_id, username, email, email_verified_at, plan, suspended_at, email_outbound_paused_at, created_at, updated_at from users where email = ? collate nocase',
						)
					) {
						const email = String(params[0]).toLowerCase()
						return (users.find((user) => user.email.toLowerCase() === email) ??
							null) as T | null
					}
					if (
						normalizedQuery.includes(
							'select id, stable_user_id, username, email, email_verified_at, plan, suspended_at, email_outbound_paused_at, created_at, updated_at from users where username = ? collate nocase',
						)
					) {
						const username = String(params[0]).toLowerCase()
						return (users.find(
							(user) => user.username.toLowerCase() === username,
						) ?? null) as T | null
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
					if (
						normalizedQuery.includes(
							'select count(*) as total from system_email_messages',
						)
					) {
						return {
							total: systemEmailMessages.filter(
								(row) => row.user_id === 'system:email' && row.id,
							).length,
						} as T
					}
					if (
						normalizedQuery.includes('from system_email_messages as message') &&
						normalizedQuery.includes('message.id = ?')
					) {
						const message = systemEmailMessages.find(
							(row) => row.user_id === 'system:email' && row.id === params[1],
						)
						if (!message) return null
						const address = emailInboxAddresses.find(
							(row) =>
								row.user_id === message.user_id &&
								row.inbox_id === message.inbox_id,
						)
						return {
							...message,
							inbox_local_part: address?.local_part ?? '',
							to_addresses_json: message.to_addresses_json ?? '[]',
							cc_addresses_json: message.cc_addresses_json ?? '[]',
							reply_to_addresses_json: message.reply_to_addresses_json ?? '[]',
							headers_json: message.headers_json ?? '{}',
							text_body: message.text_body ?? null,
							html_body: message.html_body ?? null,
							raw_mime_key: message.raw_mime_key ?? null,
						} as T
					}
					const count = countForQuery(normalizedQuery)
					if (count !== null) return { count } as T
					return null
				},
				async all<T>() {
					if (
						normalizedQuery.includes(
							'select id, stable_user_id, username, email, email_verified_at, plan, suspended_at, email_outbound_paused_at, created_at, updated_at from users order by id asc limit ? offset ?',
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
							'select id, username, email, plan, stable_user_id from users order by id asc limit ? offset ?',
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
									plan: user.plan ?? 'free',
									stable_user_id: user.stable_user_id,
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
					if (
						normalizedQuery.includes('from system_email_messages as message') &&
						normalizedQuery.includes("message.direction = 'inbound'")
					) {
						const pageSize = Number(params[1])
						const offset = Number(params[2])
						return {
							results: systemEmailMessages
								.filter((row) => row.user_id === params[0])
								.sort(
									(left, right) =>
										right.created_at.localeCompare(left.created_at) ||
										right.id.localeCompare(left.id),
								)
								.slice(offset, offset + pageSize)
								.map((message) => {
									const address = emailInboxAddresses.find(
										(row) =>
											row.user_id === message.user_id &&
											row.inbox_id === message.inbox_id,
									)
									return {
										...message,
										inbox_local_part: address?.local_part ?? '',
									}
								}) as Array<T>,
						}
					}
					if (normalizedQuery.includes('from system_email_attachments')) {
						return { results: [] as Array<T> }
					}
					if (normalizedQuery.includes('from usage_rollups')) {
						return { results: [] as Array<T> }
					}
					return { results: [] as Array<T> }
				},
				async run() {
					if (normalizedQuery.startsWith('insert into users')) {
						const [
							username,
							email,
							passwordHash,
							emailVerifiedAt,
							stableUserId,
						] = params
						if (
							typeof stableUserId !== 'string' ||
							stableUserId.trim().length === 0
						) {
							throw new Error(
								'INSERT INTO users requires a non-empty stable_user_id bind parameter',
							)
						}
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
						const user: UserRow = {
							id: nextUserId,
							username: String(username),
							email: String(email),
							stable_user_id: stableUserId,
							plan: 'free',
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
					if (
						normalizedQuery.includes(
							'update users set plan = ?, updated_at = ? where id = ?',
						)
					) {
						const user = users.find((row) => row.id === Number(params[2]))
						if (!user) return { meta: { changes: 0, last_row_id: 0 } }
						user.plan = params[0] == null ? 'free' : String(params[0])
						user.updated_at = String(params[1])
						return { meta: { changes: 1, last_row_id: 0 } }
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

const userMeter = createInMemoryUserMeterEnv()
const runLog = createInMemoryRunLogUsageEnv()

function createAdminCapabilityContext(
	db: D1Database,
	blobs?: Pick<R2Bucket, 'get'>,
) {
	return {
		env: {
			...runLog.env,
			...userMeter.env,
			APP_DB: db,
			AUDIT_DB: db,
			MAILBOX: {
				idFromName: (userId: string) =>
					({ userId }) as unknown as DurableObjectId,
				get: () => ({
					countMessages: async () => ({ total: 0 }),
				}),
			},
			EMAIL_BLOBS: blobs ?? {
				get: async () => null,
			},
		} as unknown as Env,
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
			adminTestUser({
				id: 1,
				username: 'admin',
				email: 'admin@example.com',
				email_verified_at: '2026-01-01T00:00:00.000Z',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-02 00:00:00',
			}),
			adminTestUser({
				id: 2,
				username: 'jane',
				email: 'jane@example.com',
				email_verified_at: null,
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			}),
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
				stableUserId: testStableUserIdFromEmail('admin@example.com'),
				email: 'admin@example.com',
				email_verified: true,
				email_verified_at: '2026-01-01T00:00:00.000Z',
				roles: ['admin', 'user'],
			}),
			expect.objectContaining({
				stableUserId: testStableUserIdFromEmail('jane@example.com'),
				email: 'jane@example.com',
				email_verified: false,
				email_verified_at: null,
				roles: ['user'],
			}),
		],
	})

	const getByEmail = await adminUserGetCapability.handler(
		{ email: 'JANE@example.com' },
		ctx,
	)
	expect(getByEmail.user).toMatchObject({
		stableUserId: testStableUserIdFromEmail('jane@example.com'),
		username: 'jane',
		email: 'jane@example.com',
		roles: ['user'],
	})

	const usage = await adminUserUsageCapability.handler(
		{ username: 'jane' },
		ctx,
	)
	expect(usage.usage).toMatchObject({
		stableUserId: testStableUserIdFromEmail('jane@example.com'),
		username: 'jane',
		plan: 'free',
	})
	expect(usage.usage?.entitlementConsumption.length).toBeGreaterThan(0)
	expect(
		await adminUserUsageCapability.handler(
			{ email: 'missing@example.com' },
			ctx,
		),
	).toEqual({ usage: null })

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
		'admin_user_usage',
		'admin_user_usage',
		'admin_audit_log_query',
	])
})

test('admin_audit_log_query accepts SQLite zero rowids through output parse', async () => {
	const { db, auditEvents } = createAdminCapabilityTestDb({
		users: [
			adminTestUser({
				id: 1,
				username: 'admin',
				email: 'admin@example.com',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-02 00:00:00',
			}),
		],
		userRoles: [{ user_id: 1, role_name: 'admin' }],
	})
	auditEvents.push({
		id: 0,
		category: 'admin',
		action: 'legacy_seed',
		result: 'success',
		email_hash: null,
		ip_hash: null,
		client_id: null,
		path: null,
		reason: null,
		timestamp: '2026-01-01T00:00:00.000Z',
	})
	const ctx = createAdminCapabilityContext(db)

	const audit = await adminAuditLogQueryCapability.handler(
		{ action: 'legacy_seed', limit: 10 },
		ctx,
	)
	expect(audit.events).toEqual([
		expect.objectContaining({
			id: 0,
			action: 'legacy_seed',
			category: 'admin',
			result: 'success',
		}),
	])
})

test('admin system email capabilities read only system-owned mail and audit reads', async () => {
	const { db, auditEvents } = createAdminCapabilityTestDb({
		users: [
			adminTestUser({
				id: 1,
				username: 'admin',
				email: 'admin@example.com',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-02 00:00:00',
			}),
		],
		userRoles: [{ user_id: 1, role_name: 'admin' }],
		emailInboxAddresses: [
			{
				inbox_id: 'system-inbox-1',
				user_id: 'system:email',
				local_part: 'abuse',
			},
		],
		systemEmailMessages: [
			{
				id: 'system-message-1',
				user_id: 'system:email',
				inbox_id: 'system-inbox-1',
				from_address: 'sender@example.net',
				envelope_from: 'bounce@example.net',
				to_addresses_json: '["abuse@example.com"]',
				cc_addresses_json: '[]',
				reply_to_addresses_json: '["sender@example.net"]',
				headers_json: '{"from":["Sender <sender@example.net>"]}',
				text_body: 'System body.',
				html_body: null,
				raw_mime_key: 'email-raw:v1:system:email/system-message-1',
				subject: 'Abuse report',
				processing_status: 'stored',
				raw_size: 32,
				received_at: '2026-01-03T00:00:00.000Z',
				created_at: '2026-01-03T00:00:00.000Z',
			},
			{
				id: 'user-message-1',
				user_id: 'user-123',
				inbox_id: 'user-inbox-1',
				from_address: 'private@example.net',
				envelope_from: 'private@example.net',
				subject: 'Private user mail',
				processing_status: 'stored',
				raw_size: 12,
				received_at: '2026-01-04T00:00:00.000Z',
				created_at: '2026-01-04T00:00:00.000Z',
			},
		],
	})
	const rawMimeByKey = new Map([
		[
			'email-raw:v1:system:email/system-message-1',
			'Subject: Abuse\r\n\r\nSystem body.',
		],
	])
	const ctx = createAdminCapabilityContext(db, {
		get: async (key: string) => {
			const value = rawMimeByKey.get(key)
			if (value == null) return null
			return { text: async () => value }
		},
	})

	const list = await adminSystemEmailListCapability.handler(
		{ pageSize: 10 },
		ctx,
	)
	expect(list.messages).toEqual([
		expect.objectContaining({
			id: 'system-message-1',
			inbox_local_part: 'abuse',
			subject: 'Abuse report',
		}),
	])

	const get = await adminSystemEmailGetCapability.handler(
		{ id: 'system-message-1' },
		ctx,
	)
	expect(get.message).toMatchObject({
		id: 'system-message-1',
		text_body: 'System body.',
		raw_mime: 'Subject: Abuse\r\n\r\nSystem body.',
	})
	expect(
		await adminSystemEmailGetCapability.handler({ id: 'user-message-1' }, ctx),
	).toEqual({ message: null })
	expect(auditEvents.map((event) => event.action)).toEqual([
		'admin_system_email_list',
		'admin_system_email_get',
		'admin_system_email_get',
	])
	expect(auditEvents[1]).toMatchObject({
		reason: 'target_message_id=system-message-1',
	})
})

test('insert into users mock rejects missing stable_user_id bind parameter', async () => {
	const { db } = createAdminCapabilityTestDb({
		users: [],
		userRoles: [],
	})
	const insertSql = `INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id)
 VALUES (?, ?, ?, ?, ?)`

	await expect(
		db
			.prepare(insertSql)
			.bind('testuser', 'test@example.com', 'hash', '2026-01-01T00:00:00.000Z')
			.run(),
	).rejects.toThrow(
		'INSERT INTO users requires a non-empty stable_user_id bind parameter',
	)

	await expect(
		db
			.prepare(insertSql)
			.bind(
				'testuser',
				'test@example.com',
				'hash',
				'2026-01-01T00:00:00.000Z',
				'   ',
			)
			.run(),
	).rejects.toThrow(
		'INSERT INTO users requires a non-empty stable_user_id bind parameter',
	)
})

test('admin_user_create records audit metadata and assigns the default role', async () => {
	const { db, auditEvents, userRoles, users } = createAdminCapabilityTestDb({
		users: [
			adminTestUser({
				id: 1,
				username: 'admin',
				email: 'admin@example.com',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-02 00:00:00',
			}),
		],
		userRoles: [{ user_id: 1, role_name: 'admin' }],
	})
	const ctx = createAdminCapabilityContext(db)

	const result = await adminUserCreateCapability.handler(
		{ email: 'Person+Launch@Example.com' },
		ctx,
	)

	expect(result.createdUser).toMatchObject({
		stableUserId: testStableUserIdFromEmail('person+launch@example.com'),
		email: 'person+launch@example.com',
	})
	expect(users.find((user) => user.id === 2)).toMatchObject({
		email: 'person+launch@example.com',
		stable_user_id: testStableUserIdFromEmail('person+launch@example.com'),
		plan: 'free',
	})
	expect(userRoles).toContainEqual({ user_id: 2, role_name: 'user' })
	expect(auditEvents).toEqual([
		expect.objectContaining({
			action: 'admin_user_create',
			result: 'success',
			reason: `target_stable_user_id=${testStableUserIdFromEmail('person+launch@example.com')};target_email=***@example.com`,
		}),
	])
})

test('admin_user_update sets plan and maps null clear to free with audit metadata', async () => {
	const { db, auditEvents, users } = createAdminCapabilityTestDb({
		users: [
			adminTestUser({
				id: 1,
				username: 'admin',
				email: 'admin@example.com',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-02 00:00:00',
			}),
			adminTestUser({
				id: 2,
				username: 'jane',
				email: 'jane@example.com',
				email_verified_at: null,
				plan: 'max',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			}),
		],
		userRoles: [
			{ user_id: 1, role_name: 'admin' },
			{ user_id: 2, role_name: 'user' },
		],
	})
	const ctx = createAdminCapabilityContext(db)

	const setByEmail = await adminUserUpdateCapability.handler(
		{ email: 'JANE@example.com', plan: 'pro' },
		ctx,
	)
	expect(setByEmail.user).toMatchObject({
		stableUserId: testStableUserIdFromEmail('jane@example.com'),
		username: 'jane',
		plan: 'pro',
		roles: ['user'],
	})
	expect(users.find((user) => user.id === 2)?.plan).toBe('pro')

	const clearById = await adminUserUpdateCapability.handler(
		{
			stableUserId: testStableUserIdFromEmail('jane@example.com'),
			plan: null,
		},
		ctx,
	)
	expect(clearById.user).toMatchObject({
		stableUserId: testStableUserIdFromEmail('jane@example.com'),
		plan: 'free',
	})
	expect(users.find((user) => user.id === 2)?.plan).toBe('free')

	expect(auditEvents).toEqual([
		expect.objectContaining({
			action: 'admin_user_update',
			result: 'success',
			reason: `target_stable_user_id=${testStableUserIdFromEmail('jane@example.com')};plan=pro`,
		}),
		expect.objectContaining({
			action: 'admin_user_update',
			result: 'success',
			reason: `target_stable_user_id=${testStableUserIdFromEmail('jane@example.com')};plan=free`,
		}),
	])
})

test('admin_user_update rejects unknown users and unknown plan names', async () => {
	const { db, auditEvents } = createAdminCapabilityTestDb({
		users: [
			adminTestUser({
				id: 1,
				username: 'admin',
				email: 'admin@example.com',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-02 00:00:00',
			}),
		],
		userRoles: [{ user_id: 1, role_name: 'admin' }],
	})
	const ctx = createAdminCapabilityContext(db)

	await expect(
		adminUserUpdateCapability.handler(
			{ email: 'missing@example.com', plan: 'pro' },
			ctx,
		),
	).rejects.toThrow('User not found.')
	expect(auditEvents).toEqual([
		expect.objectContaining({
			action: 'admin_user_update',
			result: 'failure',
			reason: 'User not found.',
		}),
	])

	await expect(
		adminUserUpdateCapability.handler(
			{ id: 1, plan: 'enterprise' } as never,
			ctx,
		),
	).rejects.toThrow()
})

test('admin user lookup does not fall through from an invalid stable id', async () => {
	const { db } = createAdminCapabilityTestDb({
		users: [
			adminTestUser({
				id: 1,
				username: 'admin',
				email: 'admin@example.com',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-02 00:00:00',
			}),
		],
		userRoles: [{ user_id: 1, role_name: 'admin' }],
	})

	await expect(
		loadAdminUserByTarget(db, {
			stableUserId: 'not-a-stable-id',
			email: 'admin@example.com',
		}),
	).resolves.toBeNull()
})
