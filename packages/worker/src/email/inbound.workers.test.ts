import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { handleInboundEmail } from './inbound.ts'
import { defaultEmailInboxName } from './default-inbox.ts'
import {
	createEmailThread,
	insertEmailMessageWithAttachments,
	getEmailAttachmentById,
	listEmailInboxesForUser,
	listEmailInboxAddressesForUser,
	listEmailMessages,
	listEmailAttachmentsForMessage,
} from './repo.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { buildPublishedSourceManifestSnapshotKvKey } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

const platformBaseUrl = 'https://kody.example.com'
const platformDomain = 'kody.example.com'

function createInboundEnv() {
	return { ...env, APP_BASE_URL: platformBaseUrl }
}

async function seedAccount(input: {
	db: D1Database
	email: string
	username: string
	emailVerifiedAt?: string | null
}) {
	await input.db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(email) DO UPDATE SET
			   username = excluded.username,
			   email_verified_at = excluded.email_verified_at,
			   updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(
			input.username,
			input.email,
			'test-password-hash',
			input.emailVerifiedAt === undefined
				? new Date().toISOString()
				: input.emailVerifiedAt,
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

test('inbound email routes {username}@platform-domain and auto-provisions the default inbox', async () => {
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
})

test('inbound email rejects unknown usernames, reserved locals, and foreign domains', async () => {
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
	// Mail for other domains is never a Kody user inbox.
	await expectRejected({
		to: 'someone@other.example.com',
		reason: 'Unknown Kody email address.',
	})

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
	// email_message_bytes gate (the NULL-plan fallback is 512 KiB) with the
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

	// A raw stream that fails mid-read exercises the parse-failure path.
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

	await handleInboundEmail(unreadableMessage, createInboundEnv())

	expect(unreadableMessage.rejectedReason).toMatch(/raw stream read failed/)
	const rejectedMessages = await listEmailMessages({
		db: env.APP_DB,
		userId,
		limit: 10,
	})
	expect(rejectedMessages).toEqual([])
})

test('inbound email reclaims a platform address left behind by a username change', async () => {
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

test('getEmailAttachmentById reconstructs unnamed attachments from raw MIME', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `email-attachment-user-${crypto.randomUUID()}`
	const stored = await insertEmailMessageWithAttachments({
		db: env.APP_DB,
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

test('inbound email handler dispatches package subscriptions for stored inbound email', async () => {
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
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
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
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS package_invocations (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				token_id TEXT NOT NULL,
				package_id TEXT NOT NULL,
				package_kody_id TEXT NOT NULL,
				export_name TEXT NOT NULL,
				idempotency_key TEXT NOT NULL,
				request_hash TEXT NOT NULL,
				source TEXT,
				topic TEXT,
				status TEXT NOT NULL,
				response_json TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_package_invocations_key
			ON package_invocations(user_id, token_id, package_id, export_name, idempotency_key)`,
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

		for (const entry of subscriptionCalls) {
			if (entry['waitUntil'] instanceof Promise) {
				await entry['waitUntil']
			}
		}

		const invocations = await db
			.prepare(
				`SELECT export_name, topic, source, response_json
				FROM package_invocations
				WHERE package_id = ?
				ORDER BY created_at ASC, id ASC`,
			)
			.bind(packageId)
			.all<Record<string, unknown>>()
		expect(invocations.results).toHaveLength(2)
		const responses = (invocations.results ?? []).map((row) =>
			JSON.parse(String(row['response_json'])),
		) as Array<{ status: number; body: Record<string, unknown> }>
		const outboundMessages = await listEmailMessages({
			db: env.APP_DB,
			userId,
			direction: 'outbound',
			limit: 10,
		})
		expect(invocations.results?.map((row) => row['export_name'])).toEqual([
			'subscription:email.message.received',
			'subscription:email.message.received',
		])
		expect(invocations.results?.map((row) => row['topic'])).toEqual([
			'email.message.received',
			'email.message.received',
		])
		expect(invocations.results?.map((row) => row['source'])).toEqual([
			'email',
			'email',
		])
		expect(responses[0]?.body).toMatchObject({
			ok: true,
			result: {
				eventType: 'received',
				textBody: 'Stored body.\n',
				attachmentText: 'Attachment text\n',
				replyText: 'Thanks for the email.',
				replyDirection: 'outbound',
			},
		})
		expect(responses[1]?.body).toMatchObject({
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
		expect(outboundMessages.map((message) => message.processingStatus)).toEqual(
			['sent', 'sent'],
		)
		expect(outboundMessages.map((message) => message.subject).sort()).toEqual([
			'Re: Approved sender',
			'Re: Stored mail',
		])
		expect(outboundMessages.map((message) => message.textBody).sort()).toEqual([
			'Thanks for the email.',
			'Thanks for the email.',
		])
	} finally {
		Object.assign(env, {
			BUNDLE_ARTIFACTS_KV: originalKv,
			EMAIL: originalEmailBinding,
		})
	}
})
