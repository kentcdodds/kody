import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { emailAttachmentBlobKey, emailRawMimeKey } from './blob-keys.ts'
import {
	computeMailboxRetentionReschedule,
	Mailbox,
	mailboxDeliveryEventRetentionDays,
	mailboxMessageRetentionDays,
	mailboxRetentionContinuationDelayMs,
	mailboxRetentionRetryDelayMs,
	selectMailboxRetentionWriteAlarm,
} from './mailbox-do.ts'
import {
	deleteMailboxRetentionCandidate,
	enforceMailboxRetention,
	selectMailboxRetentionCandidate,
	type MailboxRetentionMessageDeleteResult,
} from './mailbox-retention.ts'
import { MailboxStore } from './mailbox-store.ts'
import { mailboxRetentionAlarmSkewMs } from './mailbox-types.ts'
import {
	assertMailboxThrows,
	baseAttachment,
	baseDeliveryEvent,
	baseMessage,
	baseThread,
	rpcFor,
	stubFor,
	uniqueUserId,
} from './mailbox-test-helpers.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const daysAgo = (days: number) =>
	new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
const expiredMessageAt = () => daysAgo(mailboxMessageRetentionDays + 3)

function interceptBlobDeletes(
	intercept: (keys: Array<string>) => Promise<void> | void,
) {
	const originalDelete = env.EMAIL_BLOBS.delete.bind(env.EMAIL_BLOBS)
	env.EMAIL_BLOBS.delete = (async (keys: string | Array<string>) => {
		await intercept(Array.isArray(keys) ? keys : [keys])
		return await originalDelete(keys)
	}) as typeof env.EMAIL_BLOBS.delete
	return {
		[Symbol.dispose]: () => {
			env.EMAIL_BLOBS.delete = originalDelete
		},
	}
}

function failDeletesOf(key: string, deletedKeys: Array<string> = []) {
	return interceptBlobDeletes((keys) => {
		deletedKeys.push(...keys)
		if (keys.includes(key)) throw new Error('simulated R2 delete failure')
	})
}

async function runAlarm(userId: string) {
	return await runInDurableObject(
		stubFor(ownerIdFromStored(userId)),
		async (instance: Mailbox, state) => {
			await instance.alarm()
			return await state.storage.getAlarm()
		},
	)
}

async function querySql<Row extends Record<string, SqlStorageValue>>(
	userId: string,
	sql: string,
	...bindings: Array<SqlStorageValue>
) {
	return await runInDurableObject(
		stubFor(ownerIdFromStored(userId)),
		async (_instance: Mailbox, state) =>
			state.storage.sql.exec<Row>(sql, ...bindings).toArray(),
	)
}

async function tombstonedIds(userId: string) {
	const rows = await querySql<{ message_id: string }>(
		userId,
		`SELECT message_id FROM email_message_deletion_tombstones ORDER BY message_id`,
	)
	return rows.map((row) => row.message_id)
}

async function retryCount(userId: string) {
	const [row] = await querySql<{ count: number }>(
		userId,
		`SELECT COUNT(*) AS count FROM email_message_retention_retries`,
	)
	return Number(row?.count)
}

async function makeRetryDue(userId: string, messageId: string) {
	await querySql(
		userId,
		`UPDATE email_message_retention_retries SET retry_at = ? WHERE message_id = ?`,
		new Date(Date.now() - 1_000).toISOString(),
		messageId,
	)
}

function expectContinuationAlarm(alarm: number | null, turnAt: number) {
	expect(alarm).toBeGreaterThanOrEqual(
		turnAt + mailboxRetentionContinuationDelayMs - 500,
	)
	expect(alarm).toBeLessThanOrEqual(
		turnAt + mailboxRetentionContinuationDelayMs + 5_000,
	)
}

