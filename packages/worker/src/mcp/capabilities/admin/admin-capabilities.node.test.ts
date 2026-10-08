import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const lifecycleMocks = vi.hoisted(() => ({
	scheduleUserCreatedEvent: vi.fn(),
}))

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserCreatedEvent: (...args: Array<unknown>) =>
		lifecycleMocks.scheduleUserCreatedEvent(...args),
	scheduleUserDeletedEvent: vi.fn(),
}))

// These tests assert real `audit_events` rows written through the actual
// audit pipeline, so opt out of the shared audit-log-spy setup mock.
vi.unmock('#worker/audit-log.ts')
import { adminAuditLogQueryCapability } from './admin-audit-log-query.ts'
import { adminSystemEmailDeleteCapability } from './admin-system-email-delete.ts'
import { adminSystemEmailGetCapability } from './admin-system-email-get.ts'
import { adminSystemEmailListCapability } from './admin-system-email-list.ts'
import {
	emailAttachmentBlobKey,
	emailRawMimeKey,
} from '#worker/email/blob-keys.ts'
import { systemEmailOwnerId } from '#worker/email/system-email.ts'
import { adminUserUsageCapability } from './admin-user-usage.ts'
import { adminUserCreateCapability } from './admin-user-create.ts'
import { adminUserGetCapability } from './admin-user-get.ts'
import { adminUserListCapability } from './admin-user-list.ts'
import { adminUserUpdateCapability } from './admin-user-update.ts'
import { adminUserVerifyCapability } from './admin-user-verify.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
import { createInMemoryRunLogUsageEnv } from '#worker/test-support/run-log-usage.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { loadAdminUserByTarget } from '#worker/admin/users-data.ts'

const janeStableId = testStableUserIdFromEmail('jane@example.com')
const roleIds = { user: 1, admin: 2 } as const

type SeedUser = {
	username: string
	roles: Array<keyof typeof roleIds>
	plan?: string
	emailVerifiedAt?: string | null
	createdAt: string
}

const admin: SeedUser = {
	username: 'admin',
	roles: ['admin', 'user'],
	emailVerifiedAt: '2026-01-01T00:00:00.000Z',
	createdAt: '2026-01-01 00:00:00',
}
const jane: SeedUser = {
	username: 'jane',
	roles: ['user'],
	createdAt: '2026-01-03 00:00:00',
}

function createMemoryEmailBlobs(seed: Record<string, string> = {}) {
	const store = new Map<string, string>(Object.entries(seed))
	return {
		store,
		blobs: {
			get: async (key: string) => {
				const value = store.get(key)
				if (value == null) return null
				return { text: async () => value }
			},
			put: async (key: string, value: string) => {
				store.set(key, value)
			},
			delete: async (key: string) => {
				store.delete(key)
			},
			head: async (key: string) => (store.has(key) ? { key } : null),
		},
	}
}

function createAdminCapabilityTest(
	users: Array<SeedUser>,
	blobs?: ReturnType<typeof createMemoryEmailBlobs>['blobs'],
	callerRoles: Array<string> = ['admin'],
) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	applyAllMigrations(
		sqlite,
		new URL('../../../../../jobs-worker/migrations/', import.meta.url),
	)
	const auditSqlite = new DatabaseSync(':memory:')
	auditSqlite.exec(
		readFileSync(
			new URL(
				'../../../../audit-migrations/0001-audit-events.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	const insertUser = sqlite.prepare(
		`INSERT INTO users (id, username, email, password_hash, stable_user_id, plan, email_verified_at, created_at, updated_at)
		 VALUES (?, ?, ?, 'hash', ?, ?, ?, ?, ?)`,
	)
	const insertRole = sqlite.prepare(
		`INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`,
	)
	users.forEach((user, index) => {
		const email = `${user.username}@example.com`
		insertUser.run(
			index + 1,
			user.username,
			email,
			testStableUserIdFromEmail(email),
			user.plan ?? 'free',
			user.emailVerifiedAt ?? null,
			user.createdAt,
			user.createdAt,
		)
		for (const role of user.roles) insertRole.run(index + 1, roleIds[role])
	})
	const db = createD1FromSqlite(sqlite)
	const emailBlobs = blobs ?? createMemoryEmailBlobs().blobs
	const ctx = {
		env: {
			...createInMemoryRunLogUsageEnv().env,
			...createInMemoryUserMeterEnv().env,
			...createInMemoryRepoSessionIndexEnv(db),
			APP_DB: db,
			AUDIT_DB: createD1FromSqlite(auditSqlite),
			MAILBOX: {
				idFromName: (userId: string) =>
					({ userId }) as unknown as DurableObjectId,
				get: () => ({ countMessages: async () => ({ total: 0 }) }),
			},
			EMAIL_BLOBS: emailBlobs,
		} as unknown as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: 'admin-user',
				email: 'admin@example.com',
				displayName: 'admin',
				roles: callerRoles,
			},
		}),
	}
	return {
		db,
		sqlite,
		auditSqlite,
		ctx,
		auditEvents: () =>
			auditSqlite
				.prepare('SELECT action, result, reason FROM audit_events ORDER BY id')
				.all() as Array<{ action: string; result: string; reason: string }>,
		userRow: (email: string) =>
			sqlite
				.prepare(
					'SELECT id, email, stable_user_id, plan, email_verified_at FROM users WHERE email = ?',
				)
				.get(email) as Record<string, unknown> | undefined,
	}
}

