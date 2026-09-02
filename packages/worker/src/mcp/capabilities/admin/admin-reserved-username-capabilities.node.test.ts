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
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { adminReservedUsernameAddCapability } from './admin-reserved-username-add.ts'
import { adminReservedUsernameListCapability } from './admin-reserved-username-list.ts'
import { adminReservedUsernameRemoveCapability } from './admin-reserved-username-remove.ts'

function createMemoryKv(initial?: Record<string, string>) {
	const store = new Map<string, string>(Object.entries(initial ?? {}))
	return {
		async get(key: string, type?: string) {
			const raw = store.get(key)
			if (raw === undefined) return null
			return type === 'json' ? JSON.parse(raw) : raw
		},
		async put(key: string, value: string) {
			store.set(key, value)
		},
		async delete(key: string) {
			store.delete(key)
		},
		store,
	} as unknown as KVNamespace & { store: Map<string, string> }
}

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

test('admin reserved username capabilities: admin-only, audit, permanent refusal, conflicts', async () => {
	const { sqlite, db } = createMigratedDb()
	const kv = createMemoryKv()
	const userCtx = createContext(['user'], {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: kv,
	})
	await expect(
		adminReservedUsernameListCapability.handler({}, userCtx),
	).rejects.toThrow('lacks required role "admin"')
	await expect(
		adminReservedUsernameAddCapability.handler(
			{ usernames: ['brandnew'] },
			userCtx,
		),
	).rejects.toThrow('lacks required role "admin"')
	await expect(
		adminReservedUsernameRemoveCapability.handler(
			{ usernames: ['faq'] },
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

	const holderEmail = 'holder@example.com'
	const holderStableId = testStableUserIdFromEmail(holderEmail)
	sqlite.exec(`
		INSERT INTO users (username, email, stable_user_id, password_hash)
		VALUES (
			'brandnew',
			${quoteSqlString(holderEmail)},
			${quoteSqlString(holderStableId)},
			'oauth_created_no_usable_password'
		);
	`)

	const adminCtx = createContext(['admin'], {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: kv,
	})
	const listed = await adminReservedUsernameListCapability.handler({}, adminCtx)
	expect(listed.reservedUsernames.added).toEqual([])
	expect(listed.reservedUsernames.removed).toEqual([])
	expect(listed.reservedUsernames.builtIn).toContain('autodiscover')
	expect(listed.reservedUsernames.conflicts).toEqual([])

	const added = await adminReservedUsernameAddCapability.handler(
		{ usernames: ['brandnew'] },
		adminCtx,
	)
	expect(added.reservedUsernames.added).toEqual(['brandnew'])
	expect(added.reservedUsernames.conflicts).toEqual([
		{ username: 'brandnew', stableUserId: holderStableId },
	])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'adminReservedUsernameAdd',
			result: 'success',
		}),
	)

	await expect(
		adminReservedUsernameRemoveCapability.handler(
			{ usernames: ['kody'] },
			adminCtx,
		),
	).rejects.toThrow('cannot be unreserved')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'adminReservedUsernameRemove',
			result: 'failure',
		}),
	)

	const unreserved = await adminReservedUsernameRemoveCapability.handler(
		{ usernames: ['faq'] },
		adminCtx,
	)
	expect(unreserved.reservedUsernames.removed).toEqual(['faq'])
	expect(unreserved.reservedUsernames.added).toEqual(['brandnew'])

	expect(auditEventSummaries()).toEqual([
		'mcp_capability_denied:failure',
		'mcp_capability_denied:failure',
		'mcp_capability_denied:failure',
		'adminReservedUsernameList:success',
		'adminReservedUsernameAdd:success',
		'adminReservedUsernameRemove:failure',
		'adminReservedUsernameRemove:success',
	])
})
