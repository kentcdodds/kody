import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import {
	maxPlanEmailLimits,
	planLimits,
	type PlanName,
} from '#worker/entitlements/plans.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { UserMeter } from '#worker/entitlements/user-meter-do.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { userMeterDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { handleInboundEmail } from './inbound.ts'
import { mailboxRpc } from './mailbox-client.ts'
import { type Mailbox } from './mailbox-do.ts'
import { stubFor } from './mailbox-test-helpers.ts'
import { maxDetailedEmailRejectionEventsPerDay } from './service.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

async function seedAccount(username: string, plan: PlanName) {
	const email = `${username}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id, plan
		) VALUES (?, ?, 'test-password-hash', ?, ?, ?)`,
	)
		.bind(username, email, new Date().toISOString(), userId, plan)
		.run()
	return {
		address: `${username}@inbox.kody.example.com`,
		email,
		userId,
	}
}

async function seedFreeAccount(username: string) {
	return (await seedAccount(username, 'free')).userId
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

async function readReceiveCount(userId: string) {
	const result = await userMeterRpc({ env, userId }).read({
		resource: 'email_receives_per_day',
		day: utcDayKey(),
	})
	return result.outcome === 'ready' ? result.count : 0
}

async function readRejections(userId: string) {
	const events = await mailboxRpc({ env, userId }).listDeliveryEvents({
		limit: 100,
	})
	const rejected = events
		.filter((event) => event.eventType === 'rejected')
		.map((event) => JSON.parse(event.detailJson) as Record<string, unknown>)
	return {
		aggregate: rejected.find((detail) => detail['aggregate'] === true),
		detailed: rejected.filter((detail) => detail['aggregate'] !== true),
	}
}

async function seedStoredMailboxMessages(userId: string, count: number) {
	await mailboxRpc({ env, userId }).countMessages({})
	await runInDurableObject(
		stubFor(userId),
		async (_instance: Mailbox, state) => {
			state.storage.sql.exec(
				`WITH RECURSIVE seq(n) AS (
				SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?
			)
			INSERT INTO email_messages (
				id, direction, processing_status, created_at, updated_at
			)
			SELECT ? || n, 'inbound', 'stored', ?, ? FROM seq`,
				count,
				`seed-${crypto.randomUUID()}-`,
				new Date().toISOString(),
				new Date().toISOString(),
			)
		},
	)
}

function captureD1Sql(db: D1Database) {
	const sql: Array<string> = []
	return {
		sql,
		db: new Proxy(db, {
			get(target, property, receiver) {
				if (property === 'prepare') {
					return (statement: string) => {
						sql.push(statement)
						return target.prepare(statement)
					}
				}
				if (property === 'exec') {
					return (statement: string) => {
						sql.push(statement)
						return target.exec(statement)
					}
				}
				const value = Reflect.get(target, property, receiver)
				return typeof value === 'function' ? value.bind(target) : value
			},
		}),
	}
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

test('free-plan Mailbox count, storage, and size limits reject before charge while under-quota stores', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const captured = captureD1Sql(env.APP_DB)
	const inboundEnv = {
		...env,
		APP_DB: captured.db,
		APP_BASE_URL: 'https://kody.example.com',
	}

	const countUsername = `count-cap-${crypto.randomUUID().slice(0, 8)}`
	const countAccount = await seedAccount(countUsername, 'free')
	await seedStoredMailboxMessages(
		countAccount.userId,
		planLimits.free.maxStoredEmailMessages,
	)
	const countMessage = messageFor(countUsername)
	await handleInboundEmail(countMessage, inboundEnv)
	expect(countMessage.rejectedReason).toBe('Recipient mailbox is over quota.')
	expect(await readReceiveCount(countAccount.userId)).toBe(0)
	expect((await readRejections(countAccount.userId)).detailed[0]).toMatchObject(
		{
			phase: 'entitlement',
		},
	)

	const storageUsername = `storage-cap-${crypto.randomUUID().slice(0, 8)}`
	const storageAccount = await seedAccount(storageUsername, 'free')
	await userMeterRpc({ env, userId: storageAccount.userId }).setStorageBytes({
		bytes: planLimits.free.maxStorageBytes,
		updatedAt: new Date().toISOString(),
	})
	const storageMessage = messageFor(storageUsername)
	await handleInboundEmail(storageMessage, inboundEnv)
	expect(storageMessage.rejectedReason).toBe('Recipient mailbox is over quota.')
	expect(await readReceiveCount(storageAccount.userId)).toBe(0)

	const sizeUsername = `size-cap-${crypto.randomUUID().slice(0, 8)}`
	const sizeAccount = await seedAccount(sizeUsername, 'free')
	const sizeMessage = messageFor(sizeUsername)
	Object.defineProperty(sizeMessage, 'rawSize', {
		value: planLimits.free.maxEmailMessageBytes + 1,
	})
	await handleInboundEmail(sizeMessage, inboundEnv)
	expect(sizeMessage.rejectedReason).toBe('Recipient mailbox is over quota.')
	expect(await readReceiveCount(sizeAccount.userId)).toBe(0)
	expect((await readRejections(sizeAccount.userId)).detailed[0]).toMatchObject({
		phase: 'size',
	})

	const acceptedUsername = `under-cap-${crypto.randomUUID().slice(0, 8)}`
	const acceptedAccount = await seedAccount(acceptedUsername, 'free')
	const accepted = messageFor(acceptedUsername)
	await handleInboundEmail(accepted, inboundEnv)
	expect(accepted.rejectedReason).toBeNull()
	expect(
		await mailboxRpc({ env, userId: acceptedAccount.userId }).listMessages({
			limit: 10,
		}),
	).toMatchObject({
		messages: [expect.objectContaining({ direction: 'inbound' })],
	})
	expect(await readReceiveCount(acceptedAccount.userId)).toBe(1)
	expect(captured.sql.join('\n')).not.toMatch(
		/\bemail_(?:threads|messages|attachments|delivery_events)\b/,
	)
}, 60_000)

test('max-plan receive backstop rejects through the Mailbox audit path', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const username = `max-backstop-${crypto.randomUUID().slice(0, 8)}`
	const account = await seedAccount(username, 'max')
	await seedReceiveCount(
		account.userId,
		maxPlanEmailLimits.email_receives_per_day,
	)
	const message = messageFor(username)
	await handleInboundEmail(message, {
		...env,
		APP_BASE_URL: 'https://kody.example.com',
	})
	expect(message.rejectedReason).toBe('Recipient mailbox is over quota.')
	expect((await readRejections(account.userId)).detailed[0]).toMatchObject({
		phase: 'entitlement',
	})
})

