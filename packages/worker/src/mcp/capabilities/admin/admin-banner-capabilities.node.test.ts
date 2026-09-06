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
import { adminBannerDeleteCapability } from './admin-banner-delete.ts'
import { adminBannerListCapability } from './admin-banner-list.ts'
import { adminBannerSaveCapability } from './admin-banner-save.ts'

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
	const adminEmail = 'admin@example.com'
	const adminStableUserId = testStableUserIdFromEmail(adminEmail)
	return {
		env: {
			APP_DB: {} as D1Database,
			...envOverrides,
		} as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: adminStableUserId,
				email: adminEmail,
				displayName: 'admin',
				roles,
			},
		}),
		adminStableUserId,
		adminEmail,
	}
}

const saveArgs = {
	enabled: true,
	priority: 10,
	title: 'Kody is live',
	body: 'Watch the launch video.',
	ctaHref: 'https://example.com/kody-launch-video',
	ctaLabel: 'Watch the video',
	severity: 'promo' as const,
	look: 'strip' as const,
	icon: 'play' as const,
	pageTargeting: 'all' as const,
	audience: 'everyone' as const,
	dismissible: true,
}

test('admin banner capabilities: admin-only, save, list, delete, audit', async () => {
	const { sqlite, db } = createMigratedDb()
	const userCtx = createContext(['user'], { APP_DB: db })
	await expect(adminBannerListCapability.handler({}, userCtx)).rejects.toThrow(
		'lacks required role "admin"',
	)
	await expect(
		adminBannerSaveCapability.handler(saveArgs, userCtx),
	).rejects.toThrow('lacks required role "admin"')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
		}),
	)

	const adminCtx = createContext(['admin'], { APP_DB: db })
	sqlite.exec(`
		INSERT INTO users (username, email, stable_user_id, password_hash)
		VALUES (
			'admin-user',
			${quoteSqlString(adminCtx.adminEmail)},
			${quoteSqlString(adminCtx.adminStableUserId)},
			'oauth_created_no_usable_password'
		);
	`)

	const saved = await adminBannerSaveCapability.handler(saveArgs, adminCtx)
	expect(saved.banner.title).toBe('Kody is live')
	expect(saved.banner.look).toBe('strip')

	const listed = await adminBannerListCapability.handler({}, adminCtx)
	expect(listed.banners).toHaveLength(1)
	expect(listed.banners[0]?.id).toBe(saved.banner.id)

	const deleted = await adminBannerDeleteCapability.handler(
		{ id: saved.banner.id },
		adminCtx,
	)
	expect(deleted).toEqual({ deleted: true, id: saved.banner.id })
	await expect(
		adminBannerDeleteCapability.handler({ id: saved.banner.id }, adminCtx),
	).rejects.toThrow('Banner not found.')

	expect(auditEventSummaries()).toEqual([
		'mcp_capability_denied:failure',
		'mcp_capability_denied:failure',
		'adminBannerSave:success',
		'adminBannerList:success',
		'adminBannerDelete:success',
		'adminBannerDelete:failure',
	])
})