test('mailbox retention helpers prefer backoff/continue and never postpone earlier alarms', () => {
	const nowMs = 1_700_000_000_000
	const retryAt = nowMs + mailboxRetentionRetryDelayMs
	const continueAt = nowMs + mailboxRetentionContinuationDelayMs
	// [eligibleExpiredWorkRemaining, earliestRetryAtMs, nextDueAtMs, expected]
	const reschedules: Array<
		[boolean, number | null, number | null, { kind: string; atMs: unknown }]
	> = [
		[true, retryAt, nowMs + 10_000, { kind: 'continue', atMs: continueAt }],
		[true, nowMs + 500, nowMs + 60_000, { kind: 'backoff', atMs: nowMs + 500 }],
		[
			false,
			retryAt,
			nowMs + 60_000,
			{ kind: 'next-due', atMs: nowMs + 60_000 },
		],
		[false, retryAt, null, { kind: 'backoff', atMs: retryAt }],
		[false, null, null, { kind: 'idle', atMs: null }],
	]
	expect(
		reschedules.map(([eligible, earliestRetryAtMs, nextDueAtMs]) =>
			computeMailboxRetentionReschedule({
				nowMs,
				eligibleExpiredWorkRemaining: eligible,
				earliestRetryAtMs,
				nextDueAtMs,
			}),
		),
	).toEqual(reschedules.map((row) => row[3]))

	const earlier = 1_700_000_100_000
	const later = earlier + 60_000
	const withinSkew = earlier + Math.floor(mailboxRetentionAlarmSkewMs / 2)
	// [proposedAtMs, existingAtMs, expected]
	const writeAlarms: Array<[number | null, number | null, unknown]> = [
		[later, earlier, { action: 'keep-existing' }],
		[earlier, later, { action: 'set', atMs: earlier }],
		[withinSkew, earlier, { action: 'keep-existing' }],
		[earlier, null, { action: 'set', atMs: earlier }],
		[null, earlier, { action: 'idle' }],
	]
	expect(
		writeAlarms.map(([proposedAtMs, existingAtMs]) =>
			selectMailboxRetentionWriteAlarm({ proposedAtMs, existingAtMs }),
		),
	).toEqual(writeAlarms.map((row) => row[2]))
})

