import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { AccountDeletionInProgressError } from '#worker/account/deletion-state.ts'
import { EntitlementLimitError } from '#worker/entitlements/errors.ts'
import { maxPlanEmailLimits, planLimits } from '#universal/plans.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { ensureDefaultEmailInbox } from './default-inbox.ts'
import { createUserInboundDeliveryAuthority } from './inbound-delivery-authority.ts'
import { buildInboundDelivery } from './inbound-delivery.ts'
import { handleInboundEmail } from './inbound.ts'
import { mailboxRpc } from './mailbox-client.ts'
import {
	getEmailMessageWithAttachmentsById,
	loadEmailAttachmentContent,
	RetryableInboundStorageError,
} from './service.ts'
import { listSystemEmailMessages } from './system-email-graph-store.ts'
import {
	createForwardableEmailMessage,
	createLargeMultipartRelatedInlinePngMessage,
	inboundInlinePngContentId,
	inboundInlinePngFilename,
} from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

const platformDomain = 'inbox.kody.example.com'

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
	const capturedD1 = captureD1Sql(env.APP_DB)
	const inboundEnv = {
		...env,
		APP_DB: capturedD1.db,
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

	const legacyTables = await env.APP_DB.prepare(
		`SELECT name FROM sqlite_schema
		WHERE type = 'table' AND name IN (
			'email_threads', 'email_messages', 'email_attachments',
			'email_delivery_events'
		)`,
	).all()
	expect(legacyTables.results).toEqual([])
	expect(capturedD1.sql.join('\n')).not.toMatch(
		/\bemail_(?:threads|messages|attachments|delivery_events)\b/,
	)
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
	const legacyEventTable = await env.APP_DB.prepare(
		`SELECT name FROM sqlite_schema
		WHERE type = 'table' AND name = 'email_delivery_events'`,
	).first()
	expect(legacyEventTable).toBeNull()
}, 30_000)

