import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { handleInboundEmail } from './inbound.ts'
import { mailboxRpc } from './mailbox-client.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

const platformDomain = 'inbox.kody.example.com'

async function seedAccount(input: {
	email: string
	username: string
	verified?: boolean
}) {
	const userId = await createStableUserIdFromEmail(input.email)
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id, plan
		) VALUES (?, ?, 'test-password-hash', ?, ?, 'max')`,
	)
		.bind(
			input.username,
			input.email,
			input.verified === false ? null : new Date().toISOString(),
			userId,
		)
		.run()
	return userId
}

function inboundMessage(input: {
	address: string
	messageId: string
	withAttachment?: boolean
}) {
	const raw = input.withAttachment
		? [
				'From: Sender <sender@example.net>',
				`To: ${input.address}`,
				'Subject: Mailbox cutover',
				`Message-ID: <${input.messageId}>`,
				'Content-Type: multipart/mixed; boundary="cutover-boundary"',
				'',
				'--cutover-boundary',
				'Content-Type: text/plain; charset="utf-8"',
				'',
				'Mailbox body.',
				'--cutover-boundary',
				'Content-Type: text/plain; name="note.txt"',
				'Content-Disposition: attachment; filename="note.txt"',
				'',
				'Attachment bytes.',
				'--cutover-boundary--',
			].join('\r\n')
		: [
				'From: Sender <sender@example.net>',
				`To: ${input.address}`,
				'Subject: Rejected before claim',
				`Message-ID: <${input.messageId}>`,
				'',
				'Body.',
			].join('\r\n')
	return createForwardableEmailMessage({
		from: 'sender@example.net',
		to: input.address,
		raw,
	})
}

test('USER inbound commits graph, attachments, terminal event, and retry only in Mailbox', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const username = `inbound-${crypto.randomUUID().slice(0, 8)}`
	const email = `${username}@example.com`
	const userId = await seedAccount({ email, username })
	const address = `${username}@${platformDomain}`
	const messageIdHeader = `cutover-${crypto.randomUUID()}@example.net`
	const input = {
		address,
		messageId: messageIdHeader,
		withAttachment: true,
	}
	const inboundEnv = {
		...env,
		APP_BASE_URL: 'https://kody.example.com',
	}

	const first = inboundMessage(input)
	await handleInboundEmail(first, inboundEnv)
	expect(first.rejectedReason).toBeNull()
	const retry = inboundMessage(input)
	await handleInboundEmail(retry, inboundEnv)
	expect(retry.rejectedReason).toBeNull()

	const mailbox = mailboxRpc({ env, userId })
	const page = await mailbox.listMessages({ limit: 10 })
	expect(page.messages).toEqual([
		expect.objectContaining({
			direction: 'inbound',
			messageIdHeader: `<${messageIdHeader}>`,
			subject: 'Mailbox cutover',
			processingStatus: 'stored',
		}),
	])
	const stored = page.messages[0]
	if (!stored) throw new Error('Expected one Mailbox message.')
	expect(
		await mailbox.listAttachmentsForMessage({ messageId: stored.id }),
	).toEqual([
		expect.objectContaining({
			messageId: stored.id,
			filename: 'note.txt',
			storageKind: 'raw-mime',
		}),
	])
	expect(
		await mailbox.listDeliveryEvents({ messageId: stored.id, limit: 10 }),
	).toEqual([
		expect.objectContaining({
			messageId: stored.id,
			eventType: 'received',
			state: 'received',
		}),
	])
	expect(await env.EMAIL_BLOBS.get(stored.rawMimeKey!)).not.toBeNull()
	expect(
		await userMeterRpc({ env, userId }).read({
			resource: 'email_receives_per_day',
			day: new Date().toISOString().slice(0, 10),
		}),
	).toMatchObject({ outcome: 'ready', count: 1 })

	for (const query of [
		['email_threads', 'user_id', userId],
		['email_messages', 'user_id', userId],
		['email_attachments', 'message_id', stored.id],
		['email_delivery_events', 'user_id', userId],
	] as const) {
		const row = await env.APP_DB.prepare(
			`SELECT COUNT(*) AS count FROM ${query[0]} WHERE ${query[1]} = ?`,
		)
			.bind(query[2])
			.first<{ count: number }>()
		expect(row?.count).toBe(0)
	}
}, 30_000)

test('preclaim USER rejection audit is bounded in Mailbox without D1 graph rows', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const username = `unverified-${crypto.randomUUID().slice(0, 8)}`
	const email = `${username}@example.com`
	const userId = await seedAccount({ email, username, verified: false })
	const message = inboundMessage({
		address: `${username}@${platformDomain}`,
		messageId: `reject-${crypto.randomUUID()}@example.net`,
	})
	await handleInboundEmail(message, {
		...env,
		APP_BASE_URL: 'https://kody.example.com',
	})
	expect(message.rejectedReason).toBe('Account email is not verified.')

	const mailbox = mailboxRpc({ env, userId })
	const events = await mailbox.listDeliveryEvents({ limit: 10 })
	expect(events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				eventType: 'rejected',
				messageId: null,
			}),
		]),
	)
	const detailedEvent = events.find((event) =>
		event.detailJson.includes('"phase":"account-verification"'),
	)
	expect(detailedEvent).toBeDefined()
	const detail = JSON.parse(detailedEvent!.detailJson) as Record<
		string,
		unknown
	>
	expect(detail).toMatchObject({
		reason: 'Account email is not verified.',
		phase: 'account-verification',
	})
	const row = await env.APP_DB.prepare(
		`SELECT COUNT(*) AS count FROM email_delivery_events WHERE user_id = ?`,
	)
		.bind(userId)
		.first<{ count: number }>()
	expect(row?.count).toBe(0)
}, 30_000)
