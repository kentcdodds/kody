import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { handleInboundEmail } from './inbound.ts'
import { processInboundDeliveryEffects } from './inbound-effects.ts'
import {
	buildInboundDelivery,
	claimInboundDeliveryWindow,
	claimInboundDeliveryStorage,
	inboundDeliveryDedupeWindowMs,
	InboundDeliveryLeaseLostError,
	markInboundDeliveryRejected,
	markInboundDeliveryReceived,
	pruneExpiredInboundDedupePointers,
	reconcileStaleInboundDeliveries,
} from './inbound-delivery.ts'
import {
	defaultEmailInboxName,
	ensureDefaultEmailInbox,
} from './default-inbox.ts'
import { sweepStaleInboundDeliveries } from './reconcile-inbound-deliveries.ts'
import {
	createEmailThread,
	deleteEmailMessageById,
	emailRawMimeKey,
	getEmailMessageById,
	insertEmailMessage,
	listEmailInboxesForUser,
	listEmailInboxAddressesForUser,
	listEmailMessages,
	listEmailAttachmentsForMessage,
} from './repo.ts'
import {
	getEmailAttachmentById,
	insertEmailMessageWithAttachments,
	insertEmailMessageWithRawMime,
	loadRawMime,
	RetryableInboundStorageError,
} from './service.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { exportRunRecords } from '#worker/run-records/service.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { buildPublishedSourceManifestSnapshotKvKey } from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	consoleError,
	consoleWarn,
	silenceExpectedConsoleErrors,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { AccountDeletionInProgressError } from '#worker/account/deletion-state.ts'
import { planLimits } from '#worker/entitlements/plans.ts'

const platformBaseUrl = 'https://kody.example.com'
// User mail lives on the inbox. subdomain derived from APP_BASE_URL.
const platformDomain = 'inbox.kody.example.com'

function createInboundEnv() {
	return { ...env, APP_BASE_URL: platformBaseUrl }
}