test('Mailbox retention deletes canonical R2 keys before metadata and backs off on failure', async () => {
	silenceIncidentalRuntimeWarnings([
		'mailbox-retention-blob-delete-failed',
		'mailbox-inbound-due-owner-hint-repair-failed',
		'mailbox-provider-index-repair-health-sync-failed',
	])
	const userId = uniqueUserId('retention')
	const mailbox = rpcFor(userId)
	const oldMessageAt = expiredMessageAt()
	const oldEventAt = daysAgo(mailboxDeliveryEventRetentionDays + 3)
	const freshAt = new Date().toISOString()

	const keepMessage = baseMessage(userId, {
		id: 'keep-msg',
		createdAt: freshAt,
	})
	const dropMessage = baseMessage(userId, {
		id: 'drop-msg',
		threadId: 'drop-thread',
		createdAt: oldMessageAt,
	})
	const failMessage = baseMessage(userId, {
		id: 'fail-msg',
		createdAt: oldMessageAt,
	})
	const missingKeyMessage = baseMessage(userId, {
		id: 'missing-key-msg',
		createdAt: oldMessageAt,
	})
	const dropAttachment = baseAttachment(userId, dropMessage.id, {
		id: 'drop-att',
		createdAt: oldMessageAt,
	})

	await mailbox.upsertMessageGraph({
		ownerId: userId,
		thread: baseThread({ id: 'drop-thread', lastMessageAt: oldMessageAt }),
		message: dropMessage,
		attachments: [dropAttachment],
	})
	for (const message of [keepMessage, failMessage, missingKeyMessage]) {
		await mailbox.upsertMessageGraph({ ownerId: userId, message })
	}
	for (const [id, createdAt] of [
		['old-event', oldEventAt],
		['fresh-event', freshAt],
	] as const) {
		await mailbox.upsertDeliveryEvent({
			ownerId: userId,
			event: baseDeliveryEvent({ id, messageId: keepMessage.id, createdAt }),
		})
	}

	const dropRawKey = emailRawMimeKey(userId, dropMessage.id)
	const dropAttKey = emailAttachmentBlobKey(
		userId,
		dropMessage.id,
		dropAttachment.id,
	)
	const failRawKey = emailRawMimeKey(userId, failMessage.id)
	const keepRawKey = emailRawMimeKey(userId, keepMessage.id)
	const missingRawKey = emailRawMimeKey(userId, missingKeyMessage.id)
	for (const key of [
		dropRawKey,
		dropAttKey,
		failRawKey,
		keepRawKey,
		missingRawKey,
	]) {
		await env.EMAIL_BLOBS.put(key, key)
	}

	// Stored key missing must not prevent deleting the canonical inbound key.
	await querySql(
		userId,
		`UPDATE email_messages SET raw_mime_key = NULL WHERE id = ?`,
		missingKeyMessage.id,
	)

	{
		using _deletes = failDeletesOf(failRawKey)
		const firstTurnAt = Date.now()
		const alarmAfterFirstTurn = await runInDurableObject(
			stubFor(userId),
			async (instance: Mailbox, state) => {
				expect(instance).toBeInstanceOf(Mailbox)
				await state.storage.deleteAlarm()
				await instance.alarm()
				return await state.storage.getAlarm()
			},
		)
		// One R2-backed message per DO event. Remaining expired messages re-arm
		// a near-immediate continuation instead of extending this alarm turn.
		expectContinuationAlarm(alarmAfterFirstTurn, firstTurnAt)
		expect(await env.EMAIL_BLOBS.get(dropRawKey)).toBeNull()
		expect(await env.EMAIL_BLOBS.get(dropAttKey)).toBeNull()
		expect(await env.EMAIL_BLOBS.get(failRawKey)).not.toBeNull()
		expect(await env.EMAIL_BLOBS.get(missingRawKey)).not.toBeNull()
		expect(await mailbox.getMessage({ messageId: dropMessage.id })).toBeNull()
		expect(
			await mailbox.getMessage({ messageId: missingKeyMessage.id }),
		).toMatchObject({ id: missingKeyMessage.id })

		const failureTurnAt = Date.now()
		// The failed oldest message is durably deferred, but the next eligible
		// expired message keeps the alarm on near-immediate continuation.
		expectContinuationAlarm(await runAlarm(userId), failureTurnAt)
		expect(await env.EMAIL_BLOBS.get(failRawKey)).not.toBeNull()
		expect(await env.EMAIL_BLOBS.get(missingRawKey)).not.toBeNull()
		expect(await env.EMAIL_BLOBS.get(keepRawKey)).not.toBeNull()
		expect(
			await mailbox.listAttachmentsForMessage({ messageId: dropMessage.id }),
		).toHaveLength(0)
		expect(await mailbox.getThread({ threadId: 'drop-thread' })).toBeNull()
		for (const message of [failMessage, keepMessage]) {
			expect(await mailbox.getMessage({ messageId: message.id })).toMatchObject(
				{ id: message.id },
			)
		}
		const [retry] = await querySql<{
			retry_at: string
			attempt_count: number
			last_error: string
		}>(
			userId,
			`SELECT retry_at, attempt_count, last_error
			FROM email_message_retention_retries WHERE message_id = ?`,
			failMessage.id,
		)
		expect(Date.parse(retry!.retry_at)).toBeGreaterThanOrEqual(
			failureTurnAt + mailboxRetentionRetryDelayMs - 5_000,
		)
		expect(retry).toMatchObject({
			attempt_count: 1,
			last_error: expect.stringContaining('simulated R2 delete failure'),
		})
		const events = await mailbox.listDeliveryEvents({ limit: 10 })
		expect(events.map((event) => event.id)).toEqual(['fresh-event'])
		expect(await tombstonedIds(userId)).toEqual(['drop-msg'])

		const alarmAfterNextEligible = await runAlarm(userId)
		expect(await env.EMAIL_BLOBS.get(missingRawKey)).toBeNull()
		expect(
			await mailbox.getMessage({ messageId: missingKeyMessage.id }),
		).toBeNull()
		expect(alarmAfterNextEligible).toBe(Date.parse(retry!.retry_at))
	}

	// Make the durable retry due, then the next turn retries and succeeds.
	await makeRetryDue(userId, failMessage.id)
	await runAlarm(userId)
	expect(await env.EMAIL_BLOBS.get(failRawKey)).toBeNull()
	expect(await mailbox.getMessage({ messageId: failMessage.id })).toBeNull()
	expect(await retryCount(userId)).toBe(0)
	expect(await tombstonedIds(userId)).toEqual([
		'drop-msg',
		'fail-msg',
		'missing-key-msg',
	])
})

