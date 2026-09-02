import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { adminUserStableIdConflictCapability } from './admin-user-stable-id-conflict.ts'

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function seedUser(
	sqlite: DatabaseSync,
	input: {
		email: string
		username: string
		stableUserId: string
		emailVerified: boolean
		createdAt: string
	},
) {
	sqlite.exec(`
		INSERT INTO users (
			username,
			email,
			stable_user_id,
			password_hash,
			email_verified_at,
			created_at
		) VALUES (
			${quoteSqlString(input.username)},
			${quoteSqlString(input.email)},
			${quoteSqlString(input.stableUserId)},
			'oauth_created_no_usable_password',
			${input.emailVerified ? quoteSqlString(input.createdAt) : 'NULL'},
			${quoteSqlString(input.createdAt)}
		);
	`)
}

function createContext(db: D1Database, roles: Array<string>) {
	return {
		env: { APP_DB: db } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'actor-1',
				username: 'actor',
				email: 'actor@example.com',
				roles,
			},
		}),
	}
}

test('adminUserStableIdConflict reports collisions without content and denies non-admins', async () => {
	expect(adminUserStableIdConflictCapability.requiredRole).toBe('admin')
	expect(adminUserStableIdConflictCapability.readOnly).toBe(true)

	const { sqlite, db } = createMigratedDb()
	const userCtx = createContext(db, ['user'])
	await expect(
		adminUserStableIdConflictCapability.handler(
			{ email: 'victim@example.com' },
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

	const adminCtx = createContext(db, ['admin'])
	const missing = await adminUserStableIdConflictCapability.handler(
		{ email: 'missing@example.com' },
		adminCtx,
	)
	expect(missing).toEqual({ conflict: null })

	const sameEmail = 'same@example.com'
	const sameCreatedAt = '2026-01-02T00:00:00.000Z'
	seedUser(sqlite, {
		email: sameEmail,
		username: 'same-user',
		stableUserId: await createStableUserIdFromEmail(sameEmail),
		emailVerified: true,
		createdAt: sameCreatedAt,
	})
	const sameAccount = await adminUserStableIdConflictCapability.handler(
		{ email: sameEmail },
		adminCtx,
	)
	expect(sameAccount).toEqual({ conflict: null })

	const victimEmail = 'victim@example.com'
	const squatterCreatedAt = '2026-03-04T05:06:07.000Z'
	const squatterStableUserId = await createStableUserIdFromEmail(victimEmail)
	seedUser(sqlite, {
		email: 'attacker@example.com',
		username: 'squatter',
		stableUserId: squatterStableUserId,
		emailVerified: false,
		createdAt: squatterCreatedAt,
	})
	const found = await adminUserStableIdConflictCapability.handler(
		{ email: victimEmail },
		adminCtx,
	)
	expect(found).toEqual({
		conflict: {
			stableUserId: squatterStableUserId,
			username: 'squatter',
			created_at: squatterCreatedAt,
			email_verified: false,
		},
	})
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'adminUserStableIdConflict',
			result: 'success',
			reason: `stable_user_id_conflict;target_stable_user_id=${squatterStableUserId}`,
		}),
	)
	expect(auditEventSummaries()).toEqual([
		'mcp_capability_denied:failure',
		'adminUserStableIdConflict:success',
		'adminUserStableIdConflict:success',
		'adminUserStableIdConflict:success',
	])
})