test('admin capabilities list and get account metadata and query sanitized audit rows', async () => {
	const t = createAdminCapabilityTest([admin, jane])

	const list = await adminUserListCapability.handler({ pageSize: 10 }, t.ctx)
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
				stableUserId: janeStableId,
				email: 'jane@example.com',
				email_verified: false,
				email_verified_at: null,
				plan: 'free',
				manualPlan: 'free',
				stripePlan: null,
				effectivePlan: 'free',
				stripeCustomerLinked: false,
				roles: ['user'],
			}),
		],
	})

	const getByEmail = await adminUserGetCapability.handler(
		{ email: 'JANE@example.com' },
		t.ctx,
	)
	expect(getByEmail.user).toMatchObject({
		stableUserId: janeStableId,
		username: 'jane',
		email: 'jane@example.com',
		roles: ['user'],
	})

	const usage = await adminUserUsageCapability.handler(
		{ username: 'jane' },
		t.ctx,
	)
	expect(usage.usage).toMatchObject({
		stableUserId: janeStableId,
		username: 'jane',
		plan: 'free',
	})
	expect(usage.usage?.entitlementConsumption.length).toBeGreaterThan(0)
	await expect(
		adminUserUsageCapability.handler({ email: 'missing@example.com' }, t.ctx),
	).resolves.toEqual({ usage: null })

	// An invalid stable id must not fall through to the email lookup.
	await expect(
		loadAdminUserByTarget(t.db, {
			stableUserId: 'not-a-stable-id',
			email: 'admin@example.com',
		}),
	).resolves.toBeNull()

	const audit = await adminAuditLogQueryCapability.handler(
		{ action: 'adminUserGet', limit: 10 },
		t.ctx,
	)
	expect(audit.total).toBe(1)
	expect(audit.events).toEqual([
		expect.objectContaining({
			action: 'adminUserGet',
			category: 'admin',
			result: 'success',
			email_hash: expect.any(String),
			reason: 'mcp_admin_capability',
		}),
	])
	expect(audit.events[0]).not.toHaveProperty('email')
	expect(t.auditEvents().map((event) => event.action)).toEqual([
		'adminUserList',
		'adminUserGet',
		'adminUserUsage',
		'adminUserUsage',
		'adminAuditLogQuery',
	])
})

test('adminAuditLogQuery accepts legacy SQLite rowids through output parse', async () => {
	const t = createAdminCapabilityTest([admin])
	const insertAudit = t.auditSqlite.prepare(
		`INSERT INTO audit_events (id, category, action, result, timestamp)
		 VALUES (?, 'admin', ?, 'success', '2026-01-01T00:00:00.000Z')`,
	)
	insertAudit.run(0, 'legacy_seed_zero')
	insertAudit.run(-1, 'legacy_seed_negative')

	const audit = await adminAuditLogQueryCapability.handler({ limit: 10 }, t.ctx)
	expect(audit.events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: 0,
				action: 'legacy_seed_zero',
				category: 'admin',
				result: 'success',
			}),
			expect.objectContaining({
				id: -1,
				action: 'legacy_seed_negative',
				category: 'admin',
				result: 'success',
			}),
		]),
	)
})

