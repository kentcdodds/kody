import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import {
	assignAdminRole,
	ensureRbacTestSchema,
	seedAccount,
} from '#worker/test-support/workers-seed.ts'
import { resolveBackgroundMcpUser } from './background-mcp-user.ts'

test('resolveBackgroundMcpUser loads admin roles only for assigned accounts', async () => {
	await ensureUsersTestSchema({ db: env.APP_DB })
	await ensureRbacTestSchema(env.APP_DB)

	const adminEmail = `bg-admin-${crypto.randomUUID()}@example.com`
	const adminStableUserId = await createStableUserIdFromEmail(adminEmail)
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
	const userStableUserId = await createStableUserIdFromEmail(userEmail)
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
