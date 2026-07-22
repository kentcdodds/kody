import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { findUserAccountByStableUserId } from '#worker/entitlements/service.ts'
import { unknownStoredPlanWarningTag } from '#worker/entitlements/plans.ts'
import { ensureEmailTestSchema } from '#worker/email/test-schema.ts'
import {
	consoleWarn,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

async function seedAccount(
	email: string,
	plan: 'pro' | 'max',
	stableUserId: string,
) {
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, plan, stable_user_id)
			VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			`entitlement-service-${crypto.randomUUID().slice(0, 8)}`,
			email,
			'test-password-hash',
			new Date().toISOString(),
			plan,
			stableUserId,
		)
		.run()
}

test('findUserAccountByStableUserId resolves accounts via indexed stable id and recovers from deletions', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const email = `reverse-lookup-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedAccount(email, 'pro', userId)

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
	silenceExpectedConsoleWarns([unknownStoredPlanWarningTag])
	expect(await findUserAccountByStableUserId(env.APP_DB, userId)).toEqual({
		email,
		plan: 'max',
		emailVerified: false,
	})
	expect(consoleWarn).toHaveBeenCalledWith(unknownStoredPlanWarningTag)
	await env.APP_DB.prepare(`DELETE FROM users WHERE email = ?`)
		.bind(email)
		.run()
	expect(await findUserAccountByStableUserId(env.APP_DB, userId)).toBeNull()
	expect(
		await findUserAccountByStableUserId(env.APP_DB, `unknown-${userId}`),
	).toBeNull()
	expect(await findUserAccountByStableUserId(env.APP_DB, '  ')).toBeNull()
})
