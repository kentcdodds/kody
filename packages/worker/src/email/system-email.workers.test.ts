import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { handleInboundEmail } from './inbound.ts'
import {
	listEmailInboxesForUser,
	listEmailMessages,
	maxDetailedEmailRejectionEventsPerDay,
} from './repo.ts'
import {
	pruneSystemEmailRetention,
	systemEmailLimits,
	systemEmailOwnerId,
} from './system-email.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

const platformBaseUrl = 'https://kody.example.com'
// System inboxes live on the apex; user mail lives on the inbox. subdomain.
const systemDomain = 'kody.example.com'
const userDomain = 'inbox.kody.example.com'

function createInboundEnv() {
	return { ...env, APP_BASE_URL: platformBaseUrl }
}

function buildInboundMessage(input: {
	to: string
	subject?: string
	messageId?: string
}) {
	return createForwardableEmailMessage({
		from: 'sender@example.net',
		to: input.to,
		raw: [
			'From: Sender <sender@example.net>',
			`To: ${input.to}`,
			`Subject: ${input.subject ?? 'System mail'}`,
			`Message-ID: <${input.messageId ?? crypto.randomUUID()}@example.net>`,
			'',
			'System body.',
		].join('\r\n'),
	})
}

async function seedVerifiedAccount(input: { email: string; username: string }) {
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(username) DO UPDATE SET
			email = excluded.email,
			email_verified_at = excluded.email_verified_at,
			updated_at = CURRENT_TIMESTAMP`,
	)
		.bind(
			input.username,
			input.email,
			'test-password-hash',
			new Date().toISOString(),
		)
		.run()
}

async function readRejectionEvents() {
	const { results } = await env.APP_DB.prepare(
		`SELECT id, detail_json FROM email_delivery_events
		WHERE user_id = ? AND event_type = 'rejected'
		ORDER BY created_at ASC, id ASC`,
	)
		.bind(systemEmailOwnerId)
		.all<{ id: string; detail_json: string }>()
	const rows = (results ?? []).map((row) => ({
		id: row.id,
		detail: JSON.parse(row.detail_json) as Record<string, unknown>,
	}))
	return {
		detailed: rows.filter((row) => row.detail['aggregate'] !== true),
		aggregate: rows.find((row) => row.detail['aggregate'] === true) ?? null,
	}
}

test('reserved system locals store under the operator-owned system inbox', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const legacyEmail = `legacy-kody-${crypto.randomUUID()}@example.com`
	const legacyUserId = await createStableUserIdFromEmail(legacyEmail)
	await seedVerifiedAccount({ email: legacyEmail, username: 'kody' })

	const message = buildInboundMessage({
		to: `kody@${systemDomain}`,
		subject: 'Cloudflare confirmation',
	})
	await handleInboundEmail(message, createInboundEnv())

	expect(message.rejectedReason).toBeNull()
	expect(
		await listEmailMessages({
			db: env.APP_DB,
			userId: legacyUserId,
			limit: 10,
		}),
	).toEqual([])
	const messages = await listEmailMessages({
		db: env.APP_DB,
		userId: systemEmailOwnerId,
		limit: 10,
	})
	expect(messages).toHaveLength(1)
	expect(messages[0]).toMatchObject({
		subject: 'Cloudflare confirmation',
		fromAddress: 'sender@example.net',
		processingStatus: 'stored',
	})
	const inboxes = await listEmailInboxesForUser({
		db: env.APP_DB,
		userId: systemEmailOwnerId,
	})
	expect(inboxes.map((inbox) => inbox.name)).toEqual(['kody'])
	const rollup = await env.APP_DB.prepare(
		`SELECT event_count, error_count FROM usage_rollups
		WHERE user_id = ? AND metric = 'email_received'`,
	)
		.bind(systemEmailOwnerId)
		.first<{ event_count: number; error_count: number }>()
	expect(rollup).toMatchObject({ event_count: 1, error_count: 0 })

	// Subaddressed system mail (support+tag@apex) routes to the same
	// operator inbox for the base local part.
	const tagged = buildInboundMessage({
		to: `support+ticket-123@${systemDomain}`,
		subject: 'Tagged system mail',
	})
	await handleInboundEmail(tagged, createInboundEnv())
	expect(tagged.rejectedReason).toBeNull()
	const taggedMessages = await listEmailMessages({
		db: env.APP_DB,
		userId: systemEmailOwnerId,
		limit: 10,
	})
	expect(taggedMessages[0]).toMatchObject({
		subject: 'Tagged system mail',
		toAddresses: [`support+ticket-123@${systemDomain}`],
	})
	expect(
		(
			await listEmailInboxesForUser({
				db: env.APP_DB,
				userId: systemEmailOwnerId,
			})
		)
			.map((inbox) => inbox.name)
			.sort(),
	).toEqual(['kody', 'support'])
})

test('non-system reserved locals still reject while username addresses are unaffected', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const username = `normal-${crypto.randomUUID().slice(0, 8)}`
	const email = `normal-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedVerifiedAccount({ email, username })

	const reservedMessage = buildInboundMessage({
		to: `help@${userDomain}`,
	})
	await handleInboundEmail(reservedMessage, createInboundEnv())
	expect(reservedMessage.rejectedReason).toBe(
		'This address is reserved for system mail.',
	)

	// System locals only route on the apex: on the user subdomain they stay
	// reserved, and non-system locals on the apex are not addresses at all.
	const subdomainSystemLocal = buildInboundMessage({
		to: `kody@${userDomain}`,
	})
	await handleInboundEmail(subdomainSystemLocal, createInboundEnv())
	expect(subdomainSystemLocal.rejectedReason).toBe(
		'This address is reserved for system mail.',
	)
	const apexNonSystemLocal = buildInboundMessage({
		to: `${username}@${systemDomain}`,
	})
	await handleInboundEmail(apexNonSystemLocal, createInboundEnv())
	expect(apexNonSystemLocal.rejectedReason).toBe('Unknown Kody email address.')

	const userMessage = buildInboundMessage({
		to: `${username}@${userDomain}`,
		subject: 'User inbox still works',
	})
	await handleInboundEmail(userMessage, createInboundEnv())
	expect(userMessage.rejectedReason).toBeNull()
	expect(
		await listEmailMessages({ db: env.APP_DB, userId, limit: 10 }),
	).toHaveLength(1)
})

