import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { readUserD1StorageBytes } from '#worker/entitlements/service.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { sendOutboundEmail } from './outbound.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

const platformBaseUrl = 'https://kody.example.com'
const platformDomain = 'inbox.kody.example.com'

function createBindingSendEnv() {
	return {
		...env,
		APP_BASE_URL: platformBaseUrl,
		EMAIL: {
			async send() {
				return { messageId: 'provider-storage-shadow' }
			},
		},
	}
}

async function seedVerifiedAccount(email: string) {
	const username = `shadow-${crypto.randomUUID().slice(0, 8)}`
	const stableUserId = await createStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, plan, stable_user_id)
			VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			username,
			email,
			'test-password-hash',
			new Date().toISOString(),
			'max',
			stableUserId,
		)
		.run()
	return {
		username,
		from: `${username}@${platformDomain}`,
		userId: stableUserId,
	}
}

async function seedAuthoritativeD1StorageBytes(userId: string, bytes: number) {
	const updatedAt = new Date().toISOString()
	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes = ?,
			d1_storage_bytes_updated_at = ?
		WHERE stable_user_id = ?`,
	)
		.bind(bytes, updatedAt, userId)
		.run()
}

test('sendOutboundEmail reserves D1 storage bytes and best-effort shadows them into USER_METER', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)

	const accountEmail = `storage-shadow-${crypto.randomUUID()}@example.com`
	const { userId } = await seedVerifiedAccount(accountEmail)
	const initialD1Bytes = 42
	const staleShadowBytes = 7
	await seedAuthoritativeD1StorageBytes(userId, initialD1Bytes)
	await userMeterRpc({ env, userId }).setStorageBytes({
		bytes: staleShadowBytes,
		updatedAt: '2026-07-31T11:00:00.000Z',
	})

	const result = await sendOutboundEmail({
		env: createBindingSendEnv(),
		userId,
		accountEmail,
		recipientPolicy: 'self',
		subject: 'Storage shadow handoff',
		text: 'Outbound body for storage reservation.',
	})

	expect(result.status).toBe('sent')
	expect(result.providerMessageId).toBe('provider-storage-shadow')

	const authoritativeAfter = await readUserD1StorageBytes({
		db: env.APP_DB,
		userId,
	})
	expect(authoritativeAfter).toBeGreaterThan(initialD1Bytes)

	const authoritative = await readUserD1StorageBytes({
		db: env.APP_DB,
		userId,
	})
	const shadow = await userMeterRpc({ env, userId }).readStorageBytes()
	expect(shadow).toMatchObject({
		outcome: 'ready',
		bytes: authoritativeAfter,
	})
	expect(authoritative).toBe(authoritativeAfter)
	expect(authoritative).not.toBe(staleShadowBytes)
}, 30_000)
