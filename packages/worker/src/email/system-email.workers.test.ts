import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { handleInboundEmail } from './inbound.ts'
import {
	listEmailInboxesForUser,
	listEmailMessages,
	maxDetailedEmailRejectionEventsPerDay,
} from './repo.ts'
import { RetryableInboundStorageError } from './repo.ts'
import {
	pruneSystemEmailRetention,
	refundSystemEmailDailyReceive,
	systemEmailDayKey,
	systemEmailLimits,
	systemEmailOwnerId,
} from './system-email.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import {
	consoleWarn,
	silenceExpectedConsoleErrors,
} from '#worker/test-support/console-spies.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
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
	const stableUserId = await createStableUserIdFromEmail(input.email)
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(username) DO UPDATE SET
			email = excluded.email,
			email_verified_at = excluded.email_verified_at,
			stable_user_id = COALESCE(users.stable_user_id, excluded.stable_user_id),
			updated_at = CURRENT_TIMESTAMP`,
	)
		.bind(
			input.username,
			input.email,
			'test-password-hash',
			new Date().toISOString(),
			stableUserId,
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

async function readSystemDailyReceiveCount(localPart: string) {
	const row = await env.APP_DB.prepare(
		`SELECT count FROM system_email_daily_counters
			WHERE local_part = ? AND day = ?`,
	)
		.bind(localPart, systemEmailDayKey())
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

test('refundSystemEmailDailyReceive decrements local/day counter and floors at zero', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-07-05T12:00:00.000Z')
	const day = systemEmailDayKey(now)
	const readCount = async (localPart: string) =>
		Number(
			(
				await env.APP_DB.prepare(
					`SELECT count FROM system_email_daily_counters
					WHERE local_part = ? AND day = ?`,
				)
					.bind(localPart, day)
					.first<{ count: number }>()
			)?.count ?? 0,
		)
	await env.APP_DB.prepare(
		`INSERT INTO system_email_daily_counters (local_part, day, count, updated_at)
		VALUES ('abuse', ?, 1, ?), ('support', ?, 2, ?)`,
	)
		.bind(day, now.toISOString(), day, now.toISOString())
		.run()

	await refundSystemEmailDailyReceive({
		db: env.APP_DB,
		localPart: 'abuse',
		now,
	})
	expect(await readCount('abuse')).toBe(0)
	expect(await readCount('support')).toBe(2)

	await refundSystemEmailDailyReceive({
		db: env.APP_DB,
		localPart: 'abuse',
		now,
	})
	expect(await readCount('abuse')).toBe(0)
})

test('system inbox pre-commit R2/D1 failures refund daily receive quota; retry consumes one', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const r2FailingEnv = {
		...createInboundEnv(),
		EMAIL_BLOBS: new Proxy(env.EMAIL_BLOBS, {
			get(target, property, receiver) {
				if (property === 'put') {
					return async () => {
						throw new Error('simulated R2 outage')
					}
				}
				const value = Reflect.get(target, property, receiver)
				return typeof value === 'function' ? value.bind(target) : value
			},
		}),
	} as Parameters<typeof handleInboundEmail>[1]
	const d1FailingEnv = {
		...createInboundEnv(),
		APP_DB: new Proxy(env.APP_DB, {
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
		}) as D1Database,
	} as Parameters<typeof handleInboundEmail>[1]

	for (const failingEnv of [r2FailingEnv, d1FailingEnv]) {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const message = buildInboundMessage({
				to: `abuse@${systemDomain}`,
				messageId: `system-precommit-fail-${attempt}-${crypto.randomUUID().slice(0, 6)}`,
			})
			await expect(
				handleInboundEmail(message, failingEnv),
			).rejects.toBeInstanceOf(RetryableInboundStorageError)
			expect(message.rejectedReason).toBeNull()
			expect(await readSystemDailyReceiveCount('abuse')).toBe(0)
		}
	}

	const retry = buildInboundMessage({
		to: `abuse@${systemDomain}`,
		messageId: 'system-r2-retry-ok',
	})
	await handleInboundEmail(retry, createInboundEnv())
	expect(retry.rejectedReason).toBeNull()
	expect(await readSystemDailyReceiveCount('abuse')).toBe(1)
	expect(
		await listEmailMessages({
			db: env.APP_DB,
			userId: systemEmailOwnerId,
			limit: 10,
		}),
	).toHaveLength(1)
})

test('system inbox post-commit bookkeeping failure keeps one stored row without refund or retry throw', async () => {
	silenceIncidentalRuntimeWarnings()
	silenceExpectedConsoleErrors(['inbound-email-post-commit-bookkeeping-failed'])
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	let messageCommitted = false
	const failingEnv = {
		...createInboundEnv(),
		APP_DB: new Proxy(env.APP_DB, {
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
		}) as D1Database,
	} as Parameters<typeof handleInboundEmail>[1]

	const message = buildInboundMessage({
		to: `support@${systemDomain}`,
		messageId: 'system-post-commit',
	})
	await handleInboundEmail(message, failingEnv)
	expect(message.rejectedReason).toBeNull()
	expect(await readSystemDailyReceiveCount('support')).toBe(1)
	expect(
		await listEmailMessages({
			db: env.APP_DB,
			userId: systemEmailOwnerId,
			limit: 10,
		}),
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
	const oldRawMimeKey = `email-raw:v1:${systemEmailOwnerId}/old-system-message`
	await env.EMAIL_BLOBS.put(oldRawMimeKey, 'old raw mime')
	await env.APP_DB.prepare(
		`INSERT INTO email_messages (
			id, direction, user_id, from_address, subject, processing_status, raw_mime_key, created_at, updated_at
		) VALUES
			('old-system-message', 'inbound', ?, 'old@example.net', 'Old', 'stored', ?, ?, ?),
			('fresh-system-message', 'inbound', ?, 'fresh@example.net', 'Fresh', 'stored', NULL, ?, ?)`,
	)
		.bind(
			systemEmailOwnerId,
			oldRawMimeKey,
			old,
			old,
			systemEmailOwnerId,
			fresh,
			fresh,
		)
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

	const result = await pruneSystemEmailRetention({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		now,
	})

	expect(result.deletedMessages).toBe(1)
	expect(result.deletedCounters).toBe(1)
	expect(result.deletedRawMimeBlobs).toBe(1)
	expect(await env.EMAIL_BLOBS.get(oldRawMimeKey)).toBeNull()
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

test('system email retention deletes blobs before rows and keeps rows when the blob delete fails', async () => {
	silenceIncidentalRuntimeWarnings(['system-email-raw-mime-blob-delete-failed'])
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-07-06T12:00:00.000Z')
	const old = new Date(
		now.getTime() - (systemEmailLimits.retentionDays + 1) * 24 * 60 * 60 * 1000,
	).toISOString()
	const rawMimeKey = `email-raw:v1:${systemEmailOwnerId}/blob-ordering-message`
	await env.EMAIL_BLOBS.put(rawMimeKey, 'raw mime payload')
	await env.APP_DB.prepare(
		`INSERT INTO email_messages (
			id, direction, user_id, from_address, subject, processing_status, raw_mime_key, created_at, updated_at
		) VALUES
			('blob-ordering-message', 'inbound', ?, 'a@example.net', 'Blob', 'stored', ?, ?, ?),
			('plain-old-message', 'inbound', ?, 'b@example.net', 'Plain', 'stored', NULL, ?, ?)`,
	)
		.bind(
			systemEmailOwnerId,
			rawMimeKey,
			old,
			old,
			systemEmailOwnerId,
			old,
			old,
		)
		.run()
	const failingBlobs = new Proxy(env.EMAIL_BLOBS, {
		get(target, property, receiver) {
			if (property === 'delete') {
				return async () => {
					throw new Error('simulated R2 outage')
				}
			}
			return Reflect.get(target, property, receiver)
		},
	})

	const failed = await pruneSystemEmailRetention({
		db: env.APP_DB,
		blobs: failingBlobs,
		now,
	})

	// The simulated outage is warned for operators.
	expect(consoleWarn).toHaveBeenCalledWith(
		'system-email-raw-mime-blob-delete-failed',
		expect.any(Error),
	)
	// Every message attempts the deterministic raw-MIME key, so an R2 outage
	// skips both the stored-key row and the plain residual; the blob remains
	// for retry.
	expect(failed.deletedMessages).toBe(0)
	expect(failed.deletedRawMimeBlobs).toBe(0)
	expect(failed.blobDeleteErrors).toBe(2)
	expect(await env.EMAIL_BLOBS.get(rawMimeKey)).not.toBeNull()
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM email_messages WHERE id = 'blob-ordering-message'`,
		).first(),
	).toMatchObject({ id: 'blob-ordering-message' })
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM email_messages WHERE id = 'plain-old-message'`,
		).first(),
	).toMatchObject({ id: 'plain-old-message' })

	const retried = await pruneSystemEmailRetention({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		now,
	})

	expect(retried.deletedMessages).toBe(2)
	expect(retried.deletedRawMimeBlobs).toBe(1)
	expect(retried.blobDeleteErrors).toBe(0)
	expect(await env.EMAIL_BLOBS.get(rawMimeKey)).toBeNull()
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM email_messages WHERE id = 'blob-ordering-message'`,
		).first(),
	).toBeNull()
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM email_messages WHERE id = 'plain-old-message'`,
		).first(),
	).toBeNull()
})

test('system email retention advances past skipped blob rows at the head of a batch', async () => {
	silenceIncidentalRuntimeWarnings(['system-email-raw-mime-blob-delete-failed'])
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-07-06T12:00:00.000Z')
	const oldMs =
		now.getTime() - (systemEmailLimits.retentionDays + 1) * 24 * 60 * 60 * 1000
	// A full batch of blob-backed rows sits at the head of the newest-first
	// expired ordering; the plain rows behind it are even older.
	const blockedCount = systemEmailLimits.pruneBatchSize
	const plainCount = 5
	const rows: Array<{
		id: string
		rawMimeKey: string | null
		createdAt: string
	}> = []
	for (let index = 0; index < blockedCount; index += 1) {
		rows.push({
			id: `head-blob-${String(index).padStart(3, '0')}`,
			rawMimeKey: `email-raw:v1:${systemEmailOwnerId}/head-blob-${index}`,
			createdAt: new Date(oldMs + index * 1000).toISOString(),
		})
	}
	for (let index = 0; index < plainCount; index += 1) {
		rows.push({
			id: `head-plain-${index}`,
			rawMimeKey: null,
			createdAt: new Date(oldMs - 24 * 60 * 60 * 1000).toISOString(),
		})
	}
	// 5 bindings per row must stay under D1's 100-variable statement limit.
	const insertChunkSize = 18
	for (let start = 0; start < rows.length; start += insertChunkSize) {
		const chunk = rows.slice(start, start + insertChunkSize)
		const values = chunk
			.map(
				() => `(?, 'inbound', ?, 'a@example.net', 'Head', 'stored', ?, ?, ?)`,
			)
			.join(', ')
		const bindings = chunk.flatMap((row) => [
			row.id,
			systemEmailOwnerId,
			row.rawMimeKey,
			row.createdAt,
			row.createdAt,
		])
		await env.APP_DB.prepare(
			`INSERT INTO email_messages (
				id, direction, user_id, from_address, subject, processing_status, raw_mime_key, created_at, updated_at
			) VALUES ${values}`,
		)
			.bind(...bindings)
			.run()
	}

	// Every message attempts the deterministic raw-MIME key, so an R2 outage
	// skips every selected batch while the keyset cursor still advances.
	const failingBlobs = new Proxy(env.EMAIL_BLOBS, {
		get(target, property, receiver) {
			if (property === 'delete') {
				return async () => {
					throw new Error('simulated R2 outage')
				}
			}
			return Reflect.get(target, property, receiver)
		},
	})
	const result = await pruneSystemEmailRetention({
		db: env.APP_DB,
		blobs: failingBlobs,
		now,
	})

	expect(result.blobDeleteErrors).toBe(blockedCount + plainCount)
	expect(result.deletedMessages).toBe(0)
	// The simulated outage is warned for operators.
	expect(consoleWarn).toHaveBeenCalledWith(
		'system-email-raw-mime-blob-delete-failed',
		expect.any(Error),
	)
	const remainingPlain = await env.APP_DB.prepare(
		`SELECT COUNT(*) AS count FROM email_messages WHERE id LIKE 'head-plain-%'`,
	).first<{ count: number }>()
	expect(Number(remainingPlain?.count ?? -1)).toBe(plainCount)
	const remainingBlob = await env.APP_DB.prepare(
		`SELECT COUNT(*) AS count FROM email_messages WHERE id LIKE 'head-blob-%'`,
	).first<{ count: number }>()
	expect(Number(remainingBlob?.count ?? -1)).toBe(blockedCount)

	// Clean up the skipped rows with a working binding (deleting absent R2
	// keys is a no-op) so they do not leak into other tests.
	const cleanup = await pruneSystemEmailRetention({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		now,
	})
	expect(cleanup.deletedMessages).toBe(blockedCount + plainCount)
})

test('system email retention drains delivery-event backlogs larger than one batch', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-07-06T12:00:00.000Z')
	const old = new Date(
		now.getTime() - (systemEmailLimits.retentionDays + 1) * 24 * 60 * 60 * 1000,
	).toISOString()
	const backlog = systemEmailLimits.pruneBatchSize + 5
	// 3 bindings per row must stay under D1's 100-variable statement limit.
	const insertChunkSize = 30
	for (let start = 0; start < backlog; start += insertChunkSize) {
		const count = Math.min(insertChunkSize, backlog - start)
		const values = Array.from({ length: count })
			.map(() => `(?, NULL, ?, NULL, 'received', 'test', '{}', ?)`)
			.join(', ')
		const bindings = Array.from({ length: count }).flatMap((_, index) => [
			`backlog-event-${start + index}`,
			systemEmailOwnerId,
			old,
		])
		await env.APP_DB.prepare(
			`INSERT INTO email_delivery_events (
				id, message_id, user_id, inbox_id, event_type, provider, detail_json, created_at
			) VALUES ${values}`,
		)
			.bind(...bindings)
			.run()
	}

	const result = await pruneSystemEmailRetention({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		now,
	})

	expect(result.deletedDeliveryEvents).toBeGreaterThanOrEqual(backlog)
	const remaining = await env.APP_DB.prepare(
		`SELECT COUNT(*) AS count FROM email_delivery_events
		WHERE user_id = ? AND id LIKE 'backlog-event-%'`,
	)
		.bind(systemEmailOwnerId)
		.first<{ count: number }>()
	expect(Number(remaining?.count ?? -1)).toBe(0)
})
