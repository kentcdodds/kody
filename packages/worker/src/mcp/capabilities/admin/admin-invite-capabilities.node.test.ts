import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { adminInviteCreateCapability } from './admin-invite-create.ts'
import { adminInviteListCapability } from './admin-invite-list.ts'

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function createContext(
	roles: Array<string>,
	envOverrides: Record<string, unknown> = {},
) {
	const adminStableUserId = testStableUserIdFromEmail('admin@example.com')
	return {
		env: {
			APP_DB: {} as D1Database,
			...envOverrides,
		} as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: adminStableUserId,
				email: 'admin@example.com',
				displayName: 'admin',
				roles,
			},
		}),
		adminStableUserId,
	}
}

function seedAdminUser(sqlite: DatabaseSync, stableUserId: string) {
	sqlite.exec(`
		INSERT INTO users (username, email, stable_user_id, password_hash)
		VALUES (
			'admin',
			'admin@example.com',
			${quoteSqlString(stableUserId)},
			'oauth_created_no_usable_password'
		);
	`)
}

test('adminInviteCreate and adminInviteList: admin-only, normalize, bulk, audit', async () => {
	const userCtx = createContext(['user'])
	await expect(adminInviteListCapability.handler({}, userCtx)).rejects.toThrow(
		'lacks required role "admin"',
	)
	await expect(
		adminInviteCreateCapability.handler(
			{ code: 'KENT-FRIEND', note: 'launch' },
			userCtx,
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
		}),
	)

	const { sqlite, db } = createMigratedDb()
	const adminCtx = createContext(['admin'], { APP_DB: db })
	seedAdminUser(sqlite, adminCtx.adminStableUserId)

	const created = await adminInviteCreateCapability.handler(
		{ code: '  kent-friend  ', note: 'launch email', maxUses: 1 },
		adminCtx,
	)
	expect(created.invite).toEqual({
		code: 'KENT-FRIEND',
		maxUses: 1,
		note: 'launch email',
		plan: 'free',
		expiresAt: null,
		createdAt: expect.any(String),
	})
	expect(created.invites).toEqual([
		expect.objectContaining({ code: 'KENT-FRIEND' }),
	])
	expect(created.failed).toEqual([])

	const generated = await adminInviteCreateCapability.handler({}, adminCtx)
	expect(generated.invite.code).toMatch(/^KODY-[A-F0-9-]+$/)
	expect(generated.invite.maxUses).toBe(1)
	expect(generated.invite.plan).toBe('free')

	const bulk = await adminInviteCreateCapability.handler(
		{
			note: 'shared note',
			maxUses: 2,
			plan: 'pro',
			expiresAt: '2026-12-01T00:00:00.000Z',
			codes: [
				{ code: 'jane-friend' },
				{ code: 'alex-friend', note: 'personal' },
			],
		},
		adminCtx,
	)
	expect(bulk.invites).toEqual([
		expect.objectContaining({
			code: 'JANE-FRIEND',
			note: 'shared note',
			maxUses: 2,
			plan: 'pro',
			expiresAt: '2026-12-01T00:00:00.000Z',
		}),
		expect.objectContaining({
			code: 'ALEX-FRIEND',
			note: 'personal',
			maxUses: 2,
			plan: 'pro',
		}),
	])
	expect(bulk.invite.code).toBe('JANE-FRIEND')
	expect(bulk.failed).toEqual([])

	await expect(
		adminInviteCreateCapability.handler({ code: 'kent-friend' }, adminCtx),
	).rejects.toBeInstanceOf(McpCallerError)
	await expect(
		adminInviteCreateCapability.handler({ code: 'kent-friend' }, adminCtx),
	).rejects.toThrow('Invite code KENT-FRIEND already exists.')

	const mixed = await adminInviteCreateCapability.handler(
		{
			codes: [{ code: 'kent-friend' }, { code: 'new-friend' }],
		},
		adminCtx,
	)
	expect(mixed.invites.map((invite) => invite.code)).toEqual(['NEW-FRIEND'])
	expect(mixed.failed).toEqual([
		{
			code: 'KENT-FRIEND',
			error: 'Invite code KENT-FRIEND already exists.',
		},
	])

	await expect(
		adminInviteCreateCapability.handler(
			{ code: 'solo', codes: [{ code: 'bulk' }] },
			adminCtx,
		),
	).rejects.toThrow('Provide either code or codes, not both.')
	await expect(
		adminInviteCreateCapability.handler(
			{ codes: [{ code: 'dup-friend' }, { code: 'dup-friend' }] },
			adminCtx,
		),
	).rejects.toThrow('Duplicate invite code in request: DUP-FRIEND')
	await expect(
		adminInviteCreateCapability.handler({ expiresAt: 'not-a-date' }, adminCtx),
	).rejects.toThrow('expiresAt must be a valid date.')
	await expect(
		adminInviteCreateCapability.handler({ code: '   ' }, adminCtx),
	).rejects.toThrow('Invite code must not be empty.')

	const listed = await adminInviteListCapability.handler({}, adminCtx)
	expect(listed.invites.map((invite) => invite.code)).toEqual(
		expect.arrayContaining([
			'KENT-FRIEND',
			generated.invite.code,
			'JANE-FRIEND',
			'ALEX-FRIEND',
			'NEW-FRIEND',
		]),
	)
	expect(
		listed.invites.find((invite) => invite.code === 'KENT-FRIEND'),
	).toEqual({
		code: 'KENT-FRIEND',
		maxUses: 1,
		useCount: 0,
		note: 'launch email',
		plan: 'free',
		expiresAt: null,
		revokedAt: null,
		createdAt: expect.any(String),
	})
	expect(listed.invites.some((invite) => 'created_by' in invite)).toBe(false)

	const signupMode = sqlite
		.prepare(`SELECT COUNT(*) AS total FROM invites`)
		.get() as { total: number }
	expect(signupMode.total).toBe(5)

	expect(auditEventSummaries()).toEqual(
		expect.arrayContaining([
			'mcp_capability_denied:failure',
			'adminInviteCreate:success',
			'adminInviteCreate:failure',
			'adminInviteList:success',
		]),
	)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'adminInviteCreate',
			result: 'success',
			reason: 'invite_code=KENT-FRIEND;max_uses=1;plan=free',
		}),
	)
})