async function insertWritableEmailTestUser(stableUserId: string) {
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, stable_user_id, deleting_at
		) VALUES (?, ?, 'hash', ?, NULL)`,
	)
		.bind(
			`user-${crypto.randomUUID()}`,
			`${crypto.randomUUID()}@example.test`,
			stableUserId,
		)
		.run()
}

async function seedAccount(input: {
	db: D1Database
	email: string
	username: string
	emailVerifiedAt?: string | null
}) {
	const stableUserId = await createStableUserIdFromEmail(input.email)
	await input.db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, plan)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(email) DO UPDATE SET
			   username = excluded.username,
			   email_verified_at = excluded.email_verified_at,
			   stable_user_id = COALESCE(users.stable_user_id, excluded.stable_user_id),
			   plan = excluded.plan,
			   updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(
			input.username,
			input.email,
			'test-password-hash',
			input.emailVerifiedAt === undefined
				? new Date().toISOString()
				: input.emailVerifiedAt,
			stableUserId,
			'max',
		)
		.run()
}

async function seedVerifiedAccount(input: {
	db: D1Database
	email: string
	username: string
}) {
	await seedAccount(input)
}

// Package subscription dispatch boots the real Worker Loader sandbox, which
// costs seconds per run. The shared default is 5s locally (20s in CI), so
// budget these explicitly like the other sandbox-executing suites rather than
// letting them flake under a loaded `npm run validate`.
const subscriptionDispatchTimeoutMs = 60_000

test('inbound email routes {username}@platform-domain and auto-provisions the default inbox', async () => {
	// Usage recording degrades with a warn when the usage_rollups table is
	// not part of this test's schema; that is incidental to routing.
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	const username = `inbound-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `account-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	const address = `${username}@${platformDomain}`
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
	})

	const firstMessage = createForwardableEmailMessage({
		from: 'stranger@example.net',
		to: address,
		raw: [
			'From: Stranger <stranger@example.net>',
			`To: ${address}`,
			'Subject: Unknown sender',
			'Message-ID: <unknown@example.net>',
			'',
			'Please help.',
		].join('\r\n'),
	})
	await handleInboundEmail(firstMessage, createInboundEnv())
	expect(firstMessage.rejectedReason).toBeNull()

	// First inbound provisioned the default inbox and address.
	const inboxes = await listEmailInboxesForUser({ db: env.APP_DB, userId })
	expect(inboxes).toHaveLength(1)
	expect(inboxes[0]).toMatchObject({ name: defaultEmailInboxName })
	const addresses = await listEmailInboxAddressesForUser({
		db: env.APP_DB,
		userId,
	})
	expect(addresses).toHaveLength(1)
	expect(addresses[0]).toMatchObject({
		address,
		localPart: username,
		domain: platformDomain,
	})
	// Provisioning also created the platform-assigned verified sender
	// identity for the same address.
	const identity = await env.APP_DB.prepare(
		`SELECT email, domain, status FROM email_sender_identities
			WHERE user_id = ? AND email = ?`,
	)
		.bind(userId, address)
		.first<Record<string, unknown>>()
	expect(identity).toEqual({
		email: address,
		domain: platformDomain,
		status: 'verified',
	})
	const inbox = inboxes[0]!

	const secondMessage = createForwardableEmailMessage({
		from: 'agent@trusted.example',
		to: `${username.toUpperCase()}@${platformDomain}`,
		raw: [
			'From: Agent <agent@trusted.example>',
			`To: ${address}`,
			'Subject: Approved sender',
			'Message-ID: <approved@trusted.example>',
			'',
			'Approved body.',
		].join('\r\n'),
	})
	await handleInboundEmail(secondMessage, createInboundEnv())
	expect(secondMessage.rejectedReason).toBeNull()

	// The second delivery reuses the provisioned inbox instead of creating
	// another one.
	expect(
		await listEmailInboxesForUser({ db: env.APP_DB, userId }),
	).toHaveLength(1)

	const messages = await listEmailMessages({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		limit: 10,
	})
	expect(messages).toHaveLength(2)
	expect(messages[0]).toMatchObject({
		fromAddress: 'agent@trusted.example',
		subject: 'Approved sender',
		processingStatus: 'stored',
	})
	expect(messages[1]).toMatchObject({
		fromAddress: 'stranger@example.net',
		subject: 'Unknown sender',
		error: null,
	})

	const normalizedExistingThread = await createEmailThread({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		subjectNormalized: 'normalized subject',
	})
	const subjectOnlyMessage = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw: [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Re: Normalized Subject',
			'',
			'Subject-only body.',
		].join('\r\n'),
	})
	await handleInboundEmail(subjectOnlyMessage, createInboundEnv())
	const subjectOnly = await listEmailMessages({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		limit: 1,
	})
	expect(subjectOnly[0]?.threadId).not.toBe(normalizedExistingThread.id)

	// RFC 5233 subaddressing routes {username}+{tag} to the same inbox and
	// keeps the full tagged address in the stored to_addresses so package
	// handlers can dispatch on the tag.
	const taggedAddress = `${username}+billing@${platformDomain}`
	const taggedMessage = createForwardableEmailMessage({
		from: 'invoices@example.net',
		to: taggedAddress,
		raw: [
			'From: Invoices <invoices@example.net>',
			`To: ${taggedAddress}`,
			'Subject: Subaddressed mail',
			'Message-ID: <subaddressed@example.net>',
			'',
			'Tagged body.',
		].join('\r\n'),
	})
	await handleInboundEmail(taggedMessage, createInboundEnv())
	expect(taggedMessage.rejectedReason).toBeNull()
	const taggedStored = await listEmailMessages({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		limit: 1,
	})
	expect(taggedStored[0]).toMatchObject({
		subject: 'Subaddressed mail',
		toAddresses: [taggedAddress],
	})
	// Still the same single auto-provisioned inbox after the tagged delivery.
	expect(
		await listEmailInboxesForUser({ db: env.APP_DB, userId }),
	).toHaveLength(1)
})

test('inbound email rejects unknown usernames, reserved locals, and foreign domains', async () => {
	// Usage recording degrades with a warn when the usage_rollups table is
	// not part of this test's schema; that is incidental to rejection.
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)

	async function expectRejected(input: { to: string; reason: string }) {
		const message = createForwardableEmailMessage({
			from: 'stranger@example.net',
			to: input.to,
			raw: [
				'From: Stranger <stranger@example.net>',
				`To: ${input.to}`,
				'Subject: Should be rejected',
				'',
				'Please help.',
			].join('\r\n'),
		})
		await handleInboundEmail(message, createInboundEnv())
		expect(message.rejectedReason).toBe(input.reason)
	}

	// Unknown username on the platform domain.
	await expectRejected({
		to: `missing-${crypto.randomUUID().slice(0, 8)}@${platformDomain}`,
		reason: 'Unknown Kody email address.',
	})
	// Reserved locals that are not configured system inboxes still reject before
	// any username lookup.
	await expectRejected({
		to: `help@${platformDomain}`,
		reason: 'This address is reserved for system mail.',
	})
	// Subaddressing cannot smuggle past the reserved or unknown checks: the
	// base local part (before the +) is what routes.
	await expectRejected({
		to: `help+tag@${platformDomain}`,
		reason: 'This address is reserved for system mail.',
	})
	await expectRejected({
		to: `missing-${crypto.randomUUID().slice(0, 8)}+tag@${platformDomain}`,
		reason: 'Unknown Kody email address.',
	})
	// Mail for other domains is never a Kody user inbox.
	await expectRejected({
		to: 'someone@other.example.com',
		reason: 'Unknown Kody email address.',
	})
	// The app's apex domain is not a user inbox either: user mail lives
	// exclusively on the inbox. subdomain; the apex hosts only system mail.
	{
		const apexUsername = `apex-${crypto.randomUUID().slice(0, 8)}`
		await seedVerifiedAccount({
			db: env.APP_DB,
			email: `apex-${crypto.randomUUID()}@example.com`,
			username: apexUsername,
		})
		await expectRejected({
			to: `${apexUsername}@kody.example.com`,
			reason: 'Unknown Kody email address.',
		})
	}

	// A disabled legacy row holding the platform address makes the inbox
	// unavailable (clean reject) instead of crashing provisioning on the
	// unique address constraint.
	{
		const username = `disabled-${crypto.randomUUID().slice(0, 8)}`
		const accountEmail = `disabled-${crypto.randomUUID()}@example.com`
		const userId = await createStableUserIdFromEmail(accountEmail)
		await seedVerifiedAccount({
			db: env.APP_DB,
			email: accountEmail,
			username,
		})
		const heldAddress = `${username}@${platformDomain}`
		const primer = createForwardableEmailMessage({
			from: 'stranger@example.net',
			to: heldAddress,
			raw: [
				'From: Stranger <stranger@example.net>',
				`To: ${heldAddress}`,
				'Subject: Provision first',
				'',
				'Body.',
			].join('\r\n'),
		})
		await handleInboundEmail(primer, createInboundEnv())
		expect(primer.rejectedReason).toBeNull()
		await env.APP_DB.prepare(
			`UPDATE email_inbox_addresses SET enabled = 0 WHERE address = ? AND user_id = ?`,
		)
			.bind(heldAddress, userId)
			.run()
		await expectRejected({
			to: heldAddress,
			reason: 'Email inbox is unavailable.',
		})
	}

	// Without APP_BASE_URL there is no platform domain to route.
	const unroutable = createForwardableEmailMessage({
		from: 'stranger@example.net',
		to: `user@${platformDomain}`,
		raw: [
			'From: Stranger <stranger@example.net>',
			`To: user@${platformDomain}`,
			'Subject: Unroutable',
			'',
			'Body.',
		].join('\r\n'),
	})
	await handleInboundEmail(unroutable, { ...env, APP_BASE_URL: undefined })
	expect(unroutable.rejectedReason).toBe('Email routing is not configured.')

	// Oversize mail for a valid user trips the pre-parse
	// email_message_bytes gate (max-plan cap is 512 KiB) with the
	// generic over-quota reason, before anything is stored.
	const username = `parse-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `parse-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	const address = `${username}@${platformDomain}`
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
	})
	const oversizeMessage = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw: 'Subject: Too large\r\n\r\nBody',
	})
	Object.defineProperty(oversizeMessage, 'rawSize', {
		value: 600 * 1024,
	})

	await handleInboundEmail(oversizeMessage, createInboundEnv())

	expect(oversizeMessage.rejectedReason).toBe(
		'Recipient mailbox is over quota.',
	)

	// A raw stream that fails mid-read is transient and must retry before a
	// delivery identity or quota charge is created.
	const unreadableMessage = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw: 'Subject: Unreadable\r\n\r\nBody',
	})
	Object.defineProperty(unreadableMessage, 'raw', {
		value: new ReadableStream({
			pull() {
				throw new Error('raw stream read failed')
			},
		}),
	})

	await expect(
		handleInboundEmail(unreadableMessage, createInboundEnv()),
	).rejects.toBeInstanceOf(RetryableInboundStorageError)
	expect(unreadableMessage.rejectedReason).toBeNull()
	const rejectedMessages = await listEmailMessages({
		db: env.APP_DB,
		userId,
		limit: 10,
	})
	expect(rejectedMessages).toEqual([])
})

test('inbound email reclaims a platform address left behind by a username change', async () => {
	// Usage recording degrades with a warn when the usage_rollups table is
	// not part of this test's schema; that is incidental to reclaiming.
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	const username = `recycled-${crypto.randomUUID().slice(0, 8)}`
	const address = `${username}@${platformDomain}`
	const firstEmail = `first-owner-${crypto.randomUUID()}@example.com`
	const firstUserId = await createStableUserIdFromEmail(firstEmail)
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: firstEmail,
		username,
	})

	const primer = createForwardableEmailMessage({
		from: 'stranger@example.net',
		to: address,
		raw: [
			'From: Stranger <stranger@example.net>',
			`To: ${address}`,
			'Subject: First owner mail',
			'',
			'Body.',
		].join('\r\n'),
	})
	await handleInboundEmail(primer, createInboundEnv())
	expect(primer.rejectedReason).toBeNull()

	// The first owner renames; a new user registers the freed username.
	await env.APP_DB.prepare(`UPDATE users SET username = ? WHERE email = ?`)
		.bind(`renamed-${crypto.randomUUID().slice(0, 8)}`, firstEmail)
		.run()
	const secondEmail = `second-owner-${crypto.randomUUID()}@example.com`
	const secondUserId = await createStableUserIdFromEmail(secondEmail)
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: secondEmail,
		username,
	})

	const message = createForwardableEmailMessage({
		from: 'stranger@example.net',
		to: address,
		raw: [
			'From: Stranger <stranger@example.net>',
			`To: ${address}`,
			'Subject: Second owner mail',
			'',
			'Body.',
		].join('\r\n'),
	})
	await handleInboundEmail(message, createInboundEnv())
	expect(message.rejectedReason).toBeNull()

	// The stale address row was reclaimed for the current username owner...
	const addresses = await listEmailInboxAddressesForUser({
		db: env.APP_DB,
		userId: secondUserId,
	})
	expect(addresses.map((row) => row.address)).toEqual([address])
	expect(
		await listEmailInboxAddressesForUser({
			db: env.APP_DB,
			userId: firstUserId,
		}),
	).toEqual([])
	// ...and the new mail routed to them while the old owner keeps their
	// previously stored messages.
	const secondMessages = await listEmailMessages({
		db: env.APP_DB,
		userId: secondUserId,
		limit: 10,
	})
	expect(secondMessages.map((row) => row.subject)).toEqual([
		'Second owner mail',
	])
	const firstMessages = await listEmailMessages({
		db: env.APP_DB,
		userId: firstUserId,
		limit: 10,
	})
	expect(firstMessages.map((row) => row.subject)).toEqual(['First owner mail'])
})

test('inbound email handler rejects mail for unverified accounts', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const username = `unverified-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `email-unverified-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	const address = `${username}@${platformDomain}`
	await seedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
		emailVerifiedAt: null,
	})

	for (let index = 0; index < 2; index += 1) {
		const message = createForwardableEmailMessage({
			from: 'stranger@example.net',
			to: address,
			raw: [
				'From: Stranger <stranger@example.net>',
				`To: ${address}`,
				'Subject: Should be rejected',
				`Message-ID: <rejected-${index}@example.net>`,
				'',
				'Please help.',
			].join('\r\n'),
		})
		await handleInboundEmail(message, createInboundEnv())
		expect(message.rejectedReason).toBe('Account email is not verified.')
	}

	const messages = await listEmailMessages({
		db: env.APP_DB,
		userId,
		limit: 10,
	})
	expect(messages).toEqual([])
	const counterRow = await env.APP_DB.prepare(
		`SELECT count FROM entitlement_daily_counters
			WHERE user_id = ? AND resource = 'email_receives_per_day'`,
	)
		.bind(userId)
		.first<{ count: number }>()
	expect(counterRow).toBeNull()
	const events = await env.APP_DB.prepare(
		`SELECT event_type, detail_json FROM email_delivery_events WHERE user_id = ?`,
	)
		.bind(userId)
		.all<{ event_type: string; detail_json: string }>()
	const details = (events.results ?? []).map((row) => ({
		eventType: row.event_type,
		detail: JSON.parse(row.detail_json) as Record<string, unknown>,
	}))
	expect(details).toHaveLength(3)
	expect(details.every((row) => row.eventType === 'rejected')).toBe(true)
	expect(
		details.find((row) => row.detail['aggregate'] !== true)?.detail,
	).toMatchObject({
		reason: 'Account email is not verified.',
		phase: 'account-verification',
	})
	expect(
		details.find((row) => row.detail['aggregate'] === true)?.detail,
	).toMatchObject({
		count: 2,
		last_phase: 'account-verification',
	})
	const rollup = await env.APP_DB.prepare(
		`SELECT event_count, error_count FROM usage_rollups
			WHERE user_id = ? AND metric = 'email_received' AND month = ?`,
	)
		.bind(userId, new Date().toISOString().slice(0, 7))
		.first<{ event_count: number; error_count: number }>()
	expect(rollup).toMatchObject({ event_count: 2, error_count: 2 })
})

test('inbound email handler rejects mail for suspended accounts', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const username = `suspended-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `email-suspended-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	const address = `${username}@${platformDomain}`
	await seedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
	})
	await env.APP_DB.prepare(
		`UPDATE users SET suspended_at = ? WHERE stable_user_id = ?`,
	)
		.bind(new Date().toISOString(), userId)
		.run()

	const message = createForwardableEmailMessage({
		from: 'stranger@example.net',
		to: address,
		raw: [
			'From: Stranger <stranger@example.net>',
			`To: ${address}`,
			'Subject: Should be rejected',
			'Message-ID: <suspended-1@example.net>',
			'',
			'Please help.',
		].join('\r\n'),
	})
	await handleInboundEmail(message, createInboundEnv())
	expect(message.rejectedReason).toBe('Account is suspended.')

	expect(
		await listEmailMessages({
			db: env.APP_DB,
			userId,
			limit: 10,
		}),
	).toEqual([])
	const events = await env.APP_DB.prepare(
		`SELECT event_type, detail_json FROM email_delivery_events WHERE user_id = ?`,
	)
		.bind(userId)
		.all<{ event_type: string; detail_json: string }>()
	const details = (events.results ?? []).map((row) => ({
		eventType: row.event_type,
		detail: JSON.parse(row.detail_json) as Record<string, unknown>,
	}))
	expect(details.every((row) => row.eventType === 'rejected')).toBe(true)
	expect(
		details.find((row) => row.detail['aggregate'] !== true)?.detail,
	).toMatchObject({
		reason: 'Account is suspended.',
		phase: 'account-suspension',
	})
})

test('getEmailAttachmentById reconstructs unnamed attachments from raw MIME', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `email-attachment-user-${crypto.randomUUID()}`
	await insertWritableEmailTestUser(userId)
	const stored = await insertEmailMessageWithAttachments({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		message: {
			direction: 'inbound',
			userId,
			inboxId: null,
			threadId: null,
			senderIdentityId: null,
			fromAddress: 'sender@example.net',
			envelopeFrom: 'sender@example.net',
			toAddresses: ['receiver@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			replyToAddresses: [],
			subject: 'Unnamed attachment',
			messageIdHeader: '<unnamed-attachment@example.net>',
			inReplyToHeader: null,
			references: [],
			headers: { from: ['Sender <sender@example.net>'] },
			authResults: null,
			textBody: 'See attachment.\n',
			htmlBody: null,
			rawMime: [
				'From: Sender <sender@example.net>',
				'To: Receiver <receiver@example.com>',
				'Subject: Unnamed attachment',
				'Message-ID: <unnamed-attachment@example.net>',
				'Content-Type: multipart/mixed; boundary="mail-boundary"',
				'',
				'--mail-boundary',
				'Content-Type: text/plain; charset="utf-8"',
				'',
				'See attachment.',
				'--mail-boundary',
				'Content-Type: text/plain',
				'Content-Disposition: attachment',
				'',
				'Attachment without filename',
				'--mail-boundary--',
			].join('\r\n'),
			rawSize: 0,
			processingStatus: 'stored',
			providerMessageId: null,
			error: null,
			receivedAt: new Date().toISOString(),
			sentAt: null,
		},
		attachments: [
			{
				filename: null,
				contentType: 'text/plain',
				contentId: null,
				disposition: 'attachment',
				size: new TextEncoder().encode('Attachment without filename\n')
					.byteLength,
				storageKind: 'raw-mime',
				storageKey: null,
			},
		],
	})
	const attachments = await listEmailAttachmentsForMessage({
		db: env.APP_DB,
		messageId: stored.id,
	})
	const attachment = attachments[0]
	expect(attachment).toBeDefined()
	if (!attachment) {
		throw new Error('Expected inserted attachment')
	}

	const loaded = await getEmailAttachmentById({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		userId,
		attachmentId: attachment.id,
	})

	expect(loaded).toMatchObject({
		id: attachment.id,
		filename: null,
		contentType: 'text/plain',
		disposition: 'attachment',
	})
	expect(loaded?.contentBase64).toBeTruthy()
	expect(loaded?.contentBase64 ? atob(loaded.contentBase64) : null).toBe(
		'Attachment without filename\n',
	)
})

test('inbound email stores raw MIME in R2 and readers and deletes follow the blob', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const username = `blob-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `blob-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	const address = `${username}@${platformDomain}`
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
	})

	const raw = [
		'From: Sender <sender@example.net>',
		`To: ${address}`,
		'Subject: Blob stored mail',
		'Message-ID: <blob-stored@example.net>',
		'Content-Type: multipart/mixed; boundary="mail-boundary"',
		'',
		'--mail-boundary',
		'Content-Type: text/plain; charset="utf-8"',
		'',
		'Blob body.',
		'--mail-boundary',
		'Content-Type: text/plain; name="note.txt"',
		'Content-Disposition: attachment; filename="note.txt"',
		'',
		'Attachment text',
		'--mail-boundary--',
	].join('\r\n')
	const message = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw,
	})
	await handleInboundEmail(message, createInboundEnv())
	expect(message.rejectedReason).toBeNull()

	const [stored] = await listEmailMessages({
		db: env.APP_DB,
		userId,
		limit: 1,
	})
	expect(stored).toBeDefined()
	if (!stored) throw new Error('Expected stored inbound message')

	// The raw MIME lives at the per-user R2 key only.
	expect(stored.rawMimeKey).toBe(emailRawMimeKey(userId, stored.id))
	const blob = await env.EMAIL_BLOBS.get(stored.rawMimeKey!)
	expect(await blob?.text()).toBe(raw)

	// The shared read helper resolves the blob by raw_mime_key.
	expect(await loadRawMime({ blobs: env.EMAIL_BLOBS, message: stored })).toBe(
		raw,
	)

	// Attachment content is reconstructed from the R2-stored MIME.
	const attachments = await listEmailAttachmentsForMessage({
		db: env.APP_DB,
		messageId: stored.id,
	})
	expect(attachments).toHaveLength(1)
	const loaded = await getEmailAttachmentById({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		userId,
		attachmentId: attachments[0]!.id,
	})
	expect(loaded?.contentBase64 ? atob(loaded.contentBase64) : null).toBe(
		'Attachment text\n',
	)

	// Deleting the message also removes its blob.
	await deleteEmailMessageById({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		messageId: stored.id,
	})
	expect(
		await getEmailMessageById({
			db: env.APP_DB,
			userId,
			messageId: stored.id,
		}),
	).toBeNull()
	expect(await env.EMAIL_BLOBS.get(stored.rawMimeKey!)).toBeNull()
})

async function readUserDailyReceiveCount(userId: string) {
	const row = await env.APP_DB.prepare(
		`SELECT count FROM entitlement_daily_counters
			WHERE user_id = ? AND resource = 'email_receives_per_day' AND day = ?`,
	)
		.bind(userId, new Date().toISOString().slice(0, 10))
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

function createFailingEmailBlobs() {
	return new Proxy(env.EMAIL_BLOBS, {
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
}

function createPreCommitD1FailureDb() {
	return new Proxy(env.APP_DB, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (query: string) => {
					const statement = target.prepare(query)
					if (!query.includes('INSERT INTO email_messages')) {
						return statement
					}
					return {
						bind: () => ({
							run: async () => {
								throw new Error('simulated D1 insert failure')
							},
						}),
					}
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	}) as D1Database
}

function createPostCommitBookkeepingFailureDb() {
	let messageCommitted = false
	return new Proxy(env.APP_DB, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (query: string) => {
					const statement = target.prepare(query)
					if (query.includes('INSERT INTO email_messages')) {
						return {
							bind(...params: Array<unknown>) {
								const bound = statement.bind(...params)
								return {
									run: async () => {
										const result = await bound.run()
										messageCommitted = true
										return result
									},
								}
							},
						}
					}
					if (
						messageCommitted &&
						(query.includes('UPDATE email_threads') ||
							query.includes('INSERT INTO email_delivery_events'))
					) {
						return {
							bind: () => ({
								run: async () => {
									throw new Error('simulated post-commit bookkeeping failure')
								},
							}),
						}
					}
					return statement
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	}) as D1Database
}

test('inbound R2/D1 failures and retries reuse one quota charge, row, thread, and blob', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	const username = `r2fail-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `r2fail-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	const address = `${username}@${platformDomain}`
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
	})

	const raw = [
		'From: Sender <sender@example.net>',
		`To: ${address}`,
		'Subject: R2 failure mail',
		'Message-ID: <r2-failure@example.net>',
		'',
		'Should not persist.',
	].join('\r\n')
	const r2FailingEnv = {
		...createInboundEnv(),
		EMAIL_BLOBS: createFailingEmailBlobs(),
	} as Parameters<typeof handleInboundEmail>[1]
	const d1FailingEnv = {
		...createInboundEnv(),
		APP_DB: createPreCommitD1FailureDb(),
	} as Parameters<typeof handleInboundEmail>[1]

	for (const failingEnv of [r2FailingEnv, d1FailingEnv]) {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const message = createForwardableEmailMessage({
				from: 'sender@example.net',
				to: address,
				raw,
			})
			await expect(
				handleInboundEmail(message, failingEnv),
			).rejects.toBeInstanceOf(RetryableInboundStorageError)
			expect(message.rejectedReason).toBeNull()
			expect(await readUserDailyReceiveCount(userId)).toBe(1)
		}
	}

	expect(
		await listEmailMessages({
			db: env.APP_DB,
			userId,
			limit: 10,
		}),
	).toEqual([])

	const retryMessage = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw,
	})
	await handleInboundEmail(retryMessage, createInboundEnv())
	expect(retryMessage.rejectedReason).toBeNull()
	expect(await readUserDailyReceiveCount(userId)).toBe(1)
	expect(
		await listEmailMessages({
			db: env.APP_DB,
			userId,
			limit: 10,
		}),
	).toHaveLength(1)
	const [stored] = await listEmailMessages({
		db: env.APP_DB,
		userId,
		limit: 10,
	})
	expect(stored?.rawMimeKey).toBe(emailRawMimeKey(userId, stored!.id))
	expect(await (await env.EMAIL_BLOBS.get(stored!.rawMimeKey!))?.text()).toBe(
		raw,
	)
	const blobs = await env.EMAIL_BLOBS.list({
		prefix: `email-raw:v1:${userId}/`,
	})
	expect(blobs.objects.map((object) => object.key)).toEqual([
		stored!.rawMimeKey,
	])
	const threadCount = await env.APP_DB.prepare(
		`SELECT COUNT(*) AS count FROM email_threads WHERE user_id = ?`,
	)
		.bind(userId)
		.first<{ count: number }>()
	expect(Number(threadCount?.count ?? 0)).toBe(1)
})

test('charged retry repairs after unrelated writes fill storage bytes', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	const username = `storage-retry-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `storage-retry-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	const address = `${username}@${platformDomain}`
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
	})
	await env.APP_DB.prepare(
		`UPDATE users SET plan = 'free' WHERE stable_user_id = ?`,
	)
		.bind(userId)
		.run()
	const raw = [
		'From: Sender <sender@example.net>',
		`To: ${address}`,
		'Subject: Charged storage retry',
		'Message-ID: <charged-storage-retry@example.net>',
		'',
		'Body',
	].join('\r\n')
	const first = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw,
	})
	await expect(
		handleInboundEmail(first, {
			...createInboundEnv(),
			EMAIL_BLOBS: createFailingEmailBlobs(),
		}),
	).rejects.toBeInstanceOf(RetryableInboundStorageError)
	expect(await readUserDailyReceiveCount(userId)).toBe(1)

	const storageLimit = planLimits.free.maxStorageBytes
	if (storageLimit == null) throw new Error('Expected finite storage limit.')
	await insertEmailMessage({
		db: env.APP_DB,
		message: {
			direction: 'outbound',
			userId,
			rawSize: storageLimit,
			processingStatus: 'sent',
		},
	})
	const retry = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw,
	})
	await handleInboundEmail(retry, createInboundEnv())
	expect(retry.rejectedReason).toBeNull()
	expect(await readUserDailyReceiveCount(userId)).toBe(1)
	expect(
		(await listEmailMessages({ db: env.APP_DB, userId, limit: 10 })).filter(
			(message) => message.direction === 'inbound',
		),
	).toHaveLength(1)
})

test('ambiguous quota-ledger batch response charges one delivery exactly once', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	const username = `quota-ambiguous-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `quota-ambiguous-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	const address = `${username}@${platformDomain}`
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
	})
	let batchCalls = 0
	const ambiguousDb = new Proxy(env.APP_DB, {
		get(target, property, receiver) {
			if (property === 'batch') {
				return async (statements: Parameters<D1Database['batch']>[0]) => {
					batchCalls++
					const result = await target.batch(statements)
					// The account-write lease acquire is the first batch. Lose the
					// response from the following quota-ledger batch.
					if (batchCalls === 2) {
						throw new Error('simulated quota batch response loss')
					}
					return result
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	}) as D1Database
	const raw = [
		'From: Sender <sender@example.net>',
		`To: ${address}`,
		'Subject: Ambiguous quota claim',
		'Message-ID: <ambiguous-quota@example.net>',
		'',
		'Body',
	].join('\r\n')
	const message = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw,
	})

	await handleInboundEmail(message, {
		...createInboundEnv(),
		APP_DB: ambiguousDb,
	})
	const retry = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw,
	})
	await handleInboundEmail(retry, createInboundEnv())
	expect(await readUserDailyReceiveCount(userId)).toBe(1)
	expect(
		await listEmailMessages({
			db: env.APP_DB,
			userId,
			limit: 10,
		}),
	).toHaveLength(1)
})

test('delivery-window claim serializes identical mail across a bucket boundary', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const boundary =
		Math.ceil(
			Date.parse('2026-07-20T12:00:00.000Z') / inboundDeliveryDedupeWindowMs,
		) * inboundDeliveryDedupeWindowMs
	const input = {
		userId: `user-${crypto.randomUUID()}`,
		inboxId: `inbox-${crypto.randomUUID()}`,
		recipient: 'boundary@example.com',
		rawMime: 'identical boundary bytes',
		quotaDay: '2026-07-20',
	}
	const before = await buildInboundDelivery({
		...input,
		now: new Date(boundary - 1),
	})
	const after = await buildInboundDelivery({
		...input,
		now: new Date(boundary + 1),
	})
	expect(before.deliveryId).not.toBe(after.deliveryId)

	const [first, second] = await Promise.all([
		claimInboundDeliveryWindow({
			db: env.APP_DB,
			delivery: before,
			now: new Date(boundary - 1),
		}),
		claimInboundDeliveryWindow({
			db: env.APP_DB,
			delivery: after,
			now: new Date(boundary + 1),
		}),
	])
	expect(first.deliveryId).toBe(second.deliveryId)
})

test('expired delivery-window pointers are pruned per user while active pointers remain', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `user-${crypto.randomUUID()}`
	const oldNow = new Date('2026-07-19T00:00:00.000Z')
	const currentNow = new Date('2026-07-22T00:00:00.000Z')
	const expired = await buildInboundDelivery({
		userId,
		inboxId: `inbox-${crypto.randomUUID()}`,
		recipient: 'expired@example.com',
		rawMime: 'expired',
		quotaDay: '2026-07-19',
		now: oldNow,
	})
	const active = await buildInboundDelivery({
		userId,
		inboxId: expired.inboxId,
		recipient: 'active@example.com',
		rawMime: 'active',
		quotaDay: '2026-07-22',
		now: currentNow,
	})
	await claimInboundDeliveryWindow({
		db: env.APP_DB,
		delivery: expired,
		now: oldNow,
	})
	await claimInboundDeliveryWindow({
		db: env.APP_DB,
		delivery: active,
		now: currentNow,
	})

	expect(
		await pruneExpiredInboundDedupePointers({
			db: env.APP_DB,
			userId,
			now: currentNow,
		}),
	).toBe(1)
	const pointers = await env.APP_DB.prepare(
		`SELECT id FROM email_delivery_events
		WHERE user_id = ? AND provider = 'cloudflare-email-routing-dedupe'`,
	)
		.bind(userId)
		.all<{ id: string }>()
	expect(pointers.results?.map((row) => row.id)).toEqual([
		`email-inbound-dedupe:${active.fingerprint}`,
	])
})

test('pointer-only retry after midnight enforces the current quota day', async () => {
	silenceIncidentalRuntimeWarnings()
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		const oldNow = new Date('2026-07-22T23:59:00.000Z')
		const retryNow = new Date('2026-07-23T00:01:00.000Z')
		vi.setSystemTime(oldNow)
		await ensureEmailTestSchema(env.APP_DB)
		const username = `midnight-${crypto.randomUUID().slice(0, 8)}`
		const accountEmail = `midnight-${crypto.randomUUID()}@example.com`
		const userId = await createStableUserIdFromEmail(accountEmail)
		const address = `${username}@${platformDomain}`
		await seedVerifiedAccount({
			db: env.APP_DB,
			email: accountEmail,
			username,
		})
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
		if (!provisioned) throw new Error('Expected provisioned inbox.')
		const raw = [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Midnight pointer retry',
			'Message-ID: <midnight-pointer@example.net>',
			'',
			'Body',
		].join('\r\n')
		const pointer = await buildInboundDelivery({
			userId,
			inboxId: provisioned.inbox.id,
			recipient: address,
			envelopeFrom: 'sender@example.net',
			rawMime: raw,
			quotaDay: '2026-07-22',
			now: oldNow,
		})
		await claimInboundDeliveryWindow({
			db: env.APP_DB,
			delivery: pointer,
			now: oldNow,
		})
		const receiveLimit = planLimits.free.maxEmailReceivesPerDay
		if (receiveLimit == null) throw new Error('Expected finite receive limit.')
		await env.APP_DB.prepare(
			`INSERT INTO entitlement_daily_counters (
				user_id, resource, day, count, updated_at
			) VALUES (?, 'email_receives_per_day', '2026-07-23', ?, ?)`,
		)
			.bind(userId, receiveLimit, retryNow.toISOString())
			.run()

		vi.setSystemTime(retryNow)
		const retry = createForwardableEmailMessage({
			from: 'sender@example.net',
			to: address,
			raw,
		})
		await handleInboundEmail(retry, createInboundEnv())
		expect(retry.rejectedReason).toBe('Recipient mailbox is over quota.')
		expect(
			await env.APP_DB.prepare(
				`SELECT id FROM email_delivery_events
				WHERE id = ? AND user_id = ?`,
			)
				.bind(pointer.deliveryId, userId)
				.first(),
		).toBeNull()
	} finally {
		vi.useRealTimers()
	}
})

test('byte-identical mail dedupes only inside the explicit delivery window', async () => {
	silenceIncidentalRuntimeWarnings()
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		const firstNow = new Date('2026-07-20T12:00:00.000Z')
		vi.setSystemTime(firstNow)
		await ensureEmailTestSchema(env.APP_DB)
		await ensureUsageRollupsTestSchema(env.APP_DB)
		const username = `dedupe-window-${crypto.randomUUID().slice(0, 8)}`
		const accountEmail = `dedupe-window-${crypto.randomUUID()}@example.com`
		const userId = await createStableUserIdFromEmail(accountEmail)
		const address = `${username}@${platformDomain}`
		await seedVerifiedAccount({
			db: env.APP_DB,
			email: accountEmail,
			username,
		})
		const raw = [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Identical periodic mail',
			'',
			'Same bytes.',
		].join('\r\n')
		const deliver = () =>
			handleInboundEmail(
				createForwardableEmailMessage({
					from: 'sender@example.net',
					to: address,
					raw,
				}),
				createInboundEnv(),
			)

		await deliver()
		await deliver()
		expect(
			await listEmailMessages({
				db: env.APP_DB,
				userId,
				limit: 10,
			}),
		).toHaveLength(1)
		expect(
			await env.APP_DB.prepare(
				`SELECT event_count FROM usage_rollups
				WHERE user_id = ? AND metric = 'email_received'`,
			)
				.bind(userId)
				.first<{ event_count: number }>(),
		).toEqual({ event_count: 1 })

		vi.setSystemTime(
			new Date(firstNow.getTime() + inboundDeliveryDedupeWindowMs + 1),
		)
		await deliver()
		expect(
			await listEmailMessages({
				db: env.APP_DB,
				userId,
				limit: 10,
			}),
		).toHaveLength(2)
		const counter = await env.APP_DB.prepare(
			`SELECT SUM(count) AS count FROM entitlement_daily_counters
			WHERE user_id = ? AND resource = 'email_receives_per_day'`,
		)
			.bind(userId)
			.first<{ count: number }>()
		expect(Number(counter?.count ?? 0)).toBe(2)
		expect(
			await env.APP_DB.prepare(
				`SELECT event_count FROM usage_rollups
				WHERE user_id = ? AND metric = 'email_received'`,
			)
				.bind(userId)
				.first<{ event_count: number }>(),
		).toEqual({ event_count: 2 })
	} finally {
		vi.useRealTimers()
	}
})

test('identical MIME from distinct envelope senders creates separate deliveries', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	const username = `envelopes-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `envelopes-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	const address = `${username}@${platformDomain}`
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
	})
	const raw = [
		'From: Shared <shared@example.net>',
		`To: ${address}`,
		'Subject: Same MIME',
		'',
		'Identical payload.',
	].join('\r\n')
	for (const from of ['envelope-a@example.net', 'envelope-b@example.net']) {
		await handleInboundEmail(
			createForwardableEmailMessage({ from, to: address, raw }),
			createInboundEnv(),
		)
	}
	expect(
		await listEmailMessages({ db: env.APP_DB, userId, limit: 10 }),
	).toHaveLength(2)
	expect(await readUserDailyReceiveCount(userId)).toBe(2)
})

test('inbound post-commit bookkeeping failure keeps one stored row without refund or retry throw', async () => {
	silenceIncidentalRuntimeWarnings()
	silenceExpectedConsoleErrors(['inbound-email-post-commit-bookkeeping-failed'])
	await ensureEmailTestSchema(env.APP_DB)
	const username = `postcommit-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `postcommit-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	const address = `${username}@${platformDomain}`
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
	})
	const message = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw: [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Post-commit bookkeeping',
			'Message-ID: <post-commit@example.net>',
			'',
			'Body',
		].join('\r\n'),
	})
	const failingEnv = {
		...createInboundEnv(),
		APP_DB: createPostCommitBookkeepingFailureDb(),
	} as Parameters<typeof handleInboundEmail>[1]

	await handleInboundEmail(message, failingEnv)
	expect(message.rejectedReason).toBeNull()
	expect(await readUserDailyReceiveCount(userId)).toBe(1)
	expect(
		await listEmailMessages({
			db: env.APP_DB,
			userId,
			limit: 10,
		}),
	).toHaveLength(1)
})

test('delivery-ledger finalization failure retries before usage or subscription success', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const username = `finalize-fail-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `finalize-fail-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	const address = `${username}@${platformDomain}`
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
	})
	let finalizationFailed = false
	const failingDb = new Proxy(env.APP_DB, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (query: string) => {
					const statement = target.prepare(query)
					if (
						finalizationFailed ||
						!query.includes('UPDATE email_delivery_events') ||
						!query.includes('SET message_id = ?')
					) {
						return statement
					}
					return {
						bind: () => ({
							run: async () => {
								finalizationFailed = true
								throw new Error('simulated ledger finalization failure')
							},
						}),
					}
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	}) as D1Database
	const raw = [
		'From: Sender <sender@example.net>',
		`To: ${address}`,
		'Subject: Ledger finalization',
		'Message-ID: <ledger-finalization@example.net>',
		'',
		'Body',
	].join('\r\n')
	const first = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw,
	})

	await expect(
		handleInboundEmail(first, {
			...createInboundEnv(),
			APP_DB: failingDb,
		}),
	).rejects.toBeInstanceOf(RetryableInboundStorageError)
	expect(
		await env.APP_DB.prepare(
			`SELECT event_count FROM usage_rollups
			WHERE user_id = ? AND metric = 'email_received'`,
		)
			.bind(userId)
			.first(),
	).toBeNull()

	const retry = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw,
	})
	await handleInboundEmail(retry, createInboundEnv())
	expect(await readUserDailyReceiveCount(userId)).toBe(1)
	expect(
		await env.APP_DB.prepare(
			`SELECT event_count, error_count FROM usage_rollups
			WHERE user_id = ? AND metric = 'email_received' AND month = ?`,
		)
			.bind(userId, new Date().toISOString().slice(0, 7))
			.first<{ event_count: number; error_count: number }>(),
	).toMatchObject({ event_count: 1, error_count: 0 })
	const delivery = await env.APP_DB.prepare(
		`SELECT id FROM email_delivery_events
		WHERE user_id = ? AND provider = 'cloudflare-email-routing'
			AND event_type = 'received'`,
	)
		.bind(userId)
		.first<{ id: string }>()
	if (!delivery) throw new Error('Expected received delivery ledger.')
	expect(
		await processInboundDeliveryEffects({
			env: createInboundEnv(),
			userId,
			deliveryId: delivery.id,
			expectedFinalizationToken: 'stale-worker-token',
		}),
	).toEqual({ outcome: 'stale' })
	expect(
		await env.APP_DB.prepare(
			`SELECT event_count FROM usage_rollups
			WHERE user_id = ? AND metric = 'email_received'`,
		)
			.bind(userId)
			.first<{ event_count: number }>(),
	).toEqual({ event_count: 1 })
	await env.APP_DB.prepare(
		`DELETE FROM usage_rollups
		WHERE user_id = ? AND metric = 'email_received'`,
	)
		.bind(userId)
		.run()
	await env.APP_DB.prepare(
		`UPDATE email_delivery_events
		SET detail_json = json_remove(
			json_set(detail_json, '$.usageDurationMs', 4321),
			'$.usageEffectRecordedAt'
		)
		WHERE id = ? AND user_id = ?`,
	)
		.bind(delivery.id, userId)
		.run()
	await processInboundDeliveryEffects({
		env: createInboundEnv(),
		userId,
		deliveryId: delivery.id,
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT event_count, total_duration_ms FROM usage_rollups
			WHERE user_id = ? AND metric = 'email_received'`,
		)
			.bind(userId)
			.first<{ event_count: number; total_duration_ms: number }>(),
	).toEqual({ event_count: 1, total_duration_ms: 4321 })
})

