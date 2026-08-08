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

test('resolveBackgroundMcpUser includes admin role for package job capability filtering', async () => {
	await ensureUsersTestSchema({ db: env.APP_DB })
	await ensureRbacTestSchema(env.APP_DB)

	const email = `bg-admin-${crypto.randomUUID()}@example.com`
	const stableUserId = await createStableUserIdFromEmail(email)
	const accountId = await seedAccount({
		db: env.APP_DB,
		email,
		username: `bgadmin-${crypto.randomUUID().slice(0, 8)}`,
		stableUserId,
		plan: 'max',
	})
	await assignAdminRole({ db: env.APP_DB, userId: accountId })

	const resolved = await resolveBackgroundMcpUser(env.APP_DB, stableUserId)

	expect(resolved).toMatchObject({
		userId: stableUserId,
		email,
		roles: expect.arrayContaining(['admin']),
	})
	expect(resolved.roles).toContain('admin')
})

test('resolveBackgroundMcpUser returns empty roles for non-admin accounts', async () => {
	await ensureUsersTestSchema({ db: env.APP_DB })
	await ensureRbacTestSchema(env.APP_DB)

	const email = `bg-user-${crypto.randomUUID()}@example.com`
	const stableUserId = await createStableUserIdFromEmail(email)
	await seedAccount({
		db: env.APP_DB,
		email,
		username: `bguser-${crypto.randomUUID().slice(0, 8)}`,
		stableUserId,
		plan: 'max',
	})

	const resolved = await resolveBackgroundMcpUser(env.APP_DB, stableUserId)

	expect(resolved.userId).toBe(stableUserId)
	expect(resolved.roles ?? []).not.toContain('admin')
})
