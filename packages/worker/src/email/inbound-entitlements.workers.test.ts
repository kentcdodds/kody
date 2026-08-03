import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import { UserMeter } from '#worker/entitlements/user-meter-do.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { userMeterDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { handleInboundEmail } from './inbound.ts'
import { mailboxRpc } from './mailbox-client.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

async function seedFreeAccount(username: string) {
	const email = `${username}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id, plan
		) VALUES (?, ?, 'test-password-hash', ?, ?, 'free')`,
	)
		.bind(username, email, new Date().toISOString(), userId)
		.run()
	return userId
}

function messageFor(username: string) {
	const address = `${username}@inbox.kody.example.com`
	return createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw: [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Entitlement check',
			`Message-ID: <entitlement-${crypto.randomUUID()}@example.net>`,
			'',
			'Body.',
		].join('\r\n'),
	})
}

async function seedReceiveCount(userId: string, count: number) {
	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(userMeterDurableObjectName(userId)),
	)
	await runInDurableObject(stub, async (instance: UserMeter, state) => {
		expect(instance).toBeInstanceOf(UserMeter)
		await instance.read({
			resource: 'email_receives_per_day',
			day: utcDayKey(),
		})
		state.storage.sql.exec(
			`INSERT INTO daily_counters (resource, day, count, revision, updated_at)
			VALUES (?, ?, ?, 1, ?)
			ON CONFLICT(resource, day) DO UPDATE SET
				count = excluded.count,
				revision = excluded.revision,
				updated_at = excluded.updated_at`,
			'email_receives_per_day',
			utcDayKey(),
			count,
			new Date().toISOString(),
		)
	})
}

test('inbound receive quota rejects through Mailbox without a USER D1 graph write', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const username = `quota-${crypto.randomUUID().slice(0, 8)}`
	const userId = await seedFreeAccount(username)
	const limit = planLimits.free.maxEmailReceivesPerDay
	if (limit === null) throw new Error('Expected a free receive limit.')
	await seedReceiveCount(userId, limit)

	const message = messageFor(username)
	await handleInboundEmail(message, {
		...env,
		APP_BASE_URL: 'https://kody.example.com',
	})
	expect(message.rejectedReason).toBe('Recipient mailbox is over quota.')
	const mailbox = mailboxRpc({ env, userId })
	expect(await mailbox.listMessages({ limit: 10 })).toMatchObject({
		messages: [],
	})
	const rejection = (await mailbox.listDeliveryEvents({ limit: 10 })).find(
		(event) =>
			event.eventType === 'rejected' &&
			!event.detailJson.includes('"aggregate":true'),
	)
	expect(rejection).toBeDefined()
	expect(JSON.parse(rejection!.detailJson)).toMatchObject({
		reason: `Daily receive cap ${limit} reached.`,
		phase: 'entitlement',
	})

	for (const table of [
		'email_threads',
		'email_messages',
		'email_delivery_events',
	]) {
		const row = await env.APP_DB.prepare(
			`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`,
		)
			.bind(userId)
			.first<{ count: number }>()
		expect(row?.count).toBe(0)
	}
}, 30_000)
