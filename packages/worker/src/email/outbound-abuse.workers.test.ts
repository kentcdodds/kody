import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { processCloudflareEmailDeliveryEvent } from './delivery-events.ts'
import {
	applyOutboundEmailAbusePause,
	emailOutboundPausedMessage,
	outboundEmailBouncePauseThresholdPerDay,
} from './outbound-abuse.ts'
import { sendOutboundEmail } from './outbound.ts'
import { insertEmailMessage } from './repo.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

const platformBaseUrl = 'https://kody.example.com'

async function seedVerifiedAccount(input: { email: string }) {
	const username = `sender-${crypto.randomUUID().slice(0, 8)}`
	const stableUserId = await createStableUserIdFromEmail(input.email)
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, plan, stable_user_id)
			VALUES (?, ?, ?, ?, 'max', ?)`,
	)
		.bind(
			username,
			input.email,
			'test-password-hash',
			new Date().toISOString(),
			stableUserId,
		)
		.run()
	return { username, stableUserId }
}

async function recordProviderEvent(input: {
	providerMessageId: string
	eventId: string
	status: 'delivered' | 'bounced' | 'complained'
	eventTimestamp: string
}) {
	const result = await processCloudflareEmailDeliveryEvent({
		db: env.APP_DB,
		body: {
			type: `cf.email.sending.message.${input.status}`,
			source: {
				type: 'email.sending',
				zoneId: 'zone-1',
				domain: 'inbox.kody.example.com',
			},
			payload: {
				eventId: input.eventId,
				messageId: input.providerMessageId,
				sender: 'user@inbox.kody.example.com',
				recipient: 'recipient@example.net',
				terminal: true,
				delivery: { status: input.status },
			},
			metadata: {
				accountId: 'account-1',
				eventSubscriptionId: 'subscription-1',
				eventSchemaVersion: 1,
				eventTimestamp: input.eventTimestamp,
			},
		},
	})
	expect(result.outcome).not.toBe('invalid')
	return result
}

async function readPauseTimestamp(stableUserId: string) {
	const row = await env.APP_DB.prepare(
		`SELECT email_outbound_paused_at FROM users WHERE stable_user_id = ?`,
	)
		.bind(stableUserId)
		.first<{ email_outbound_paused_at: string | null }>()
	return row?.email_outbound_paused_at ?? null
}

test('a spam complaint pauses outbound email once and blocks further sends', async () => {
	consoleWarn.mockImplementation(() => {})
	await ensureEmailTestSchema(env.APP_DB)
	const accountEmail = `complainer-${crypto.randomUUID()}@example.com`
	const { stableUserId } = await seedVerifiedAccount({ email: accountEmail })
	const providerMessageId = `provider-${crypto.randomUUID()}`
	await insertEmailMessage({
		db: env.APP_DB,
		message: {
			direction: 'outbound',
			userId: stableUserId,
			fromAddress: 'user@inbox.kody.example.com',
			toAddresses: ['recipient@example.net'],
			subject: 'Complaint pause',
			processingStatus: 'sent',
			providerMessageId,
			sentAt: '2026-07-17T20:00:00.000Z',
		},
	})
	await recordProviderEvent({
		providerMessageId,
		eventId: 'event-complained',
		status: 'complained',
		eventTimestamp: new Date().toISOString(),
	})

	const first = await applyOutboundEmailAbusePause({
		env,
		userId: stableUserId,
		deliveryStatus: 'complained',
		eventRecorded: true,
	})
	expect(first.paused).toBe(true)
	const pausedAt = await readPauseTimestamp(stableUserId)
	expect(pausedAt).not.toBeNull()
	expect(
		consoleWarn.mock.calls.some((call) => call[0] === 'email-outbound-paused'),
	).toBe(true)

	// Replayed queue messages must not re-pause or move the timestamp.
	const second = await applyOutboundEmailAbusePause({
		env,
		userId: stableUserId,
		deliveryStatus: 'complained',
		eventRecorded: false,
	})
	expect(second.paused).toBe(false)
	expect(await readPauseTimestamp(stableUserId)).toBe(pausedAt)

	await expect(
		sendOutboundEmail({
			env: {
				...env,
				APP_BASE_URL: platformBaseUrl,
				EMAIL: {
					async send() {
						throw new Error('Paused accounts must not reach the provider.')
					},
				},
			},
			userId: stableUserId,
			accountEmail,
			recipientPolicy: 'self',
			subject: 'Blocked while paused',
			text: 'Body',
		}),
	).rejects.toThrow(emailOutboundPausedMessage)

	// Delivered events and unpersisted complaint signals must not pause.
	const deliveredAccount = await seedVerifiedAccount({
		email: `deliverer-${crypto.randomUUID()}@example.com`,
	})
	const delivered = await applyOutboundEmailAbusePause({
		env,
		userId: deliveredAccount.stableUserId,
		deliveryStatus: 'delivered',
		eventRecorded: true,
	})
	expect(delivered.paused).toBe(false)
	expect(await readPauseTimestamp(deliveredAccount.stableUserId)).toBeNull()

	const phantomAccount = await seedVerifiedAccount({
		email: `phantom-${crypto.randomUUID()}@example.com`,
	})
	// Conflicting-duplicate queue outcome: the complained event's insert
	// was deduped by provider_event_id, so no persisted complaint backs it.
	const phantom = await applyOutboundEmailAbusePause({
		env,
		userId: phantomAccount.stableUserId,
		deliveryStatus: 'complained',
		eventRecorded: false,
	})
	expect(phantom.paused).toBe(false)
	expect(await readPauseTimestamp(phantomAccount.stableUserId)).toBeNull()
})

test('bounces below the daily threshold do not pause; reaching it does', async () => {
	consoleWarn.mockImplementation(() => {})
	await ensureEmailTestSchema(env.APP_DB)
	const accountEmail = `bouncer-${crypto.randomUUID()}@example.com`
	const { stableUserId } = await seedVerifiedAccount({ email: accountEmail })
	const now = new Date()

	for (
		let attempt = 1;
		attempt <= outboundEmailBouncePauseThresholdPerDay;
		attempt += 1
	) {
		const providerMessageId = `provider-${crypto.randomUUID()}`
		await insertEmailMessage({
			db: env.APP_DB,
			message: {
				direction: 'outbound',
				userId: stableUserId,
				fromAddress: 'user@inbox.kody.example.com',
				toAddresses: ['recipient@example.net'],
				subject: `Bounce ${attempt}`,
				processingStatus: 'sent',
				providerMessageId,
				sentAt: now.toISOString(),
			},
		})
		await recordProviderEvent({
			providerMessageId,
			eventId: `event-bounced-${attempt}`,
			status: 'bounced',
			eventTimestamp: now.toISOString(),
		})
		const result = await applyOutboundEmailAbusePause({
			env,
			userId: stableUserId,
			deliveryStatus: 'bounced',
			eventRecorded: true,
			now,
		})
		if (attempt < outboundEmailBouncePauseThresholdPerDay) {
			expect(result.paused).toBe(false)
			expect(await readPauseTimestamp(stableUserId)).toBeNull()
		} else {
			expect(result.paused).toBe(true)
			expect(await readPauseTimestamp(stableUserId)).not.toBeNull()
		}
	}
})