test('production usage outbox records one durable D1 event without retry data points', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	const username = `usage-outbox-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `usage-outbox-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	const address = `${username}@${platformDomain}`
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
	})
	const message = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw: [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Usage outbox',
			'Message-ID: <usage-outbox@example.net>',
			'',
			'Body',
		].join('\r\n'),
	})
	await handleInboundEmail(message, {
		...createInboundEnv(),
		USAGE_EVENTS: {
			writeDataPoint() {
				throw new Error('email usage must use the durable D1 outbox')
			},
		},
	})
	const delivery = await env.APP_DB.prepare(
		`SELECT id, detail_json FROM email_delivery_events
		WHERE user_id = ? AND provider = 'cloudflare-email-routing'
			AND event_type = 'received'`,
	)
		.bind(userId)
		.first<{ id: string; detail_json: string }>()
	if (!delivery) throw new Error('Expected received delivery.')
	const detail = JSON.parse(delivery.detail_json) as {
		usageEffectRecordedAt: string
	}
	expect(detail.usageEffectRecordedAt).toEqual(expect.any(String))

	const points: Array<AnalyticsEngineDataPoint> = []
	const effectsEnv = {
		...createInboundEnv(),
		USAGE_EVENTS: {
			writeDataPoint(point?: AnalyticsEngineDataPoint) {
				if (point) points.push(point)
			},
		},
	}
	await processInboundDeliveryEffects({
		env: effectsEnv,
		userId,
		deliveryId: delivery.id,
	})
	await processInboundDeliveryEffects({
		env: effectsEnv,
		userId,
		deliveryId: delivery.id,
	})
	expect(points).toHaveLength(0)
})