test('admin system email capabilities read only system-owned mail and audit reads', async () => {
	const rawMimeKey = emailRawMimeKey(systemEmailOwnerId, 'system-message-1')
	const memoryBlobs = createMemoryEmailBlobs({
		[rawMimeKey]: 'Subject: Abuse\r\n\r\nSystem body.',
	})
	const t = createAdminCapabilityTest([admin], memoryBlobs.blobs)
	t.sqlite.exec(
		`INSERT INTO email_inboxes (id, user_id, name, created_at, updated_at)
		 VALUES ('system-inbox-1', 'system:email', 'abuse', '2026-01-01', '2026-01-01')`,
	)
	t.sqlite
		.prepare(
			`INSERT INTO system_email_messages (id, direction, inbox_id, from_address, envelope_from,
			   to_addresses_json, reply_to_addresses_json, headers_json, text_body, raw_mime_key,
			   subject, processing_status, raw_size, received_at, created_at, updated_at)
			 VALUES ('system-message-1', 'inbound', 'system-inbox-1', 'sender@example.net',
			   'bounce@example.net', '["abuse@example.com"]', '["sender@example.net"]',
			   '{"from":["Sender <sender@example.net>"]}', 'System body.', ?, 'Abuse report',
			   'stored', 32, '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z',
			   '2026-01-03T00:00:00.000Z')`,
		)
		.run(rawMimeKey)

	const list = await adminSystemEmailListCapability.handler(
		{ pageSize: 10 },
		t.ctx,
	)
	expect(list.messages).toEqual([
		expect.objectContaining({
			id: 'system-message-1',
			inbox_local_part: 'abuse',
			subject: 'Abuse report',
			to_addresses: ['abuse@example.com'],
		}),
	])
	const get = await adminSystemEmailGetCapability.handler(
		{ id: 'system-message-1' },
		t.ctx,
	)
	expect(get.message).toMatchObject({
		id: 'system-message-1',
		text_body: 'System body.',
		raw_mime: 'Subject: Abuse\r\n\r\nSystem body.',
	})
	// User mail lives in per-user mailboxes, never in the system graph.
	await expect(
		adminSystemEmailGetCapability.handler({ id: 'user-message-1' }, t.ctx),
	).resolves.toEqual({ message: null })
	expect(t.auditEvents().map((event) => event.action)).toEqual([
		'adminSystemEmailList',
		'adminSystemEmailGet',
		'adminSystemEmailGet',
	])
	expect(t.auditEvents()[1]).toMatchObject({
		reason: 'target_message_id=system-message-1',
	})
})

