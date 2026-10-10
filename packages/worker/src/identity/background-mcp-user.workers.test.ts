import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import {
	assignAdminRole,
	ensureRbacTestSchema,
	seedAccount,
} from '#worker/test-support/workers-seed.ts'
import {
	AccountSuspendedError,
	accountSuspendedMessage,
} from '#worker/account/account-suspension.ts'
import { resolveBackgroundMcpUser } from './background-mcp-user.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

test('resolveBackgroundMcpUser loads admin roles only for assigned accounts', async () => {
	await ensureUsersTestSchema({ db: env.APP_DB })
	await ensureRbacTestSchema(env.APP_DB)

	const adminEmail = `bg-admin-${crypto.randomUUID()}@example.com`
	const adminStableUserId = testStableUserIdFromEmail(adminEmail)
	const adminAccountId = await seedAccount({
		db: env.APP_DB,
		email: adminEmail,
		username: `bgadmin-${crypto.randomUUID().slice(0, 8)}`,
		stableUserId: adminStableUserId,
		plan: 'max',
	})
	await assignAdminRole({ db: env.APP_DB, userId: adminAccountId })

	const admin = await resolveBackgroundMcpUser(env.APP_DB, adminStableUserId)
	expect(admin).toMatchObject({
		userId: adminStableUserId,
		email: adminEmail,
		roles: expect.arrayContaining(['admin']),
	})

	const userEmail = `bg-user-${crypto.randomUUID()}@example.com`
	const userStableUserId = testStableUserIdFromEmail(userEmail)
	await seedAccount({
		db: env.APP_DB,
		email: userEmail,
		username: `bguser-${crypto.randomUUID().slice(0, 8)}`,
		stableUserId: userStableUserId,
		plan: 'max',
	})

	const user = await resolveBackgroundMcpUser(env.APP_DB, userStableUserId)
	expect(user.userId).toBe(userStableUserId)
	expect(user.roles ?? []).not.toContain('admin')
})

test('resolveBackgroundMcpUser fails closed for suspended accounts and recovers after unsuspend', async () => {
	await ensureUsersTestSchema({ db: env.APP_DB })
	await ensureRbacTestSchema(env.APP_DB)

	const email = `bg-suspended-${crypto.randomUUID()}@example.com`
	const stableUserId = testStableUserIdFromEmail(email)
	await seedAccount({
		db: env.APP_DB,
		email,
		username: `bgsusp-${crypto.randomUUID().slice(0, 8)}`,
		stableUserId,
		plan: 'max',
	})
	const setSuspendedAt = async (suspendedAt: string | null) =>
		await env.APP_DB.prepare(
			`UPDATE users SET suspended_at = ? WHERE stable_user_id = ?`,
		)
			.bind(suspendedAt, stableUserId)
			.run()

	await setSuspendedAt(new Date().toISOString())
	const error = await resolveBackgroundMcpUser(env.APP_DB, stableUserId).catch(
		(caught: unknown) => caught,
	)
	expect(error).toBeInstanceOf(AccountSuspendedError)
	expect(error).toMatchObject({
		code: 'account_suspended',
		message: accountSuspendedMessage,
	})

	// Rejections are not cached, so lifting the suspension resumes at once.
	await setSuspendedAt(null)
	await expect(
		resolveBackgroundMcpUser(env.APP_DB, stableUserId),
	).resolves.toMatchObject({ userId: stableUserId, email })
})

test('resolveBackgroundMcpUser treats a live team org as a writable owner', async () => {
	await ensureUsersTestSchema({ db: env.APP_DB })
	const orgId = testStableUserIdFromEmail(
		`bg-org-${crypto.randomUUID()}@example.com`,
	)
	const slug = `bg-org-${crypto.randomUUID().slice(0, 8)}`
	const now = new Date().toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO orgs (id, slug, display_name, plan, created_at, updated_at)
		 VALUES (?, ?, ?, 'free', ?, ?)`,
	)
		.bind(orgId, slug, 'Write Lease Org', now, now)
		.run()

	await expect(resolveBackgroundMcpUser(env.APP_DB, orgId)).resolves.toEqual({
		userId: orgId,
		email: '',
		username: slug,
		displayName: 'Write Lease Org',
		roles: ['user'],
		permissions: [],
	})
})

test('resolveBackgroundMcpUser fails closed for a missing owner and a deleted org', async () => {
	await ensureUsersTestSchema({ db: env.APP_DB })
	const missingId = testStableUserIdFromEmail(
		`bg-missing-${crypto.randomUUID()}@example.com`,
	)
	await expect(resolveBackgroundMcpUser(env.APP_DB, missingId)).rejects.toThrow(
		`Background MCP user was not found: ${missingId}`,
	)

	const orgId = testStableUserIdFromEmail(
		`bg-deleted-org-${crypto.randomUUID()}@example.com`,
	)
	const now = new Date().toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO orgs (id, slug, plan, deleted_at, created_at, updated_at)
		 VALUES (?, ?, 'free', ?, ?, ?)`,
	)
		.bind(orgId, `bg-del-${crypto.randomUUID().slice(0, 8)}`, now, now, now)
		.run()
	await expect(resolveBackgroundMcpUser(env.APP_DB, orgId)).rejects.toThrow(
		`Background MCP user was not found: ${orgId}`,
	)
})

test('resolveBackgroundMcpUser does not fall through a deleting or deleted person to a leftover personal org', async () => {
	await ensureUsersTestSchema({ db: env.APP_DB })
	const deletingEmail = `bg-deleting-${crypto.randomUUID()}@example.com`
	const deletingId = testStableUserIdFromEmail(deletingEmail)
	await seedAccount({
		db: env.APP_DB,
		email: deletingEmail,
		username: `bgdel-${crypto.randomUUID().slice(0, 8)}`,
		stableUserId: deletingId,
		plan: 'max',
	})
	const deletedEmail = `bg-deleted-${crypto.randomUUID()}@example.com`
	const deletedId = testStableUserIdFromEmail(deletedEmail)
	await seedAccount({
		db: env.APP_DB,
		email: deletedEmail,
		username: `bgdead-${crypto.randomUUID().slice(0, 8)}`,
		stableUserId: deletedId,
		plan: 'max',
	})
	const now = new Date().toISOString()
	await env.APP_DB.prepare(
		`UPDATE users SET deleting_at = ? WHERE stable_user_id = ?`,
	)
		.bind(now, deletingId)
		.run()
	await env.APP_DB.prepare(
		`UPDATE users SET deleted_at = ? WHERE stable_user_id = ?`,
	)
		.bind(now, deletedId)
		.run()

	await expect(
		resolveBackgroundMcpUser(env.APP_DB, deletingId),
	).rejects.toThrow(`Background MCP user was not found: ${deletingId}`)
	await expect(resolveBackgroundMcpUser(env.APP_DB, deletedId)).rejects.toThrow(
		`Background MCP user was not found: ${deletedId}`,
	)
})