test('raw MIME read failure retries before quota and successful redelivery charges once', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	const username = `parse-quota-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `parse-quota-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	const address = `${username}@${platformDomain}`
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
	})

	const raw = 'Subject: Unreadable\r\n\r\nBody'
	const unreadableMessage = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw,
	})
	Object.defineProperty(unreadableMessage, 'raw', {
		value: new ReadableStream({
			pull() {
				throw new Error('raw stream read failed')
			},
		}),
	})
	await expect(
		handleInboundEmail(unreadableMessage, createInboundEnv()),
	).rejects.toBeInstanceOf(RetryableInboundStorageError)
	expect(unreadableMessage.rejectedReason).toBeNull()
	expect(await readUserDailyReceiveCount(userId)).toBe(0)

	const retry = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw,
	})
	await handleInboundEmail(retry, createInboundEnv())
	expect(retry.rejectedReason).toBeNull()
	expect(await readUserDailyReceiveCount(userId)).toBe(1)
	expect(
		await listEmailMessages({
			db: env.APP_DB,
			userId,
			limit: 10,
		}),
	).toHaveLength(1)
})

test('stored-message count failure happens before durable quota charge', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	const username = `count-fail-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `count-fail-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
	})
	const address = `${username}@${platformDomain}`
	const failingDb = new Proxy(env.APP_DB, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (query: string) => {
					if (
						query.includes('COUNT(*)') &&
						query.includes('FROM email_messages')
					) {
						return {
							bind: () => ({
								first: async () => {
									throw new Error('simulated stored count failure')
								},
							}),
						}
					}
					return target.prepare(query)
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	}) as D1Database
	const failingEnv = {
		...createInboundEnv(),
		APP_DB: failingDb,
	} as Parameters<typeof handleInboundEmail>[1]
	const message = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw: [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Count failure',
			'Message-ID: <count-failure@example.net>',
			'',
			'Body',
		].join('\r\n'),
	})

	await expect(handleInboundEmail(message, failingEnv)).rejects.toThrow(
		'simulated stored count failure',
	)
	expect(await readUserDailyReceiveCount(userId)).toBe(0)
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM email_delivery_events WHERE user_id = ?`,
		)
			.bind(userId)
			.first(),
	).toBeNull()
})

test('account deletion blocks the complete user inbound write boundary', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	const username = `deleting-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `deleting-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	const address = `${username}@${platformDomain}`
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
	})
	await env.APP_DB.prepare(
		`UPDATE users SET deleting_at = ? WHERE stable_user_id = ?`,
	)
		.bind(new Date().toISOString(), userId)
		.run()
	const message = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw: [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Deletion race',
			'Message-ID: <deletion-race@example.net>',
			'',
			'Body',
		].join('\r\n'),
	})

	await expect(
		handleInboundEmail(message, createInboundEnv()),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM email_delivery_events WHERE user_id = ?`,
		)
			.bind(userId)
			.first(),
	).toBeNull()
	expect(
		await env.EMAIL_BLOBS.list({ prefix: `email-raw:v1:${userId}/` }),
	).toMatchObject({ objects: [] })
})