test('adminSystemEmailDelete removes system mail graph rows and blobs, refuses non-admins and missing ids', async () => {
	const messageId = 'system-message-delete-1'
	const rawMimeKey = emailRawMimeKey(systemEmailOwnerId, messageId)
	const attachmentId = 'system-attachment-delete-1'
	const attachmentKey = emailAttachmentBlobKey(
		systemEmailOwnerId,
		messageId,
		attachmentId,
	)
	const memoryBlobs = createMemoryEmailBlobs({
		[rawMimeKey]: 'Subject: Phish\r\n\r\nOpen the rar.',
		[attachmentKey]: 'fake-rar-bytes',
	})
	const t = createAdminCapabilityTest([admin], memoryBlobs.blobs)
	t.sqlite.exec(
		`INSERT INTO email_inboxes (id, user_id, name, created_at, updated_at)
		 VALUES ('system-inbox-delete', 'system:email', 'kody', '2026-01-01', '2026-01-01');
		 INSERT INTO system_email_threads (
			id, inbox_id, subject_normalized, last_message_at, created_at, updated_at
		 ) VALUES (
			'system-thread-delete', 'system-inbox-delete', 'gemini order',
			'2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z'
		 );`,
	)
	t.sqlite
		.prepare(
			`INSERT INTO system_email_messages (
				id, direction, inbox_id, thread_id, from_address, envelope_from,
				to_addresses_json, subject, text_body, raw_mime_key, processing_status,
				raw_size, received_at, created_at, updated_at
			) VALUES (
				?, 'inbound', 'system-inbox-delete', 'system-thread-delete',
				'phish@example.net', 'phish@example.net', '["kody@kody.codes"]',
				'Gemini Order No.206378105', 'Open the rar.', ?, 'stored', 64,
				'2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z',
				'2026-01-03T00:00:00.000Z'
			)`,
		)
		.run(messageId, rawMimeKey)
	t.sqlite
		.prepare(
			`INSERT INTO system_email_attachments (
				id, message_id, filename, content_type, size, storage_kind, storage_key, created_at
			) VALUES (?, ?, 'invoice.rar', 'application/x-rar-compressed', 12, 'external', ?, ?)`,
		)
		.run(attachmentId, messageId, attachmentKey, '2026-01-03T00:00:00.000Z')
	t.sqlite
		.prepare(
			`INSERT INTO system_email_delivery_events (
				id, message_id, event_type, provider, fingerprint, detail_json,
				state, created_at
			) VALUES ('system-event-delete', ?, 'received', 'test', 'fp-delete', '{}',
				'received', ?)`,
		)
		.run(messageId, '2026-01-03T00:00:00.000Z')
	t.sqlite
		.prepare(
			`INSERT INTO system_email_delivery_events (
				id, message_id, event_type, provider, fingerprint, detail_json,
				state, created_at
			) VALUES (
				'email-inbound-dedupe:fp-delete', NULL, 'receive_started',
				'cloudflare-email-routing-dedupe', 'fp-delete',
				json_object('messageId', ?), 'pending', ?
			)`,
		)
		.run(messageId, '2026-01-03T00:00:00.000Z')

	const nonAdmin = createAdminCapabilityTest([jane], memoryBlobs.blobs, [
		'user',
	])
	await expect(
		adminSystemEmailDeleteCapability.handler(
			{ message_id: messageId },
			nonAdmin.ctx,
		),
	).rejects.toThrow(/admin/i)

	await expect(
		adminSystemEmailDeleteCapability.handler(
			{ message_id: 'missing-system-message' },
			t.ctx,
		),
	).rejects.toThrow('System email message not found: missing-system-message')
	// User-owned mailbox ids are not on the system graph; refuse as not found.
	await expect(
		adminSystemEmailDeleteCapability.handler(
			{ message_id: 'user-message-1' },
			t.ctx,
		),
	).rejects.toThrow('System email message not found: user-message-1')

	const deleted = await adminSystemEmailDeleteCapability.handler(
		{ message_id: messageId },
		t.ctx,
	)
	expect(deleted).toEqual({
		ownerId: systemEmailOwnerId,
		deleted: true,
		message_id: messageId,
	})
	expect(
		t.sqlite
			.prepare(`SELECT id FROM system_email_messages WHERE id = ?`)
			.get(messageId),
	).toBeUndefined()
	expect(
		t.sqlite
			.prepare(`SELECT id FROM system_email_attachments WHERE message_id = ?`)
			.all(messageId),
	).toEqual([])
	expect(
		t.sqlite
			.prepare(
				`SELECT id FROM system_email_delivery_events WHERE message_id = ?`,
			)
			.all(messageId),
	).toEqual([])
	expect(
		t.sqlite
			.prepare(
				`SELECT state, event_type, message_id
				FROM system_email_delivery_events
				WHERE id = 'email-inbound-dedupe:fp-delete'`,
			)
			.get(),
	).toEqual({
		state: 'rejected',
		event_type: 'rejected',
		message_id: null,
	})
	expect(
		t.sqlite
			.prepare(`SELECT id FROM system_email_threads WHERE id = ?`)
			.get('system-thread-delete'),
	).toBeUndefined()
	expect(memoryBlobs.store.has(rawMimeKey)).toBe(false)
	expect(memoryBlobs.store.has(attachmentKey)).toBe(false)
	expect(t.auditEvents().at(-1)).toMatchObject({
		action: 'adminSystemEmailDelete',
		result: 'success',
		reason: `target_message_id=${messageId}`,
	})
	expect(
		t
			.auditEvents()
			.some(
				(event) =>
					event.action === 'adminSystemEmailDelete' &&
					event.result === 'failure',
			),
	).toBe(true)
})

