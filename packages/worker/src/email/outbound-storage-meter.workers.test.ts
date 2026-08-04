import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
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
				return { messageId: 'provider-storage-meter' }
			},
		},
	}
}

async function seedVerifiedAccount(email: string) {
	const username = `meter-${crypto.randomUUID().slice(0, 8)}`
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

test('sendOutboundEmail reserves storage bytes in UserMeter', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)

	const accountEmail = `storage-meter-${crypto.randomUUID()}@example.com`
	const { userId } = await seedVerifiedAccount(accountEmail)
	const initialMeterBytes = 42
	await userMeterRpc({ env, userId }).setStorageBytes({
		bytes: initialMeterBytes,
		updatedAt: '2026-07-31T11:00:00.000Z',
	})

	const result = await sendOutboundEmail({
		env: createBindingSendEnv(),
		userId,
		accountEmail,
		recipientPolicy: 'self',
		subject: 'Storage meter reserve',
		text: 'Outbound body for storage reservation.',
	})

	expect(result.status).toBe('sent')
	expect(result.providerMessageId).toBe('provider-storage-meter')

	const meterAfter = await userMeterRpc({ env, userId }).readStorageBytes()
	if (meterAfter.outcome !== 'ready') {
		throw new Error('Expected a ready UserMeter storage read after reserve.')
	}
	expect(meterAfter.bytes).toBeGreaterThan(initialMeterBytes)
}, 30_000)