test('system email size and daily caps reject before storage with bounded events', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)

	const oversize = buildInboundMessage({ to: `abuse@${systemDomain}` })
	Object.defineProperty(oversize, 'rawSize', {
		value: systemEmailLimits.maxMessageBytes + 1,
	})
	await handleInboundEmail(oversize, createInboundEnv())
	expect(oversize.rejectedReason).toBe('Recipient mailbox is over quota.')
	expect(
		await env.APP_DB.prepare(
			`SELECT count FROM system_email_daily_counters WHERE local_part = 'abuse'`,
		).first(),
	).toBeNull()
	await env.APP_DB.prepare(
		`DELETE FROM email_delivery_events WHERE user_id = ?`,
	)
		.bind(systemEmailOwnerId)
		.run()

	await env.APP_DB.prepare(
		`INSERT INTO system_email_daily_counters (local_part, day, count, updated_at)
		VALUES ('support', ?, ?, ?)`,
	)
		.bind(
			new Date().toISOString().slice(0, 10),
			systemEmailLimits.maxReceivesPerDay,
			new Date().toISOString(),
		)
		.run()
	const attempts = maxDetailedEmailRejectionEventsPerDay + 2
	for (let index = 0; index < attempts; index += 1) {
		const capped = buildInboundMessage({
			to: `support@${systemDomain}`,
			messageId: `system-cap-${index}`,
		})
		await handleInboundEmail(capped, createInboundEnv())
		expect(capped.rejectedReason).toBe('Recipient mailbox is over quota.')
	}
	expect(
		await listEmailMessages({
			db: env.APP_DB,
			userId: systemEmailOwnerId,
			limit: 10,
		}),
	).toEqual([])
	const rejections = await readRejectionEvents()
	expect(rejections.detailed).toHaveLength(
		maxDetailedEmailRejectionEventsPerDay,
	)
	expect(rejections.aggregate?.detail).toMatchObject({
		aggregate: true,
		count: attempts,
		last_phase: 'system-limit',
	})
})

test('system email retention prunes old operator-owned messages and counters', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-07-06T12:00:00.000Z')
	const old = new Date(
		now.getTime() - (systemEmailLimits.retentionDays + 1) * 24 * 60 * 60 * 1000,
	).toISOString()
	const fresh = now.toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO email_messages (
			id, direction, user_id, from_address, subject, processing_status, created_at, updated_at
		) VALUES
			('old-system-message', 'inbound', ?, 'old@example.net', 'Old', 'stored', ?, ?),
			('fresh-system-message', 'inbound', ?, 'fresh@example.net', 'Fresh', 'stored', ?, ?)`,
	)
		.bind(systemEmailOwnerId, old, old, systemEmailOwnerId, fresh, fresh)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO email_attachments (
			id, message_id, filename, content_type, size, storage_kind, created_at
		) VALUES ('old-attachment', 'old-system-message', 'old.txt', 'text/plain', 1, 'raw-mime', ?)`,
	)
		.bind(old)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO email_delivery_events (
			id, message_id, user_id, inbox_id, event_type, provider, detail_json, created_at
		) VALUES
			('old-event', 'old-system-message', ?, NULL, 'received', 'test', '{}', ?),
			('fresh-event', 'fresh-system-message', ?, NULL, 'received', 'test', '{}', ?)`,
	)
		.bind(systemEmailOwnerId, old, systemEmailOwnerId, fresh)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO system_email_daily_counters (local_part, day, count, updated_at)
		VALUES ('admin', '2026-01-01', 1, ?)`,
	)
		.bind(old)
		.run()

	const result = await pruneSystemEmailRetention({ db: env.APP_DB, now })

	expect(result.deletedMessages).toBe(1)
	expect(result.deletedCounters).toBe(1)
	expect(
		await listEmailMessages({
			db: env.APP_DB,
			userId: systemEmailOwnerId,
			limit: 10,
		}),
	).toEqual([
		expect.objectContaining({
			id: 'fresh-system-message',
			subject: 'Fresh',
		}),
	])
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM email_attachments WHERE id = 'old-attachment'`,
		).first(),
	).toBeNull()
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM email_delivery_events ORDER BY id ASC`,
		).all(),
	).toMatchObject({ results: [{ id: 'fresh-event' }] })
})