test('adminUserCreate records audit metadata and assigns the default role', async () => {
	const t = createAdminCapabilityTest([admin])
	const stableUserId = testStableUserIdFromEmail('person+launch@example.com')

	const result = await adminUserCreateCapability.handler(
		{ email: 'Person+Launch@Example.com' },
		t.ctx,
	)

	expect(result.createdUser).toMatchObject({
		stableUserId,
		email: 'person+launch@example.com',
	})
	const created = t.userRow('person+launch@example.com')
	expect(created).toMatchObject({
		stable_user_id: stableUserId,
		plan: 'free',
	})
	expect(
		t.sqlite
			.prepare(
				'SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?',
			)
			.all(created?.['id'] as number)
			.map((row) => row['name']),
	).toEqual(['user'])
	expect(t.auditEvents()).toEqual([
		{
			action: 'adminUserCreate',
			result: 'success',
			reason: `target_stable_user_id=${stableUserId};target_email=***@example.com`,
		},
	])
	expect(lifecycleMocks.scheduleUserCreatedEvent).toHaveBeenCalledWith({
		env: expect.anything(),
		source: 'admin',
		user: {
			id: stableUserId,
			username: result.createdUser.username,
			email: 'person+launch@example.com',
		},
	})
})

test('adminUserUpdate sets plan, maps null clear to free, and rejects unknown users and plans', async () => {
	const t = createAdminCapabilityTest([admin, { ...jane, plan: 'max' }])
	const janePlan = () => t.userRow('jane@example.com')?.['plan']

	const setByEmail = await adminUserUpdateCapability.handler(
		{ email: 'JANE@example.com', plan: 'pro' },
		t.ctx,
	)
	expect(setByEmail.user).toMatchObject({
		stableUserId: janeStableId,
		username: 'jane',
		plan: 'pro',
		roles: ['user'],
	})
	expect(janePlan()).toBe('pro')

	const clearById = await adminUserUpdateCapability.handler(
		{ stableUserId: janeStableId, plan: null },
		t.ctx,
	)
	expect(clearById.user).toMatchObject({
		stableUserId: janeStableId,
		plan: 'free',
	})
	expect(janePlan()).toBe('free')

	await expect(
		adminUserUpdateCapability.handler(
			{ email: 'missing@example.com', plan: 'pro' },
			t.ctx,
		),
	).rejects.toThrow('User not found.')
	await expect(
		adminUserUpdateCapability.handler(
			{ id: 1, plan: 'enterprise' } as never,
			t.ctx,
		),
	).rejects.toThrow('Invalid input for capability "adminUserUpdate"')
	expect(t.auditEvents()).toEqual([
		{
			action: 'adminUserUpdate',
			result: 'success',
			reason: `target_stable_user_id=${janeStableId};plan=pro`,
		},
		{
			action: 'adminUserUpdate',
			result: 'success',
			reason: `target_stable_user_id=${janeStableId};plan=free`,
		},
		{
			action: 'adminUserUpdate',
			result: 'failure',
			reason: 'User not found.',
		},
	])
})

test('adminUserVerify marks verified and mints a one-time url with audit metadata', async () => {
	const t = createAdminCapabilityTest([admin, jane])

	const minted = await adminUserVerifyCapability.handler(
		{ email: 'JANE@example.com', action: 'mint_verify_url' },
		t.ctx,
	)
	expect(minted.user.email_verified).toBe(false)
	expect(minted.verifyUrl).toMatch(
		/^https:\/\/example.com\/verify-email\?token=/,
	)
	expect(minted.expiresAt).toBeGreaterThan(Date.now())

	const verified = await adminUserVerifyCapability.handler(
		{ stableUserId: janeStableId, action: 'mark_verified' },
		t.ctx,
	)
	expect(verified.user.email_verified).toBe(true)
	expect(verified.verifyUrl).toBeNull()
	expect(t.userRow('jane@example.com')?.['email_verified_at']).toBeTruthy()

	await expect(
		adminUserVerifyCapability.handler(
			{ email: 'jane@example.com', action: 'mint_verify_url' },
			t.ctx,
		),
	).rejects.toThrow('Email is already verified.')
	expect(t.auditEvents()).toEqual([
		{
			action: 'adminUserVerify',
			result: 'success',
			reason: `target_stable_user_id=${janeStableId};action=mint_verify_url`,
		},
		{
			action: 'adminUserVerify',
			result: 'success',
			reason: `target_stable_user_id=${janeStableId};action=mark_verified`,
		},
		{
			action: 'adminUserVerify',
			result: 'failure',
			reason: 'Email is already verified.',
		},
	])
})