test('USER inbound R2 failure retries idempotently without a second quota charge', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const username = `inbound-r2-${crypto.randomUUID().slice(0, 8)}`
	const email = `${username}@example.com`
	const userId = await seedAccount({ email, username })
	const input = {
		address: `${username}@${platformDomain}`,
		messageId: `r2-retry-${crypto.randomUUID()}@example.net`,
		withAttachment: true,
	}
	const failingBlobs = new Proxy(env.EMAIL_BLOBS, {
		get(target, property, receiver) {
			if (property === 'put') {
				return async () => {
					throw new Error('simulated R2 outage')
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
	const first = inboundMessage(input)
	await expect(
		handleInboundEmail(first, {
			...env,
			APP_BASE_URL: 'https://kody.example.com',
			EMAIL_BLOBS: failingBlobs,
		}),
	).rejects.toBeInstanceOf(RetryableInboundStorageError)
	expect(first.rejectedReason).toBeNull()
	expect(
		await userMeterRpc({ env, userId }).read({
			resource: 'email_receives_per_day',
			day: new Date().toISOString().slice(0, 10),
		}),
	).toMatchObject({ outcome: 'ready', count: 1 })
	expect(
		(await mailboxRpc({ env, userId }).listMessages({ limit: 10 })).messages,
	).toEqual([])

	const retry = inboundMessage(input)
	await handleInboundEmail(retry, {
		...env,
		APP_BASE_URL: 'https://kody.example.com',
	})
	expect(retry.rejectedReason).toBeNull()
	const stored = await mailboxRpc({ env, userId }).listMessages({ limit: 10 })
	expect(stored.messages).toHaveLength(1)
	expect(
		await userMeterRpc({ env, userId }).read({
			resource: 'email_receives_per_day',
			day: new Date().toISOString().slice(0, 10),
		}),
	).toMatchObject({ outcome: 'ready', count: 1 })
}, 30_000)

test('pointer-only USER retry after midnight enforces the current quota day', async () => {
	const oldNow = new Date('2026-07-22T23:59:00.000Z')
	const retryNow = new Date('2026-07-23T00:01:00.000Z')
	await ensureEmailTestSchema(env.APP_DB)
	const username = `midnight-${crypto.randomUUID().slice(0, 8)}`
	const email = `${username}@example.com`
	const userId = await seedAccount({ email, username })
	await env.APP_DB.prepare(
		`UPDATE users SET plan = 'free' WHERE stable_user_id = ?`,
	)
		.bind(userId)
		.run()
	const provisioned = await ensureDefaultEmailInbox({
		db: env.APP_DB,
		userId,
		username,
		domain: platformDomain,
	})
	if (!provisioned) throw new Error('Expected provisioned default inbox.')
	const address = `${username}@${platformDomain}`
	const rawMime = 'byte-identical mail spanning the quota-day boundary'
	const oldPointer = await buildInboundDelivery({
		userId,
		inboxId: provisioned.inbox.id,
		recipient: address,
		envelopeFrom: 'sender@example.net',
		rawMime,
		quotaDay: '2026-07-22',
		now: oldNow,
	})
	const retryDelivery = await buildInboundDelivery({
		userId,
		inboxId: provisioned.inbox.id,
		recipient: address,
		envelopeFrom: 'sender@example.net',
		rawMime,
		quotaDay: '2026-07-23',
		now: retryNow,
	})
	const authority = createUserInboundDeliveryAuthority({ env, userId })
	await authority.claimWindow(oldPointer, oldNow)
	const receiveLimit = planLimits.free.maxEmailReceivesPerDay
	if (receiveLimit == null) throw new Error('Expected finite receive limit.')
	await userMeterRpc({ env, userId }).initialize({
		resource: 'email_receives_per_day',
		day: '2026-07-23',
		count: receiveLimit,
		updatedAt: retryNow.toISOString(),
	})

	await expect(
		authority.charge({
			delivery: retryDelivery,
			plan: 'free',
			limit: receiveLimit,
			now: retryNow,
		}),
	).rejects.toBeInstanceOf(EntitlementLimitError)
	expect(
		(await mailboxRpc({ env, userId }).listMessages({ limit: 10 })).messages,
	).toEqual([])
}, 30_000)

test('account deletion fence blocks the complete USER inbound write boundary', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const username = `deleting-${crypto.randomUUID().slice(0, 8)}`
	const email = `${username}@example.com`
	const userId = await seedAccount({ email, username })
	await env.APP_DB.prepare(
		`UPDATE users SET deleting_at = ? WHERE stable_user_id = ?`,
	)
		.bind(new Date().toISOString(), userId)
		.run()
	const message = inboundMessage({
		address: `${username}@${platformDomain}`,
		messageId: `deletion-fence-${crypto.randomUUID()}@example.net`,
		withAttachment: true,
	})

	await expect(
		handleInboundEmail(message, {
			...env,
			APP_BASE_URL: 'https://kody.example.com',
		}),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	expect(await mailboxRpc({ env, userId }).countMailbox()).toEqual({
		threads: 0,
		messages: 0,
		attachments: 0,
		deliveryEvents: 0,
	})
	expect(
		await env.EMAIL_BLOBS.list({ prefix: `email-raw:v1:${userId}/` }),
	).toMatchObject({ objects: [] })
}, 30_000)

test('max-plan plus-tag inbox stores a large multipart/related inline PNG', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const username = `large-mime-${crypto.randomUUID().slice(0, 8)}`
	const email = `${username}@example.com`
	const userId = await seedAccount({ email, username })
	const taggedAddress = `${username}+kody@${platformDomain}`
	const messageIdHeader = `large-related-${crypto.randomUUID()}@example.net`
	const formerParserCeilingBytes = 512 * 1024
	const representativeRawBytes = 575 * 1024
	const message = createLargeMultipartRelatedInlinePngMessage({
		from: 'sender@example.net',
		to: taggedAddress,
		subject: 'Large related budget alert',
		messageId: messageIdHeader,
		minRawBytes: representativeRawBytes,
	})
	expect(message.rawSize).toBeGreaterThan(formerParserCeilingBytes)
	expect(message.rawSize).toBeLessThanOrEqual(
		maxPlanEmailLimits.email_message_bytes,
	)

	await handleInboundEmail(message, {
		...env,
		APP_BASE_URL: 'https://kody.example.com',
	})
	expect(message.rejectedReason).toBeNull()

	const mailbox = mailboxRpc({ env, userId })
	const page = await mailbox.listMessages({ direction: 'inbound', limit: 10 })
	expect(page.messages).toEqual([
		expect.objectContaining({
			direction: 'inbound',
			subject: 'Large related budget alert',
			messageIdHeader: `<${messageIdHeader}>`,
			toAddresses: [taggedAddress],
			processingStatus: 'stored',
			classification: 'accepted',
			rawSize: message.rawSize,
		}),
	])
	const stored = page.messages[0]
	if (!stored) throw new Error('Expected the large inbound message.')
	if (!stored.inboxId) throw new Error('Expected the default inbox id.')
	if (!stored.rawMimeKey) throw new Error('Expected a stored raw MIME key.')
	expect(stored.htmlBody).toContain(`cid:${inboundInlinePngContentId}`)
	const rawBlob = await env.EMAIL_BLOBS.get(stored.rawMimeKey)
	if (!rawBlob) throw new Error('Expected the raw MIME blob in EMAIL_BLOBS.')
	expect(rawBlob.size).toBe(message.rawSize)

	const attachments = await mailbox.listAttachmentsForMessage({
		messageId: stored.id,
	})
	expect(attachments).toEqual([
		expect.objectContaining({
			messageId: stored.id,
			filename: inboundInlinePngFilename,
			contentType: 'image/png',
			contentId: `<${inboundInlinePngContentId}>`,
			disposition: 'inline',
			storageKind: 'raw-mime',
		}),
	])
	const attachment = attachments[0]
	if (!attachment) throw new Error('Expected the inline PNG attachment.')
	const loaded = await getEmailMessageWithAttachmentsById({
		env,
		db: env.APP_DB,
		userId,
		messageId: stored.id,
	})
	if (!loaded) throw new Error('Expected message metadata for attachment load.')
	const content = await loadEmailAttachmentContent({
		blobs: env.EMAIL_BLOBS,
		attachment,
		message: loaded.message,
	})
	expect(content.content).not.toBeNull()
	expect(content.contentBase64?.startsWith('iVBORw0KGgo')).toBe(true)
	expect(content.size).toBeGreaterThan(0)

	const inboundMessagePrefix = 'email-inbound-message:'
	if (!stored.id.startsWith(inboundMessagePrefix)) {
		throw new Error('Expected a user inbound message id.')
	}
	const deliveryId = `email-inbound-delivery:${stored.id.slice(inboundMessagePrefix.length)}`
	const ledger = await createUserInboundDeliveryAuthority({
		env,
		userId,
	}).get(deliveryId)
	expect(ledger).toMatchObject({
		state: 'received',
		messageId: stored.id,
		subscriptionEffectState: 'complete',
	})

	expect(
		await listSystemEmailMessages({
			db: env.APP_DB,
			limit: 10,
		}),
	).toEqual([])
	expect(
		await userMeterRpc({ env, userId }).read({
			resource: 'email_receives_per_day',
			day: (stored.receivedAt ?? stored.createdAt).slice(0, 10),
		}),
	).toMatchObject({ outcome: 'ready', count: 1 })
}, 60_000)

test('max-plan inbox stores oversized related mail by omitting the large part', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const username = `omit-mime-${crypto.randomUUID().slice(0, 8)}`
	const email = `${username}@example.com`
	const userId = await seedAccount({ email, username })
	const address = `${username}@${platformDomain}`
	const messageIdHeader = `omit-related-${crypto.randomUUID()}@example.net`
	const overKeepCapBytes = maxPlanEmailLimits.email_message_bytes + 64 * 1024
	const message = createLargeMultipartRelatedInlinePngMessage({
		from: 'sender@example.net',
		to: address,
		subject: 'Oversized related budget alert',
		messageId: messageIdHeader,
		minRawBytes: overKeepCapBytes,
	})
	expect(message.rawSize).toBeGreaterThan(
		maxPlanEmailLimits.email_message_bytes,
	)

	await handleInboundEmail(message, {
		...env,
		APP_BASE_URL: 'https://kody.example.com',
	})
	expect(message.rejectedReason).toBeNull()

	const mailbox = mailboxRpc({ env, userId })
	const page = await mailbox.listMessages({ direction: 'inbound', limit: 10 })
	expect(page.messages).toEqual([
		expect.objectContaining({
			direction: 'inbound',
			subject: 'Oversized related budget alert',
			messageIdHeader: `<${messageIdHeader}>`,
			processingStatus: 'stored',
			classification: 'accepted',
		}),
	])
	const stored = page.messages[0]
	if (!stored) throw new Error('Expected the reduced inbound message.')
	if (!stored.rawMimeKey) throw new Error('Expected a stored raw MIME key.')
	expect(stored.htmlBody).toContain('Budget alert')
	expect(stored.rawSize).toBeLessThanOrEqual(
		maxPlanEmailLimits.email_message_bytes,
	)
	const rawBlob = await env.EMAIL_BLOBS.get(stored.rawMimeKey)
	if (!rawBlob) throw new Error('Expected the reduced raw MIME blob.')
	expect(rawBlob.size).toBeLessThanOrEqual(
		maxPlanEmailLimits.email_message_bytes,
	)
	expect(rawBlob.size).toBeLessThan(message.rawSize)
	const rawText = await rawBlob.text()
	expect(rawText).toContain('X-Kody-Inbound-Reduced: 1')
	expect(rawText).toContain(`X-Kody-Original-Size: ${message.rawSize}`)

	const attachments = await mailbox.listAttachmentsForMessage({
		messageId: stored.id,
	})
	expect(attachments).toEqual([
		expect.objectContaining({
			messageId: stored.id,
			filename: inboundInlinePngFilename,
			contentType: 'image/png',
			storageKind: 'unavailable',
		}),
	])
	const attachment = attachments[0]
	if (!attachment) throw new Error('Expected the omitted PNG attachment.')
	const loaded = await getEmailMessageWithAttachmentsById({
		env,
		db: env.APP_DB,
		userId,
		messageId: stored.id,
	})
	if (!loaded) throw new Error('Expected message metadata for attachment load.')
	const content = await loadEmailAttachmentContent({
		blobs: env.EMAIL_BLOBS,
		attachment,
		message: loaded.message,
	})
	expect(content.content).toBeNull()
	expect(content.contentBase64).toBeNull()
	expect(
		await userMeterRpc({ env, userId }).read({
			resource: 'email_receives_per_day',
			day: (stored.receivedAt ?? stored.createdAt).slice(0, 10),
		}),
	).toMatchObject({ outcome: 'ready', count: 1 })
}, 60_000)
