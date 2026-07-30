import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { findUserAccountByStableUserId } from '#worker/entitlements/service.ts'
import { ensureEmailTestSchema } from '#worker/email/test-schema.ts'
import { seedAccount } from '#worker/test-support/workers-seed.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

test('findUserAccountByStableUserId resolves accounts via indexed stable id and recovers from deletions', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const email = `reverse-lookup-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedAccount({
		db: env.APP_DB,
		email,
		username: `entitlement-service-${crypto.randomUUID().slice(0, 8)}`,
		plan: 'pro',
		stableUserId: userId,
	})

	expect(await findUserAccountByStableUserId(env.APP_DB, userId)).toEqual({
		email,
		plan: 'pro',
		emailVerified: true,
	})
	await env.APP_DB.prepare(
		`UPDATE users SET plan = 'enterprise-2099', email_verified_at = NULL WHERE email = ?`,
	)
		.bind(email)
		.run()
	await expect(
		findUserAccountByStableUserId(env.APP_DB, userId),
	).rejects.toThrow('Stored plan is not a registered plan name.')
	await env.APP_DB.prepare(`DELETE FROM users WHERE email = ?`)
		.bind(email)
		.run()
	expect(await findUserAccountByStableUserId(env.APP_DB, userId)).toBeNull()
	expect(
		await findUserAccountByStableUserId(env.APP_DB, `unknown-${userId}`),
	).toBeNull()
	expect(await findUserAccountByStableUserId(env.APP_DB, '  ')).toBeNull()
})