test('Mailbox rejection audit bounds detail while preserving the aggregate count', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const username = `rejection-bound-${crypto.randomUUID().slice(0, 8)}`
	const account = await seedAccount(username, 'free')
	await seedReceiveCount(account.userId, planLimits.free.maxEmailReceivesPerDay)
	const attempts = maxDetailedEmailRejectionEventsPerDay + 3
	for (let index = 0; index < attempts; index += 1) {
		const message = messageFor(username)
		await handleInboundEmail(message, {
			...env,
			APP_BASE_URL: 'https://kody.example.com',
		})
		expect(message.rejectedReason).toBe('Recipient mailbox is over quota.')
	}
	const rejections = await readRejections(account.userId)
	expect(rejections.detailed).toHaveLength(
		maxDetailedEmailRejectionEventsPerDay,
	)
	expect(rejections.aggregate).toMatchObject({
		aggregate: true,
		count: attempts,
		last_phase: 'entitlement',
	})
}, 60_000)

test('UserMeter inbound claim and consume roll back together on claim insert failure', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const account = await seedAccount(
		`meter-atomic-${crypto.randomUUID().slice(0, 8)}`,
		'free',
	)
	const day = '2026-07-30'
	const updatedAt = '2026-07-30T12:00:00.000Z'
	const deliveryId = `email-inbound-delivery:atomic-${crypto.randomUUID()}`
	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(userMeterDurableObjectName(account.userId)),
	)
	await runInDurableObject(stub, async (instance: UserMeter, state) => {
		await instance.initialize({
			resource: 'email_receives_per_day',
			day,
			count: 0,
			updatedAt,
		})
		const sql = state.storage.sql
		const originalExec = sql.exec.bind(sql)
		sql.exec = ((query: string, ...bindings: Array<unknown>) => {
			if (query.includes('INSERT INTO inbound_delivery_claims')) {
				throw new Error('injected inbound claim insert failure')
			}
			return originalExec(query, ...bindings)
		}) as typeof sql.exec
		await expect(
			instance.consumeInboundDelivery({
				deliveryId,
				resource: 'email_receives_per_day',
				day,
				limit: planLimits.free.maxEmailReceivesPerDay,
				updatedAt,
			}),
		).rejects.toThrow('injected inbound claim insert failure')
		sql.exec = originalExec
		expect(
			await instance.read({ resource: 'email_receives_per_day', day }),
		).toMatchObject({ outcome: 'ready', count: 0 })
		expect(
			sql
				.exec<{ count: number }>(
					`SELECT COUNT(*) AS count
					FROM inbound_delivery_claims
					WHERE delivery_id = ?`,
					deliveryId,
				)
				.toArray()[0]?.count,
		).toBe(0)
		await expect(
			instance.consumeInboundDelivery({
				deliveryId,
				resource: 'email_receives_per_day',
				day,
				limit: planLimits.free.maxEmailReceivesPerDay,
				updatedAt,
			}),
		).resolves.toMatchObject({ consumed: true, replayed: false, count: 1 })
	})
})