test('Mailbox runRetentionNow is owner-bound, R2-before-row, and no-ops fresh rows', async () => {
	silenceIncidentalRuntimeWarnings(['mailbox-retention-blob-delete-failed'])
	const userId = uniqueUserId('retention-now')
	const mailbox = rpcFor(userId)
	const oldMessageAt = expiredMessageAt()
	const keepMessage = baseMessage(userId, {
		id: 'keep-fresh',
		createdAt: new Date().toISOString(),
	})
	const dropMessage = baseMessage(userId, {
		id: 'drop-old',
		threadId: 'drop-thread',
		createdAt: oldMessageAt,
	})
	const failMessage = baseMessage(userId, {
		id: 'fail-old',
		createdAt: oldMessageAt,
	})
	await mailbox.upsertMessageGraph({ ownerId: userId, message: keepMessage })
	await mailbox.upsertMessageGraph({
		ownerId: userId,
		thread: baseThread({ id: 'drop-thread', lastMessageAt: oldMessageAt }),
		message: dropMessage,
	})
	await mailbox.upsertMessageGraph({ ownerId: userId, message: failMessage })

	await runInDurableObject(stubFor(userId), async (instance: Mailbox) => {
		await assertMailboxThrows(/ownerId mismatch/, () =>
			instance.runRetentionNow({ ownerId: uniqueUserId('retention-other') }),
		)
	})

	const dropRawKey = emailRawMimeKey(userId, dropMessage.id)
	const failRawKey = emailRawMimeKey(userId, failMessage.id)
	const keepRawKey = emailRawMimeKey(userId, keepMessage.id)
	for (const key of [dropRawKey, failRawKey, keepRawKey]) {
		await env.EMAIL_BLOBS.put(key, key)
	}

	{
		const deletedKeys: Array<string> = []
		using _deletes = failDeletesOf(failRawKey, deletedKeys)
		await expect(
			mailbox.runRetentionNow({ ownerId: userId }),
		).resolves.toMatchObject({
			before: { messages: 3 },
			after: { messages: 2 },
			blobDeleteFailures: false,
			expiredRemaining: true,
		})
		expect(deletedKeys).toEqual([dropRawKey])
		expect(await env.EMAIL_BLOBS.get(dropRawKey)).toBeNull()
		expect(await env.EMAIL_BLOBS.get(failRawKey)).not.toBeNull()
		expect(await env.EMAIL_BLOBS.get(keepRawKey)).not.toBeNull()
		expect(await mailbox.getMessage({ messageId: dropMessage.id })).toBeNull()

		await expect(
			mailbox.runRetentionNow({ ownerId: userId }),
		).resolves.toMatchObject({
			before: { messages: 2 },
			after: { messages: 2 },
			blobDeleteFailures: true,
			expiredRemaining: true,
		})
		expect(deletedKeys).toEqual([dropRawKey, failRawKey])
		for (const message of [failMessage, keepMessage]) {
			expect(await mailbox.getMessage({ messageId: message.id })).toMatchObject(
				{ id: message.id },
			)
		}
	}

	// A later invocation retries the one failed item; only then is the next
	// turn a natural-cutoff no-op.
	await makeRetryDue(userId, failMessage.id)
	await expect(
		mailbox.runRetentionNow({ ownerId: userId }),
	).resolves.toMatchObject({ after: { messages: 1 }, expiredRemaining: false })
	const noop = await mailbox.runRetentionNow({ ownerId: userId })
	expect(noop.before).toEqual(noop.after)
	expect(noop).toMatchObject({
		after: { messages: 1 },
		blobDeleteFailures: false,
		expiredRemaining: false,
	})
})

