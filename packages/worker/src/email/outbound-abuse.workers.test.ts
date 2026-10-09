import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { processCloudflareEmailDeliveryEvent } from './delivery-events.ts'
import {
	applyOutboundEmailAbusePause,
	emailOutboundPausedMessage,
	outboundEmailBouncePauseThresholdPerDay,
} from './outbound-abuse.ts'
import { mailboxRpc } from './mailbox-client.ts'
import { baseMessage } from './mailbox-test-helpers.ts'
import { sendOutboundEmail } from './outbound.ts'
import { upsertOutboundProviderIndexRow } from './outbound-provider-index.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const platformBaseUrl = 'https://kody.example.com'

async function seedVerifiedAccount(label: string) {
	const email = `${label}-${crypto.randomUUID()}@example.com`
	const stableUserId = testStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, plan, stable_user_id)
			VALUES (?, ?, 'test-password-hash', ?, 'max', ?)`,
	)
		.bind(
			`sender-${crypto.randomUUID().slice(0, 8)}`,
			email,
			new Date().toISOString(),
			stableUserId,
		)
		.run()
	return { email, stableUserId }
}

async function recordProviderEvent(input: {
	providerMessageId: string
	eventId: string
	status: 'delivered' | 'bounced' | 'complained'
	eventTimestamp: string
}) {
	const result = await processCloudflareEmailDeliveryEvent({
		env,
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

async function seedProviderMessage(input: {
	userId: string
	providerMessageId: string
	sentAt: string
}) {
	const message = baseMessage(input.userId, {
		direction: 'outbound',
		inboxId: null,
		processingStatus: 'sent',
		providerMessageId: input.providerMessageId,
		sentAt: input.sentAt,
		createdAt: input.sentAt,
	})
	await mailboxRpc({ env, userId: input.userId }).upsertMessageGraph({
		ownerId: input.userId,
		message,
	})
	await upsertOutboundProviderIndexRow({
		db: env.APP_DB,
		providerMessageId: input.providerMessageId,
		userId: input.userId,
		messageId: message.id,
		inboxId: null,
		now: input.sentAt,
	})
}

function pause(
	userId: string,
	deliveryStatus: 'delivered' | 'bounced' | 'complained',
	eventRecorded: boolean,
	now?: Date,
) {
	return applyOutboundEmailAbusePause({
		env,
		userId,
		deliveryStatus,
		eventRecorded,
		now,
	})
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
	const account = await seedVerifiedAccount('complainer')
	const userId = account.stableUserId
	const providerMessageId = `provider-${crypto.randomUUID()}`
	await seedProviderMessage({
		userId,
		providerMessageId,
		sentAt: '2026-07-17T20:00:00.000Z',
	})
	await recordProviderEvent({
		providerMessageId,
		eventId: 'event-complained',
		status: 'complained',
		eventTimestamp: new Date().toISOString(),
	})

	expect(await pause(userId, 'complained', true)).toMatchObject({
		paused: true,
	})
	const pausedAt = await readPauseTimestamp(userId)
	expect(pausedAt).not.toBeNull()
	expect(
		consoleWarn.mock.calls.some((call) => call[0] === 'email-outbound-paused'),
	).toBe(true)

	// Replayed queue messages must not re-pause or move the timestamp.
	expect(await pause(userId, 'complained', false)).toMatchObject({
		paused: false,
	})
	expect(await readPauseTimestamp(userId)).toBe(pausedAt)

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
			userId,
			accountEmail: account.email,
			recipientPolicy: 'self',
			subject: 'Blocked while paused',
			text: 'Body',
		}),
	).rejects.toThrow(emailOutboundPausedMessage)

	// Delivered events and unpersisted complaint signals must not pause. The
	// unrecorded complaint is the conflicting-duplicate queue outcome: its
	// insert was deduped by provider_event_id, so no persisted complaint backs it.
	const nonPausing = [
		['deliverer', 'delivered', true],
		['phantom', 'complained', false],
	] as const
	for (const [label, deliveryStatus, eventRecorded] of nonPausing) {
		const { stableUserId } = await seedVerifiedAccount(label)
		expect(
			await pause(stableUserId, deliveryStatus, eventRecorded),
		).toMatchObject({ paused: false })
		expect(await readPauseTimestamp(stableUserId)).toBeNull()
	}
}, 30_000)

test('bounces below the daily threshold do not pause; reaching it does', async () => {
	consoleWarn.mockImplementation(() => {})
	await ensureEmailTestSchema(env.APP_DB)
	const { stableUserId } = await seedVerifiedAccount('bouncer')
	const now = new Date()

	for (
		let attempt = 1;
		attempt <= outboundEmailBouncePauseThresholdPerDay;
		attempt += 1
	) {
		const providerMessageId = `provider-${crypto.randomUUID()}`
		await seedProviderMessage({
			userId: stableUserId,
			providerMessageId,
			sentAt: now.toISOString(),
		})
		await recordProviderEvent({
			providerMessageId,
			eventId: `event-bounced-${attempt}`,
			status: 'bounced',
			eventTimestamp: now.toISOString(),
		})
		const reachedThreshold = attempt === outboundEmailBouncePauseThresholdPerDay
		expect(await pause(stableUserId, 'bounced', true, now)).toMatchObject({
			paused: reachedThreshold,
		})
		expect((await readPauseTimestamp(stableUserId)) !== null).toBe(
			reachedThreshold,
		)
	}
}, 30_000)
