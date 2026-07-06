import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { findUserAccountByStableUserId } from '#worker/entitlements/service.ts'
import { ensureEmailTestSchema } from '#worker/email/test-schema.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

async function seedAccount(email: string, plan: 'personal' | null) {
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, plan)
			VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			`entitlement-service-${crypto.randomUUID().slice(0, 8)}`,
			email,
			'test-password-hash',
			new Date().toISOString(),
			plan,
		)
		.run()
}

test('findUserAccountByStableUserId resolves accounts, caches hits, and recovers from deletions', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const email = `reverse-lookup-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedAccount(email, 'personal')

	expect(await findUserAccountByStableUserId(env.APP_DB, userId)).toEqual({
		email,
		plan: 'personal',
		emailVerified: true,
	})
	await env.APP_DB.prepare(
		`UPDATE users SET plan = NULL, email_verified_at = NULL WHERE email = ?`,
	)
		.bind(email)
		.run()
	expect(await findUserAccountByStableUserId(env.APP_DB, userId)).toEqual({
		email,
		plan: null,
		emailVerified: false,
	})
	await env.APP_DB.prepare(`DELETE FROM users WHERE email = ?`)
		.bind(email)
		.run()
	expect(await findUserAccountByStableUserId(env.APP_DB, userId)).toBeNull()
	expect(
		await findUserAccountByStableUserId(env.APP_DB, `unknown-${userId}`),
	).toBeNull()
	expect(await findUserAccountByStableUserId(env.APP_DB, '  ')).toBeNull()
})