test('Mailbox retention ends after one item so a queued update can save the next', async () => {
	silenceIncidentalRuntimeWarnings()
	const userId = uniqueUserId('retention-concurrency')
	const mailbox = rpcFor(userId)
	const oldAt = expiredMessageAt()
	const [first, updateBeforeGate] = ['a', 'b'].map((suffix) =>
		baseMessage(userId, {
			id: `retention-concurrent-${suffix}`,
			createdAt: oldAt,
		}),
	) as [ReturnType<typeof baseMessage>, ReturnType<typeof baseMessage>]
	for (const message of [first, updateBeforeGate]) {
		await mailbox.upsertMessageGraph({ ownerId: userId, message })
		await env.EMAIL_BLOBS.put(message.rawMimeKey!, `raw-${message.id}`)
	}
	const firstRawKey = emailRawMimeKey(userId, first.id)
	const updatedRawKey = emailRawMimeKey(userId, updateBeforeGate.id)

	let releaseDelete!: () => void
	const deleteGate = new Promise<void>((resolve) => {
		releaseDelete = resolve
	})
	let deleteStarted = false
	const deletedKeys: Array<string> = []
	using _deletes = interceptBlobDeletes(async (keys) => {
		if (keys.includes(firstRawKey)) {
			deleteStarted = true
			await deleteGate
		}
		deletedKeys.push(...keys)
	})
	using _release = { [Symbol.dispose]: () => releaseDelete() }

	const firstTurnAt = Date.now()
	const retention = mailbox.runRetentionNow({ ownerId: userId })
	while (!deleteStarted) {
		await new Promise((resolve) => setTimeout(resolve, 1))
	}
	let mirrorSettled = false
	const newerMirror = runInDurableObject(stubFor(userId), (instance: Mailbox) =>
		instance.upsertMessageGraph({
			ownerId: userId,
			message: {
				...updateBeforeGate,
				subject: 'updated before its retention gate',
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
		}),
	).then((result) => {
		mirrorSettled = true
		return result
	})
	await new Promise((resolve) => setTimeout(resolve, 10))
	expect(mirrorSettled).toBe(false)

	releaseDelete()
	await expect(retention).resolves.toMatchObject({
		before: { messages: 2 },
		after: { messages: 1 },
		blobDeleteFailures: false,
		expiredRemaining: true,
	})
	await expect(newerMirror).resolves.toEqual({ ok: true, accepted: true })
	expectContinuationAlarm(
		await runInDurableObject(
			stubFor(userId),
			async (_instance: Mailbox, state) => state.storage.getAlarm(),
		),
		firstTurnAt,
	)
	expect(await mailbox.getMessage({ messageId: first.id })).toBeNull()
	expect(
		await mailbox.getMessage({ messageId: updateBeforeGate.id }),
	).toMatchObject({ subject: 'updated before its retention gate' })
	expect(deletedKeys).toEqual([firstRawKey])
	expect(await env.EMAIL_BLOBS.get(updatedRawKey)).not.toBeNull()

	// created_at is intentionally immutable, so the live update saves B
	// from turn A but does not renew its retention age. A new turn selects
	// and revalidates the updated snapshot before deleting it.
	await expect(
		mailbox.runRetentionNow({ ownerId: userId }),
	).resolves.toMatchObject({
		before: { messages: 1 },
		after: { messages: 0 },
		blobDeleteFailures: false,
		expiredRemaining: false,
	})
	expect(await env.EMAIL_BLOBS.get(updatedRawKey)).toBeNull()
})

test('Mailbox retention selects one message per turn and revalidates before deletion', async () => {
	silenceIncidentalRuntimeWarnings()
	const userId = uniqueUserId('retention-revalidation')
	const mailbox = rpcFor(userId)
	const oldAt = expiredMessageAt()
	const freshAt = new Date().toISOString()
	const messages = ['a', 'b', 'c'].map((suffix) =>
		baseMessage(userId, {
			id: `retention-revalidation-${suffix}`,
			createdAt: oldAt,
		}),
	)
	for (const message of messages) {
		await mailbox.upsertMessageGraph({ ownerId: userId, message })
		await env.EMAIL_BLOBS.put(emailRawMimeKey(userId, message.id), 'raw')
	}

	const calls: Array<string> = []
	const outcomes: Array<MailboxRetentionMessageDeleteResult> = []
	const results = await runInDurableObject(
		stubFor(userId),
		async (_instance: Mailbox, state) => {
			const store = new MailboxStore(state.storage)
			const runTurn = () =>
				enforceMailboxRetention({
					store,
					deleteMessage: async (cutoff) => {
						const candidate = selectMailboxRetentionCandidate(store, cutoff)
						if (candidate == null) return null
						calls.push(candidate.id)
						if (candidate.id === messages[1]!.id) {
							state.storage.sql.exec(
								`UPDATE email_messages SET created_at = ?, updated_at = ? WHERE id = ?`,
								freshAt,
								freshAt,
								candidate.id,
							)
						}
						const outcome = await deleteMailboxRetentionCandidate({
							store,
							blobs: env.EMAIL_BLOBS,
							ownerId: userId,
							candidate,
							cutoff,
						})
						outcomes.push(outcome)
						return outcome
					},
				})
			return [await runTurn(), await runTurn(), await runTurn()]
		},
	)

	expect(calls).toEqual(messages.map((message) => message.id))
	expect(outcomes).toEqual(['deleted', 'skipped', 'deleted'])
	const turn = (remaining: boolean) => ({
		hadBlobDeleteFailures: false,
		expiredWorkRemaining: remaining,
		eligibleExpiredWorkRemaining: remaining,
		earliestRetryAtMs: null,
	})
	expect(results).toEqual([turn(true), turn(true), turn(false)])
	expect(await mailbox.getMessage({ messageId: messages[0]!.id })).toBeNull()
	expect(
		await mailbox.getMessage({ messageId: messages[1]!.id }),
	).toMatchObject({ createdAt: freshAt, updatedAt: freshAt })
	expect(await mailbox.getMessage({ messageId: messages[2]!.id })).toBeNull()
})

test('Mailbox can idempotently tombstone only an owner-bound missing message', async () => {
	silenceIncidentalRuntimeWarnings()
	const userId = uniqueUserId('missing-tombstone')
	const mailbox = rpcFor(userId)
	const deletedAt = '2026-08-02T20:00:00.000Z'
	const tombstone = (messageId: string, at = deletedAt) =>
		mailbox.tombstoneMissingMessage({
			ownerId: userId,
			messageId,
			deletedAt: at,
		})
	const present = baseMessage(userId, { id: 'present-message' })
	await mailbox.upsertMessageGraph({ ownerId: userId, message: present })

	await expect(tombstone(present.id)).resolves.toEqual({
		status: 'message-present',
	})
	await runInDurableObject(stubFor(userId), async (instance: Mailbox) => {
		await assertMailboxThrows(/ownerId mismatch/, () =>
			instance.tombstoneMissingMessage({
				ownerId: uniqueUserId('missing-tombstone-other'),
				messageId: 'missing-message',
				deletedAt,
			}),
		)
	})
	await mailbox.upsertDeliveryEvent({
		ownerId: userId,
		event: baseDeliveryEvent({
			id: 'missing-message-event-a',
			messageId: 'missing-message',
		}),
	})
	await mailbox.upsertDeliveryEvents({
		ownerId: userId,
		events: [
			baseDeliveryEvent({
				id: 'missing-message-event-b',
				messageId: 'missing-message',
			}),
			baseDeliveryEvent({
				id: 'other-message-event',
				messageId: 'other-message',
			}),
		],
	})
	await expect(tombstone('missing-message')).resolves.toEqual({
		status: 'tombstoned',
		created: true,
	})
	await expect(
		tombstone('missing-message', '2026-08-02T20:01:00.000Z'),
	).resolves.toEqual({ status: 'tombstoned', created: false })
	const events = await mailbox.listDeliveryEvents({ limit: 10 })
	expect(
		events
			.filter((event) => event.id.startsWith('missing-message-event-'))
			.map((event) => event.messageId),
	).toEqual([null, null])
	expect(
		events.find((event) => event.id === 'other-message-event'),
	).toMatchObject({ messageId: 'other-message' })
	await expect(
		mailbox.upsertMessageGraph({
			ownerId: userId,
			message: baseMessage(userId, { id: 'missing-message' }),
		}),
	).resolves.toEqual({ ok: true, accepted: false })
})

test('Mailbox single-message delete is owner-bound and R2-durable before metadata', async () => {
	silenceIncidentalRuntimeWarnings()
	const userId = uniqueUserId('delete-message')
	const mailbox = rpcFor(userId)
	const thread = baseThread({ id: 'delete-thread' })
	const message = baseMessage(userId, {
		id: 'delete-message',
		threadId: thread.id,
	})
	const attachment = baseAttachment(userId, message.id, {
		id: 'delete-attachment',
	})
	const event = baseDeliveryEvent({
		id: 'delete-event',
		messageId: message.id,
	})
	await mailbox.upsertMessageGraph({
		ownerId: userId,
		thread,
		message,
		attachments: [attachment],
	})
	await mailbox.upsertDeliveryEvent({ ownerId: userId, event })
	const upsertAt = (updatedAt: string) =>
		mailbox.upsertMessageGraph({
			ownerId: userId,
			thread,
			message: { ...message, updatedAt },
			attachments: [attachment],
		})

	const rawKey = emailRawMimeKey(userId, message.id)
	const attachmentKey = emailAttachmentBlobKey(
		userId,
		message.id,
		attachment.id,
	)
	await env.EMAIL_BLOBS.put(rawKey, 'raw')
	await env.EMAIL_BLOBS.put(attachmentKey, 'attachment')
	await runInDurableObject(
		stubFor(userId),
		async (instance: Mailbox, state) => {
			state.storage.sql.exec(
				`UPDATE email_messages SET raw_mime_key = NULL WHERE id = ?`,
				message.id,
			)
			await assertMailboxThrows(/ownerId mismatch/, () =>
				instance.deleteMessageWithBlobs({
					ownerId: uniqueUserId('delete-message-other'),
					messageId: message.id,
				}),
			)
		},
	)

	{
		using _deletes = interceptBlobDeletes(() => {
			throw new Error('simulated R2 delete failure')
		})
		await runInDurableObject(stubFor(userId), async (instance: Mailbox) => {
			await assertMailboxThrows(/simulated R2 delete failure/, () =>
				instance.deleteMessageWithBlobs({
					ownerId: userId,
					messageId: message.id,
				}),
			)
		})
		expect(await mailbox.getMessage({ messageId: message.id })).not.toBeNull()
		expect(
			await mailbox.listAttachmentsForMessage({ messageId: message.id }),
		).toHaveLength(1)
		expect(
			await mailbox.listDeliveryEvents({ messageId: message.id }),
		).toHaveLength(1)
		expect(await mailbox.getThread({ threadId: thread.id })).not.toBeNull()
		expect(await tombstonedIds(userId)).toEqual([])
	}

	expect(
		await mailbox.deleteMessageWithBlobs({
			ownerId: userId,
			messageId: message.id,
		}),
	).toEqual({
		status: 'deleted',
		attachmentsSeen: 1,
		externalAttachmentsSeen: 1,
		providerMessageId: null,
		blobReferences: [
			{
				kind: 'raw_mime',
				key: rawKey,
				messageId: message.id,
				attachmentId: null,
			},
			{
				kind: 'attachment',
				key: attachmentKey,
				messageId: message.id,
				attachmentId: attachment.id,
			},
		],
	})
	expect(await env.EMAIL_BLOBS.get(rawKey)).toBeNull()
	expect(await env.EMAIL_BLOBS.get(attachmentKey)).toBeNull()
	expect(await mailbox.getMessage({ messageId: message.id })).toBeNull()
	expect(await mailbox.getThread({ threadId: thread.id })).toBeNull()
	expect(await mailbox.listDeliveryEvents({ limit: 10 })).toEqual([
		expect.objectContaining({ id: event.id, messageId: null }),
	])
	expect(await mailbox.countMailbox()).toEqual({
		threads: 0,
		messages: 0,
		attachments: 0,
		deliveryEvents: 1,
	})
	expect((await mailbox.exportMailbox({ pageSize: 10 })).rows).toEqual([
		expect.objectContaining({ kind: 'delivery_event' }),
	])
	expect(
		await mailbox.deleteMessageWithBlobs({
			ownerId: userId,
			messageId: message.id,
		}),
	).toEqual({ status: 'missing', tombstoned: true })

	// Both a queued stale update and newer snapshots are fenced.
	for (const updatedAt of [
		message.updatedAt,
		'2099-01-01T00:00:00.000Z',
		'2099-01-02T00:00:00.000Z',
	]) {
		expect(await upsertAt(updatedAt)).toEqual({ ok: true, accepted: false })
	}
	expect(await mailbox.getMessage({ messageId: message.id })).toBeNull()
	const [tombstone] = await querySql<{ deleted_at: string }>(
		userId,
		`SELECT deleted_at FROM email_message_deletion_tombstones WHERE message_id = ?`,
		message.id,
	)
	expect(tombstone?.deleted_at).toMatch(
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
	)

	await mailbox.purge({ ownerId: userId })
	expect(await retryCount(userId)).toBe(0)
	expect(await tombstonedIds(userId)).toEqual([])
})