test('insertEmailMessageWithRawMime stores raw MIME in R2 and only raw_mime_key in D1', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `user-${crypto.randomUUID()}`
	await insertWritableEmailTestUser(userId)
	const messageId = crypto.randomUUID()
	const rawMime = 'From: a@example.net\r\nTo: b@example.net\r\n\r\nbody'
	const stored = await insertEmailMessageWithRawMime({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		message: {
			id: messageId,
			direction: 'inbound',
			userId,
			rawMime,
			processingStatus: 'stored',
		},
	})
	expect(stored.rawMimeKey).toBe(emailRawMimeKey(userId, messageId))
	const row = await env.APP_DB.prepare(
		`SELECT raw_mime_key FROM email_messages WHERE id = ?`,
	)
		.bind(messageId)
		.first<{ raw_mime_key: string | null }>()
	expect(row).toEqual({
		raw_mime_key: emailRawMimeKey(userId, messageId),
	})
	expect(await loadRawMime({ blobs: env.EMAIL_BLOBS, message: stored })).toBe(
		rawMime,
	)
})

test('insertEmailMessageWithRawMime best-effort deletes R2 blob when D1 insert fails', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `user-${crypto.randomUUID()}`
	await insertWritableEmailTestUser(userId)
	const messageId = crypto.randomUUID()
	const key = emailRawMimeKey(userId, messageId)
	const deletes: Array<string> = []
	const blobs = new Proxy(env.EMAIL_BLOBS, {
		get(target, property, receiver) {
			if (property === 'delete') {
				return async (objectKey: string) => {
					deletes.push(objectKey)
					return target.delete(objectKey)
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
	const failingDb = new Proxy(env.APP_DB, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (query: string) => {
					const statement = target.prepare(query)
					if (!query.includes('INSERT INTO email_messages')) {
						return statement
					}
					return {
						bind: () => ({
							run: async () => {
								throw new Error('simulated D1 insert failure')
							},
						}),
					}
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	}) as D1Database

	await expect(
		insertEmailMessageWithRawMime({
			db: failingDb,
			blobs,
			message: {
				id: messageId,
				direction: 'inbound',
				userId,
				rawMime: 'orphan-candidate',
				processingStatus: 'stored',
			},
		}),
	).rejects.toThrow('simulated D1 insert failure')

	expect(deletes).toEqual([key])
	expect(await env.EMAIL_BLOBS.get(key)).toBeNull()
	expect(
		await env.APP_DB.prepare(`SELECT id FROM email_messages WHERE id = ?`)
			.bind(messageId)
			.first(),
	).toBeNull()
})

test('stale rejection cannot overwrite finalized delivery usage', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const accountEmail = `reject-race-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username: `reject-race-${crypto.randomUUID().slice(0, 8)}`,
	})
	const now = new Date('2026-07-22T12:00:00.000Z')
	const pending = await buildInboundDelivery({
		userId,
		inboxId: `inbox-${crypto.randomUUID()}`,
		recipient: 'reject-race@example.com',
		rawMime: 'reject race raw mime',
		quotaDay: '2026-07-22',
		now,
	})
	await env.APP_DB.prepare(
		`INSERT INTO email_delivery_events (
			id, user_id, inbox_id, event_type, provider, provider_event_id,
			detail_json, created_at
		) VALUES (?, ?, ?, 'receive_started', 'cloudflare-email-routing', ?, ?, ?)`,
	)
		.bind(
			pending.deliveryId,
			userId,
			pending.inboxId,
			pending.deliveryId,
			JSON.stringify(pending),
			now.toISOString(),
		)
		.run()
	const claim = await claimInboundDeliveryStorage({
		db: env.APP_DB,
		delivery: pending,
		expectedAttachmentCount: 0,
		usageStartedAt: new Date(now.getTime() - 250).toISOString(),
		now,
	})
	if (!claim.claimed || !claim.delivery.storageLease) {
		throw new Error('Expected storage claim.')
	}
	await insertEmailMessage({
		db: env.APP_DB,
		inboundDeliveryFence: {
			deliveryId: pending.deliveryId,
			userId,
			storageLease: claim.delivery.storageLease,
		},
		message: {
			id: pending.messageId,
			direction: 'inbound',
			userId,
			rawSize: 456,
			processingStatus: 'stored',
			receivedAt: now.toISOString(),
		},
	})
	await markInboundDeliveryReceived({
		db: env.APP_DB,
		delivery: claim.delivery,
		usageDurationMs: 250,
		usageMonth: '2026-07',
		usageBytes: 456,
	})
	await processInboundDeliveryEffects({
		env: createInboundEnv(),
		userId,
		deliveryId: pending.deliveryId,
		now,
	})

	expect(
		await markInboundDeliveryRejected({
			db: env.APP_DB,
			delivery: pending,
			reason: 'stale parse rejection',
		}),
	).toBe(false)
	const durable = await env.APP_DB.prepare(
		`SELECT event_type, detail_json FROM email_delivery_events
		WHERE id = ? AND user_id = ?`,
	)
		.bind(pending.deliveryId, userId)
		.first<{ event_type: string; detail_json: string }>()
	expect(durable?.event_type).toBe('received')
	expect(JSON.parse(durable!.detail_json)).toMatchObject({
		state: 'received',
		usageMonth: '2026-07',
		usageBytes: 456,
		usageDurationMs: 250,
		usageEffectRecordedAt: expect.any(String),
	})
})

test('lease takeover fences stale finalization and active storage from cleanup', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `user-${crypto.randomUUID()}`
	const now = new Date('2026-07-22T00:00:00.000Z')
	const delivery = await buildInboundDelivery({
		userId,
		inboxId: `inbox-${crypto.randomUUID()}`,
		recipient: 'lease-race@example.com',
		rawMime: 'lease race raw mime',
		quotaDay: '2026-07-19',
		now: new Date('2026-07-19T00:00:00.000Z'),
	})
	const staleDelivery = {
		...delivery,
		state: 'storing' as const,
		storageLease: 'stale-worker',
		storageLeaseAt: '2026-07-19T00:00:00.000Z',
		expectedAttachmentCount: 0,
		usageStartedAt: '2026-07-19T00:00:00.000Z',
	}
	await env.APP_DB.prepare(
		`INSERT INTO email_delivery_events (
			id, user_id, inbox_id, event_type, provider, provider_event_id,
			detail_json, created_at
		) VALUES (?, ?, ?, 'receive_started', 'cloudflare-email-routing', ?, ?, ?)`,
	)
		.bind(
			delivery.deliveryId,
			userId,
			delivery.inboxId,
			delivery.deliveryId,
			JSON.stringify(staleDelivery),
			'2026-07-19T00:00:00.000Z',
		)
		.run()
	await env.EMAIL_BLOBS.put(delivery.rawMimeKey, 'lease race raw mime')
	const takeover = await claimInboundDeliveryStorage({
		db: env.APP_DB,
		delivery: staleDelivery,
		expectedAttachmentCount: 0,
		usageStartedAt: '2026-07-22T00:00:00.000Z',
		now,
	})
	if (!takeover.claimed) throw new Error('Expected storage lease takeover.')
	expect(takeover.delivery.usageStartedAt).toBe('2026-07-19T00:00:00.000Z')

	await expect(
		insertEmailMessage({
			db: env.APP_DB,
			inboundDeliveryFence: {
				deliveryId: staleDelivery.deliveryId,
				userId,
				storageLease: staleDelivery.storageLease,
			},
			message: {
				id: staleDelivery.messageId,
				direction: 'inbound',
				userId,
				processingStatus: 'stored',
			},
		}),
	).rejects.toThrow('storage lease was lost')
	expect(
		await getEmailMessageById({
			db: env.APP_DB,
			userId,
			messageId: staleDelivery.messageId,
		}),
	).toBeNull()
	await expect(
		markInboundDeliveryReceived({
			db: env.APP_DB,
			delivery: staleDelivery,
			usageDurationMs: 123,
			usageMonth: '2026-07',
			usageBytes: 19,
		}),
	).rejects.toBeInstanceOf(InboundDeliveryLeaseLostError)
	expect(
		await reconcileStaleInboundDeliveries({
			db: env.APP_DB,
			blobs: env.EMAIL_BLOBS,
			userId,
			now,
		}),
	).toEqual({ recovered: 0, cleaned: 0 })
	expect(await env.EMAIL_BLOBS.get(delivery.rawMimeKey)).not.toBeNull()
	const state = await env.APP_DB.prepare(
		`SELECT
			json_extract(detail_json, '$.state') AS state,
			json_extract(detail_json, '$.storageLease') AS storage_lease
		FROM email_delivery_events WHERE id = ? AND user_id = ?`,
	)
		.bind(delivery.deliveryId, userId)
		.first<{ state: string; storage_lease: string }>()
	expect(state).toEqual({
		state: 'storing',
		storage_lease: takeover.delivery.storageLease,
	})
})

test('reconciliation rejects a ledger key outside its user MIME namespace', async () => {
	consoleWarn.mockImplementation(() => {})
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `user-a-${crypto.randomUUID()}`
	const otherUserId = `user-b-${crypto.randomUUID()}`
	const now = new Date('2026-07-22T00:00:00.000Z')
	const delivery = await buildInboundDelivery({
		userId,
		inboxId: `inbox-${crypto.randomUUID()}`,
		recipient: 'isolation@example.com',
		rawMime: 'isolation bytes',
		quotaDay: '2026-07-19',
		now: new Date('2026-07-19T00:00:00.000Z'),
	})
	const otherKey = emailRawMimeKey(otherUserId, delivery.messageId)
	await env.EMAIL_BLOBS.put(otherKey, 'other user MIME')
	await env.APP_DB.prepare(
		`INSERT INTO email_delivery_events (
			id, user_id, inbox_id, event_type, provider, provider_event_id,
			detail_json, created_at
		) VALUES (?, ?, ?, 'receive_started', 'cloudflare-email-routing', ?, ?, ?)`,
	)
		.bind(
			delivery.deliveryId,
			userId,
			delivery.inboxId,
			delivery.deliveryId,
			JSON.stringify({ ...delivery, rawMimeKey: otherKey }),
			'2026-07-19T00:00:00.000Z',
		)
		.run()

	expect(
		await reconcileStaleInboundDeliveries({
			db: env.APP_DB,
			blobs: env.EMAIL_BLOBS,
			userId,
			now,
		}),
	).toEqual({ recovered: 0, cleaned: 0 })
	expect(await env.EMAIL_BLOBS.get(otherKey)).not.toBeNull()

	const validDelivery = await buildInboundDelivery({
		userId,
		inboxId: delivery.inboxId,
		recipient: 'message-key-isolation@example.com',
		rawMime: 'message key isolation bytes',
		quotaDay: '2026-07-19',
		now: new Date('2026-07-19T00:00:00.000Z'),
	})
	const crossUserMessageKey = emailRawMimeKey(
		otherUserId,
		validDelivery.messageId,
	)
	await env.EMAIL_BLOBS.put(crossUserMessageKey, 'other user message MIME')
	await insertEmailMessage({
		db: env.APP_DB,
		message: {
			id: validDelivery.messageId,
			direction: 'inbound',
			userId,
			rawMimeKey: crossUserMessageKey,
			processingStatus: 'stored',
		},
	})
	await env.APP_DB.prepare(
		`INSERT INTO email_delivery_events (
			id, user_id, inbox_id, event_type, provider, provider_event_id,
			detail_json, created_at
		) VALUES (?, ?, ?, 'receive_started', 'cloudflare-email-routing', ?, ?, ?)`,
	)
		.bind(
			validDelivery.deliveryId,
			userId,
			validDelivery.inboxId,
			validDelivery.deliveryId,
			JSON.stringify(validDelivery),
			'2026-07-19T00:00:00.000Z',
		)
		.run()
	expect(
		await reconcileStaleInboundDeliveries({
			db: env.APP_DB,
			blobs: env.EMAIL_BLOBS,
			userId,
			now,
		}),
	).toEqual({ recovered: 0, cleaned: 0 })
	expect(await env.EMAIL_BLOBS.get(crossUserMessageKey)).not.toBeNull()
	expect(consoleWarn).toHaveBeenCalledWith(
		'inbound-email-partial-delivery-recovery-failed',
		validDelivery.deliveryId,
		expect.any(Error),
	)
})

test('stale inbound ledger durably retries orphan blob cleanup after R2 delete failure', async () => {
	consoleWarn.mockImplementation(() => {})
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const accountEmail = `durable-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username: `durable-${crypto.randomUUID().slice(0, 8)}`,
	})
	const delivery = await buildInboundDelivery({
		userId,
		inboxId: `inbox-${crypto.randomUUID()}`,
		recipient: 'durable@example.com',
		rawMime: 'orphaned raw mime',
		quotaDay: '2026-07-19',
	})
	await env.EMAIL_BLOBS.put(delivery.rawMimeKey, 'orphaned raw mime')
	await env.APP_DB.prepare(
		`INSERT INTO email_delivery_events (
			id, user_id, inbox_id, event_type, provider, provider_event_id,
			detail_json, created_at
		) VALUES (?, ?, ?, 'receive_started', 'cloudflare-email-routing', ?, ?, ?)`,
	)
		.bind(
			delivery.deliveryId,
			userId,
			delivery.inboxId,
			delivery.deliveryId,
			JSON.stringify(delivery),
			'2026-07-19T00:00:00.000Z',
		)
		.run()
	const failingBlobs = new Proxy(env.EMAIL_BLOBS, {
		get(target, property, receiver) {
			if (property === 'delete') {
				return async () => {
					throw new Error('simulated compensating delete failure')
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})

	expect(
		await reconcileStaleInboundDeliveries({
			db: env.APP_DB,
			blobs: failingBlobs,
			userId,
			now: new Date('2026-07-22T00:00:00.000Z'),
		}),
	).toEqual({ recovered: 0, cleaned: 0 })
	expect(await env.EMAIL_BLOBS.get(delivery.rawMimeKey)).not.toBeNull()
	expect(consoleWarn).toHaveBeenCalledWith(
		'inbound-email-orphan-blob-delete-failed',
		delivery.rawMimeKey,
		expect.any(Error),
	)
	const writeClosedClaim = await claimInboundDeliveryStorage({
		db: env.APP_DB,
		delivery,
		expectedAttachmentCount: 0,
		now: new Date('2026-07-22T00:10:00.000Z'),
	})
	expect(writeClosedClaim.claimed).toBe(false)

	const successorNow = new Date('2026-07-25T00:00:00.000Z')
	const successor = await buildInboundDelivery({
		userId,
		inboxId: delivery.inboxId,
		recipient: delivery.recipient,
		rawMime: 'successor committed MIME',
		quotaDay: '2026-07-25',
		now: successorNow,
	})
	await env.APP_DB.prepare(
		`INSERT INTO email_delivery_events (
			id, user_id, inbox_id, event_type, provider, provider_event_id,
			detail_json, created_at
		) VALUES (?, ?, ?, 'receive_started', 'cloudflare-email-routing', ?, ?, ?)`,
	)
		.bind(
			successor.deliveryId,
			userId,
			successor.inboxId,
			successor.deliveryId,
			JSON.stringify(successor),
			successorNow.toISOString(),
		)
		.run()
	const successorClaim = await claimInboundDeliveryStorage({
		db: env.APP_DB,
		delivery: successor,
		expectedAttachmentCount: 0,
		usageStartedAt: new Date(successorNow.getTime() - 321).toISOString(),
		now: successorNow,
	})
	if (!successorClaim.claimed) throw new Error('Expected successor lease.')
	await env.EMAIL_BLOBS.put(
		successorClaim.delivery.rawMimeKey,
		'successor committed MIME',
	)
	const successorLease = successorClaim.delivery.storageLease
	if (!successorLease) throw new Error('Expected successor storage lease.')
	await insertEmailMessage({
		db: env.APP_DB,
		inboundDeliveryFence: {
			deliveryId: successor.deliveryId,
			userId,
			storageLease: successorLease,
		},
		message: {
			id: successor.messageId,
			direction: 'inbound',
			userId,
			rawMimeKey: successor.rawMimeKey,
			rawSize: 24,
			processingStatus: 'stored',
		},
	})
	await markInboundDeliveryReceived({
		db: env.APP_DB,
		delivery: successorClaim.delivery,
		usageDurationMs: 321,
		usageMonth: '2026-07',
		usageBytes: 24,
	})
	// Simulate a crash immediately after fenced finalization. Reconciliation
	// receives no request-local duration and must use the persisted winner.
	await processInboundDeliveryEffects({
		env: createInboundEnv(),
		userId,
		deliveryId: successor.deliveryId,
		now: new Date(successorNow.getTime() + 60_000),
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT event_count, total_duration_ms FROM usage_rollups
			WHERE user_id = ? AND metric = 'email_received'`,
		)
			.bind(userId)
			.first<{ event_count: number; total_duration_ms: number }>(),
	).toEqual({ event_count: 1, total_duration_ms: 321 })
	// Cleaner A resumes with the abandoned generation's key after the
	// successor committed. The non-overlapping generation keeps live MIME safe.
	await env.EMAIL_BLOBS.delete(delivery.rawMimeKey)
	expect(await (await env.EMAIL_BLOBS.get(successor.rawMimeKey))?.text()).toBe(
		'successor committed MIME',
	)

	expect(
		await reconcileStaleInboundDeliveries({
			db: env.APP_DB,
			blobs: env.EMAIL_BLOBS,
			userId,
			now: new Date('2026-07-22T00:15:01.000Z'),
		}),
	).toEqual({ recovered: 0, cleaned: 1 })
	expect(await env.EMAIL_BLOBS.get(delivery.rawMimeKey)).toBeNull()
	const row = await env.APP_DB.prepare(
		`SELECT json_extract(detail_json, '$.state') AS state
		FROM email_delivery_events WHERE id = ? AND user_id = ?`,
	)
		.bind(delivery.deliveryId, userId)
		.first<{ state: string }>()
	expect(row).toEqual({ state: 'orphan-cleaned' })
	// A stale worker may resume after the first delete and recreate the old
	// generation's object. The durable tombstone keeps scheduled verification
	// active, so the same orphan key is deleted again without future mail.
	await env.EMAIL_BLOBS.put(delivery.rawMimeKey, 'late stale-worker write')
	expect(
		await reconcileStaleInboundDeliveries({
			db: env.APP_DB,
			blobs: env.EMAIL_BLOBS,
			userId,
			now: new Date('2026-07-22T01:15:02.000Z'),
		}),
	).toEqual({ recovered: 0, cleaned: 1 })
	expect(await env.EMAIL_BLOBS.get(delivery.rawMimeKey)).toBeNull()

	const protectedDelivery = await buildInboundDelivery({
		userId,
		inboxId: delivery.inboxId,
		recipient: 'protected@example.com',
		rawMime: 'committed raw mime',
		quotaDay: '2026-07-19',
	})
	await insertEmailMessageWithRawMime({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		message: {
			id: protectedDelivery.messageId,
			direction: 'inbound',
			userId,
			rawMime: 'committed raw mime',
			processingStatus: 'stored',
		},
	})
	await env.APP_DB.prepare(
		`INSERT INTO email_delivery_events (
			id, user_id, inbox_id, event_type, provider, provider_event_id,
			detail_json, created_at
		) VALUES (?, ?, ?, 'receive_started', 'cloudflare-email-routing', ?, ?, ?)`,
	)
		.bind(
			protectedDelivery.deliveryId,
			userId,
			protectedDelivery.inboxId,
			protectedDelivery.deliveryId,
			JSON.stringify(protectedDelivery),
			'2026-07-19T00:00:00.000Z',
		)
		.run()
	expect(
		await reconcileStaleInboundDeliveries({
			db: env.APP_DB,
			blobs: env.EMAIL_BLOBS,
			userId,
			now: new Date('2026-07-22T00:00:00.000Z'),
		}),
	).toEqual({ recovered: 1, cleaned: 0 })
	expect(await env.EMAIL_BLOBS.get(protectedDelivery.rawMimeKey)).not.toBeNull()
})

test('scheduled sweep cleans quiet-user orphans and recovers partial commits', async () => {
	silenceExpectedConsoleWarns(['inbound-email-user-reconciliation-failed'])
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const oldNow = new Date('2026-07-19T00:00:00.000Z')
	const sweepNow = new Date('2026-07-22T00:00:00.000Z')
	const seedSweepUser = async (prefix: string) => {
		const email = `${prefix}-${crypto.randomUUID()}@example.com`
		const stableUserId = await createStableUserIdFromEmail(email)
		await seedVerifiedAccount({
			db: env.APP_DB,
			email,
			username: `${prefix}-${crypto.randomUUID().slice(0, 8)}`,
		})
		return stableUserId
	}
	const orphanUserId = await seedSweepUser('orphan')
	const orphan = await buildInboundDelivery({
		userId: orphanUserId,
		inboxId: `inbox-${crypto.randomUUID()}`,
		recipient: 'quiet@example.com',
		rawMime: 'quiet orphan',
		quotaDay: '2026-07-19',
		now: oldNow,
	})
	await env.EMAIL_BLOBS.put(orphan.rawMimeKey, 'quiet orphan')
	await env.APP_DB.prepare(
		`INSERT INTO email_delivery_events (
			id, user_id, inbox_id, event_type, provider, provider_event_id,
			detail_json, created_at
		) VALUES (?, ?, ?, 'receive_started', 'cloudflare-email-routing', ?, ?, ?)`,
	)
		.bind(
			orphan.deliveryId,
			orphan.userId,
			orphan.inboxId,
			orphan.deliveryId,
			JSON.stringify(orphan),
			oldNow.toISOString(),
		)
		.run()

	const partialUserId = await seedSweepUser('partial')
	const partialRaw = [
		'From: sender@example.net',
		'To: partial@example.com',
		'Subject: Partial commit',
		'Content-Type: multipart/mixed; boundary="partial-boundary"',
		'',
		'--partial-boundary',
		'Content-Type: text/plain',
		'',
		'Body',
		'--partial-boundary',
		'Content-Type: text/plain; name="note.txt"',
		'Content-Disposition: attachment; filename="note.txt"',
		'',
		'Note',
		'--partial-boundary--',
	].join('\r\n')
	const partial = await buildInboundDelivery({
		userId: partialUserId,
		inboxId: `inbox-${crypto.randomUUID()}`,
		recipient: 'partial@example.com',
		rawMime: partialRaw,
		quotaDay: '2026-07-19',
		now: oldNow,
	})
	await insertEmailMessageWithRawMime({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		message: {
			id: partial.messageId,
			direction: 'inbound',
			userId: partial.userId,
			inboxId: partial.inboxId,
			rawMime: partialRaw,
			rawSize: new TextEncoder().encode(partialRaw).byteLength,
			processingStatus: 'stored',
		},
	})
	await env.APP_DB.prepare(
		`INSERT INTO email_delivery_events (
			id, user_id, inbox_id, event_type, provider, provider_event_id,
			detail_json, created_at
		) VALUES (?, ?, ?, 'receive_started', 'cloudflare-email-routing', ?, ?, ?)`,
	)
		.bind(
			partial.deliveryId,
			partial.userId,
			partial.inboxId,
			partial.deliveryId,
			JSON.stringify(partial),
			oldNow.toISOString(),
		)
		.run()

	const pointerUserId = await seedSweepUser('pointer')
	const expiredPointer = await buildInboundDelivery({
		userId: pointerUserId,
		inboxId: `inbox-${crypto.randomUUID()}`,
		recipient: 'expired-pointer@example.com',
		rawMime: 'expired pointer bytes',
		quotaDay: '2026-07-19',
		now: oldNow,
	})
	await claimInboundDeliveryWindow({
		db: env.APP_DB,
		delivery: expiredPointer,
		now: oldNow,
	})
	const deletingEmail = `sweep-deleting-${crypto.randomUUID()}@example.com`
	const deletingUserId = await createStableUserIdFromEmail(deletingEmail)
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: deletingEmail,
		username: `sweep-deleting-${crypto.randomUUID().slice(0, 8)}`,
	})
	await env.APP_DB.prepare(
		`UPDATE users SET deleting_at = ? WHERE stable_user_id = ?`,
	)
		.bind(sweepNow.toISOString(), deletingUserId)
		.run()
	const deletingDelivery = await buildInboundDelivery({
		userId: deletingUserId,
		inboxId: `inbox-${crypto.randomUUID()}`,
		recipient: 'deleting-sweep@example.com',
		rawMime: 'deleting sweep orphan',
		quotaDay: '2026-07-19',
		now: oldNow,
	})
	await env.EMAIL_BLOBS.put(
		deletingDelivery.rawMimeKey,
		'deleting sweep orphan',
	)
	await env.APP_DB.prepare(
		`INSERT INTO email_delivery_events (
			id, user_id, inbox_id, event_type, provider, provider_event_id,
			detail_json, created_at
		) VALUES (?, ?, ?, 'receive_started', 'cloudflare-email-routing', ?, ?, ?)`,
	)
		.bind(
			deletingDelivery.deliveryId,
			deletingUserId,
			deletingDelivery.inboxId,
			deletingDelivery.deliveryId,
			JSON.stringify(deletingDelivery),
			oldNow.toISOString(),
		)
		.run()

	expect(
		await sweepStaleInboundDeliveries({
			env: createInboundEnv(),
			now: sweepNow,
		}),
	).toMatchObject({
		usersProcessed: 4,
		recovered: 1,
		cleaned: 1,
		pointersPruned: 1,
		effectsProcessed: 1,
		errors: 1,
	})
	expect(await env.EMAIL_BLOBS.get(deletingDelivery.rawMimeKey)).not.toBeNull()
	expect(await env.EMAIL_BLOBS.get(orphan.rawMimeKey)).toBeNull()
	const partialEvent = await env.APP_DB.prepare(
		`SELECT event_type, message_id FROM email_delivery_events
		WHERE id = ? AND user_id = ?`,
	)
		.bind(partial.deliveryId, partial.userId)
		.first<{ event_type: string; message_id: string }>()
	expect(partialEvent).toEqual({
		event_type: 'received',
		message_id: partial.messageId,
	})
	expect(
		await listEmailAttachmentsForMessage({
			db: env.APP_DB,
			messageId: partial.messageId,
		}),
	).toHaveLength(1)
	expect(
		await env.APP_DB.prepare(
			`SELECT event_count FROM usage_rollups
			WHERE user_id = ? AND metric = 'email_received'`,
		)
			.bind(partial.userId)
			.first<{ event_count: number }>(),
	).toEqual({ event_count: 1 })
	const effects = await env.APP_DB.prepare(
		`SELECT
			json_extract(detail_json, '$.usageEffectRecordedAt') AS usage_at,
			json_extract(detail_json, '$.subscriptionEffectState') AS subscription_state,
			needs_effect_reconcile,
			usage_effect_recorded_at
		FROM email_delivery_events WHERE id = ? AND user_id = ?`,
	)
		.bind(partial.deliveryId, partial.userId)
		.first<{
			usage_at: string
			subscription_state: string
			needs_effect_reconcile: number
			usage_effect_recorded_at: string
		}>()
	expect(effects?.usage_at).toEqual(expect.any(String))
	expect(effects?.subscription_state).toBe('complete')
	expect(effects?.needs_effect_reconcile).toBe(0)
	expect(effects?.usage_effect_recorded_at).toBe(effects?.usage_at)
	expect(
		await sweepStaleInboundDeliveries({
			env: createInboundEnv(),
			now: sweepNow,
		}),
	).toMatchObject({
		usersProcessed: 1,
		recovered: 0,
		cleaned: 0,
		errors: 1,
	})
})

test('insertEmailMessageWithAttachments cleans message and blob when attachment insert fails', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `user-${crypto.randomUUID()}`
	await insertWritableEmailTestUser(userId)
	const messageId = crypto.randomUUID()
	const key = emailRawMimeKey(userId, messageId)
	// Lease acquire/release use the first two batches. Fail only the following
	// attachment insert; message cleanup also uses db.batch and must still run.
	let batchCalls = 0
	const failingDb = new Proxy(env.APP_DB, {
		get(target, property, receiver) {
			if (property === 'batch') {
				return async (statements: Parameters<D1Database['batch']>[0]) => {
					batchCalls++
					if (batchCalls === 3) {
						throw new Error('simulated attachment insert failure')
					}
					return target.batch(statements)
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	}) as D1Database

	await expect(
		insertEmailMessageWithAttachments({
			db: failingDb,
			blobs: env.EMAIL_BLOBS,
			message: {
				id: messageId,
				direction: 'inbound',
				userId,
				rawMime: 'attachment-cleanup-bytes',
				processingStatus: 'stored',
			},
			attachments: [
				{
					filename: 'note.txt',
					contentType: 'text/plain',
					contentId: null,
					disposition: 'attachment',
					size: 4,
					storageKind: 'raw-mime',
					storageKey: null,
				},
			],
		}),
	).rejects.toBeInstanceOf(RetryableInboundStorageError)

	expect(
		await getEmailMessageById({
			db: env.APP_DB,
			userId,
			messageId,
		}),
	).toBeNull()
	expect(await env.EMAIL_BLOBS.get(key)).toBeNull()
})

test('attachment cleanup failure with remaining row is acknowledged without retryable throw', async () => {
	silenceExpectedConsoleErrors(['inbound-email-attachment-cleanup-failed'])
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `user-${crypto.randomUUID()}`
	await insertWritableEmailTestUser(userId)
	const messageId = crypto.randomUUID()
	const key = emailRawMimeKey(userId, messageId)
	let batchCalls = 0
	const failingDb = new Proxy(env.APP_DB, {
		get(target, property, receiver) {
			if (property === 'batch') {
				return async (statements: Parameters<D1Database['batch']>[0]) => {
					batchCalls++
					if (batchCalls <= 2) return target.batch(statements)
					throw new Error('simulated attachment and cleanup batch failure')
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	}) as D1Database

	const stored = await insertEmailMessageWithAttachments({
		db: failingDb,
		blobs: env.EMAIL_BLOBS,
		message: {
			id: messageId,
			direction: 'inbound',
			userId,
			rawMime: 'attachment-orphan-bytes',
			processingStatus: 'stored',
		},
		attachments: [
			{
				filename: 'note.txt',
				contentType: 'text/plain',
				contentId: null,
				disposition: 'attachment',
				size: 4,
				storageKind: 'raw-mime',
				storageKey: null,
			},
		],
	})

	expect(stored.id).toBe(messageId)
	expect(
		await getEmailMessageById({
			db: env.APP_DB,
			userId,
			messageId,
		}),
	).not.toBeNull()
	expect(await env.EMAIL_BLOBS.get(key)).not.toBeNull()
	expect(consoleError).toHaveBeenCalledWith(
		'inbound-email-attachment-cleanup-failed',
		messageId,
		expect.anything(),
		expect.anything(),
	)
})

test('ambiguous D1 commit response repairs the stable delivery without duplicate mail', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	const username = `ambiguous-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `ambiguous-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	const address = `${username}@${platformDomain}`
	await seedVerifiedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
	})
	let commitResponseFailed = false
	const failingDb = new Proxy(env.APP_DB, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (query: string) => {
					const statement = target.prepare(query)
					if (!query.includes('INSERT INTO email_messages')) return statement
					return {
						bind(...params: Array<unknown>) {
							const bound = statement.bind(...params)
							return {
								run: async () => {
									const result = await bound.run()
									if (!commitResponseFailed) {
										commitResponseFailed = true
										throw new Error('simulated commit response loss')
									}
									return result
								},
							}
						},
					}
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	}) as D1Database
	const message = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw: [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Ambiguous commit mail',
			'Message-ID: <ambiguous-commit@example.net>',
			'',
			'Body',
		].join('\r\n'),
	})
	const failingEnv = {
		...createInboundEnv(),
		APP_DB: failingDb,
	} as Parameters<typeof handleInboundEmail>[1]

	await handleInboundEmail(message, failingEnv)
	expect(message.rejectedReason).toBeNull()
	expect(await readUserDailyReceiveCount(userId)).toBe(1)
	const retry = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw: [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Ambiguous commit mail',
			'Message-ID: <ambiguous-commit@example.net>',
			'',
			'Body',
		].join('\r\n'),
	})
	await handleInboundEmail(retry, createInboundEnv())
	expect(await readUserDailyReceiveCount(userId)).toBe(1)
	expect(
		await listEmailMessages({
			db: env.APP_DB,
			userId,
			limit: 10,
		}),
	).toHaveLength(1)
	const stored = (
		await listEmailMessages({
			db: env.APP_DB,
			userId,
			limit: 10,
		})
	)[0]!
	expect(await env.EMAIL_BLOBS.get(stored.rawMimeKey!)).not.toBeNull()
	expect(
		await env.APP_DB.prepare(
			`SELECT COUNT(*) AS count FROM email_threads WHERE user_id = ?`,
		)
			.bind(userId)
			.first<{ count: number }>(),
	).toEqual({ count: 1 })
})

test(
	'inbound email handler dispatches package subscriptions for stored inbound email',
	async () => {
		// The subscription runtime warns on optional lookups (usage rollups, MCP
		// server refs) whose tables are not part of this test's schema.
		silenceIncidentalRuntimeWarnings()
		await ensureEmailTestSchema(env.APP_DB)
		const username = `subscriber-${crypto.randomUUID().slice(0, 8)}`
		const accountEmail = `email-subscription-user-${crypto.randomUUID()}@example.com`
		const userId = await createStableUserIdFromEmail(accountEmail)
		const address = `${username}@${platformDomain}`
		const replyFrom = `${username}@${platformDomain}`
		const sourceId = `source-${crypto.randomUUID()}`
		const packageId = `package-${crypto.randomUUID()}`
		const bundleKv = new Map<string, string>()
		const subscriptionCalls: Array<Record<string, unknown>> = []

		const db = env.APP_DB
		await seedVerifiedAccount({
			db,
			email: accountEmail,
			username,
		})
		await db
			.prepare(
				`CREATE TABLE IF NOT EXISTS saved_packages (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				name TEXT NOT NULL,
				kody_id TEXT NOT NULL,
				description TEXT NOT NULL,
				tags_json TEXT NOT NULL DEFAULT '[]',
				search_text TEXT,
				source_id TEXT NOT NULL,
				has_app INTEGER NOT NULL DEFAULT 0,
				hidden INTEGER NOT NULL DEFAULT 0,
				is_private INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
			)
			.run()
		try {
			await db
				.prepare(
					`ALTER TABLE saved_packages ADD COLUMN is_private INTEGER NOT NULL DEFAULT 1`,
				)
				.run()
		} catch {
			// Column already present on newer schemas.
		}
		await db
			.prepare(
				`CREATE TABLE IF NOT EXISTS entity_sources (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				entity_kind TEXT NOT NULL,
				entity_id TEXT NOT NULL,
				repo_id TEXT NOT NULL,
				published_commit TEXT,
				indexed_commit TEXT,
				manifest_path TEXT NOT NULL,
				source_root TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
			)
			.run()
		await db
			.prepare(
				`CREATE TABLE IF NOT EXISTS published_bundle_artifacts (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				source_id TEXT NOT NULL,
				published_commit TEXT NOT NULL,
				artifact_kind TEXT NOT NULL,
				artifact_name TEXT,
				entry_point TEXT NOT NULL,
				kv_key TEXT NOT NULL,
				dependencies_json TEXT NOT NULL DEFAULT '[]',
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`,
			)
			.run()
		await db
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS idx_published_bundle_artifacts_identity
			ON published_bundle_artifacts(user_id, source_id, artifact_kind, COALESCE(artifact_name, ''), entry_point)`,
			)
			.run()

		const now = new Date().toISOString()
		await db
			.prepare(
				`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, tags_json, search_text, source_id, has_app, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				packageId,
				userId,
				'@kentcdodds/package-email-notifier',
				'package-email-notifier',
				'Package email notifier',
				'[]',
				null,
				sourceId,
				0,
				now,
				now,
			)
			.run()
		await db
			.prepare(
				`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit, indexed_commit, manifest_path, source_root, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				sourceId,
				userId,
				'package',
				packageId,
				'repo-1',
				'commit-1',
				null,
				'package.json',
				'/',
				now,
				now,
			)
			.run()

		const manifest = {
			name: '@kentcdodds/package-email-notifier',
			exports: {
				'.': './src/index.ts',
			},
			kody: {
				id: 'package-email-notifier',
				description: 'Package email notifier',
				subscriptions: {
					'email.message.received': {
						handler: './src/email-message-received.ts',
					},
				},
			},
		}
		bundleKv.set(
			buildPublishedSourceManifestSnapshotKvKey({
				sourceId,
				publishedCommit: 'commit-1',
			}),
			JSON.stringify({
				version: 1,
				sourceId,
				publishedCommit: 'commit-1',
				manifestPath: 'package.json',
				manifestContent: JSON.stringify(manifest),
				createdAt: now,
			}),
		)

		const subscriptionArtifact = {
			version: 1,
			kind: 'module',
			artifactName: 'subscription:email.message.received',
			sourceId,
			publishedCommit: 'commit-1',
			entryPoint: 'src/email-message-received.ts',
			mainModule: 'dist/subscription.js',
			modules: {
				'.__kody_virtual__/runtime.js': `
import { AsyncLocalStorage } from 'node:async_hooks';
const __kodyRuntimeStorageSymbol = Symbol.for('kody.runtimeStorage');
const __kodyGlobal = globalThis;
const __kodyRuntimeStorage =
  __kodyGlobal[__kodyRuntimeStorageSymbol] ??
  (__kodyGlobal[__kodyRuntimeStorageSymbol] = new AsyncLocalStorage());
const runtime = __kodyRuntimeStorage.getStore() ?? {};
export const kody = runtime.kody;
export const email = runtime.email ?? null;
`.trim(),
				'dist/subscription.js': `
import { email } from '../.__kody_virtual__/runtime.js'

export default async function main(input = {}) {
  const result = await email.getMessage(input.message.id)
  const firstAttachment = Array.isArray(input.attachments) ? input.attachments[0] : null
  const attachment = firstAttachment?.id
    ? await email.getAttachment(firstAttachment.id)
    : null
  const attachmentText = attachment?.content_base64
    ? atob(attachment.content_base64)
    : null
  const reply = await email.reply({
    message_id: input.message.id,
    text: 'Thanks for the email.',
  })
  return {
    eventType: 'received',
    messageId: result.id,
    textBody: result.text_body,
    attachmentText,
    replyText: 'Thanks for the email.',
    replyMessageId: reply.id,
    replyDirection: reply.direction,
  }
}
`,
			},
			dependencies: [],
			packageContext: {
				packageId,
				kodyId: 'package-email-notifier',
				sourceId,
			},
			serviceContext: null,
			createdAt: now,
		}
		const artifactJson = JSON.stringify(subscriptionArtifact)
		const artifactKey = `bundle-artifact:v1:${sourceId}:commit-1:module:subscription:email.message.received:src/email-message-received.ts`
		bundleKv.set(artifactKey, artifactJson)
		await db
			.prepare(
				`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, artifact_name, entry_point, kv_key, dependencies_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				`artifact-${crypto.randomUUID()}`,
				userId,
				sourceId,
				'commit-1',
				'module',
				'subscription:email.message.received',
				'src/email-message-received.ts',
				artifactKey,
				'[]',
				now,
				now,
			)
			.run()

		const ctx = {
			waitUntil(promise: Promise<unknown>) {
				subscriptionCalls.push({ waitUntil: promise })
			},
			passThroughOnException() {},
		} as ExecutionContext

		const originalKv = env.BUNDLE_ARTIFACTS_KV
		const originalEmailBinding = env.EMAIL
		Object.assign(env, {
			BUNDLE_ARTIFACTS_KV: {
				async get(key: string, type?: string) {
					const value = bundleKv.get(key) ?? null
					if (value == null) return null
					if (type === 'json') {
						return JSON.parse(value) as unknown
					}
					return value
				},
				async put() {
					return undefined
				},
				async delete() {
					return undefined
				},
			},
			EMAIL: {
				async send() {
					return { messageId: `provider-${crypto.randomUUID()}` }
				},
			},
		})

		try {
			const firstMessage = createForwardableEmailMessage({
				from: 'stranger@example.net',
				to: address,
				raw: [
					'From: Stranger <stranger@example.net>',
					`To: ${address}`,
					'Subject: Stored mail',
					'Message-ID: <stored@example.net>',
					'Content-Type: multipart/mixed; boundary="mail-boundary"',
					'',
					'--mail-boundary',
					'Content-Type: text/plain; charset="utf-8"',
					'',
					'Stored body.',
					'--mail-boundary',
					'Content-Type: text/plain; name="note.txt"',
					'Content-Disposition: attachment; filename="note.txt"',
					'',
					'Attachment text',
					'--mail-boundary--',
				].join('\r\n'),
			})
			await handleInboundEmail(firstMessage, createInboundEnv(), ctx)
			expect(firstMessage.rejectedReason).toBeNull()

			const secondMessage = createForwardableEmailMessage({
				from: 'agent@trusted.example',
				to: address,
				raw: [
					'From: Agent <agent@trusted.example>',
					`To: ${address}`,
					'Subject: Approved sender',
					'Message-ID: <approved@trusted.example>',
					'',
					'Approved body.',
				].join('\r\n'),
			})
			await handleInboundEmail(secondMessage, createInboundEnv(), ctx)
			expect(secondMessage.rejectedReason).toBeNull()

			// Drain effects and any nested run-record finishes scheduled via waitUntil.
			for (let index = 0; index < subscriptionCalls.length; index += 1) {
				const entry = subscriptionCalls[index]
				if (entry?.['waitUntil'] instanceof Promise) {
					await entry['waitUntil']
				}
			}

			// The keyed idempotency ledger lives in the owner's RunLog DO now.
			const invocations = (
				await exportRunRecords({ env, userId, pageSize: 100 })
			).packageInvocations.filter((row) => row.packageId === packageId)
			expect(invocations).toHaveLength(2)
			// Anchor each stored response to its message body instead of relying
			// on ledger ordering. Rows without a replay cache (oversized) would
			// simply not match and fail the assertions below.
			const responseBodies = invocations.flatMap((row) =>
				row.responseJson == null
					? []
					: [
							(
								JSON.parse(row.responseJson) as {
									status: number
									body: Record<string, unknown>
								}
							).body,
						],
			)
			const responseForTextBody = (textBody: string) =>
				responseBodies.find(
					(body) =>
						(body['result'] as Record<string, unknown> | undefined)?.[
							'textBody'
						] === textBody,
				)
			const outboundMessages = await listEmailMessages({
				db: env.APP_DB,
				userId,
				direction: 'outbound',
				limit: 10,
			})
			expect(invocations.map((row) => row.exportName)).toEqual([
				'subscription:email.message.received',
				'subscription:email.message.received',
			])
			expect(invocations.map((row) => row.topic)).toEqual([
				'email.message.received',
				'email.message.received',
			])
			expect(invocations.map((row) => row.source)).toEqual(['email', 'email'])
			expect(responseForTextBody('Stored body.\n')).toMatchObject({
				ok: true,
				result: {
					eventType: 'received',
					textBody: 'Stored body.\n',
					attachmentText: 'Attachment text\n',
					replyText: 'Thanks for the email.',
					replyDirection: 'outbound',
				},
			})
			expect(responseForTextBody('Approved body.\n')).toMatchObject({
				ok: true,
				result: {
					eventType: 'received',
					textBody: 'Approved body.\n',
					attachmentText: null,
					replyText: 'Thanks for the email.',
					replyDirection: 'outbound',
				},
			})
			expect(outboundMessages).toHaveLength(2)
			// Replies always go out from the platform-assigned username address.
			expect(outboundMessages.map((message) => message.fromAddress)).toEqual([
				replyFrom,
				replyFrom,
			])
			expect(
				outboundMessages.map((message) => message.processingStatus),
			).toEqual(['sent', 'sent'])
			expect(outboundMessages.map((message) => message.subject).sort()).toEqual(
				['Re: Approved sender', 'Re: Stored mail'],
			)
			expect(
				outboundMessages.map((message) => message.textBody).sort(),
			).toEqual(['Thanks for the email.', 'Thanks for the email.'])
		} finally {
			Object.assign(env, {
				BUNDLE_ARTIFACTS_KV: originalKv,
				EMAIL: originalEmailBinding,
			})
		}
	},
	subscriptionDispatchTimeoutMs,
)
