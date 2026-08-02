import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
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

test('mailbox retention helpers prefer backoff/continue and never postpone earlier alarms', () => {
	const nowMs = 1_700_000_000_000
	expect(
		computeMailboxRetentionReschedule({
			nowMs,
			hadBlobDeleteFailures: true,
			expiredWorkRemaining: true,
			nextDueAtMs: nowMs + 10_000,
		}),
	).toEqual({
		kind: 'backoff',
		atMs: nowMs + mailboxRetentionRetryDelayMs,
	})
	expect(
		computeMailboxRetentionReschedule({
			nowMs,
			hadBlobDeleteFailures: false,
			expiredWorkRemaining: true,
			nextDueAtMs: nowMs + 10_000,
		}),
	).toEqual({
		kind: 'continue',
		atMs: nowMs + mailboxRetentionContinuationDelayMs,
	})
	expect(
		computeMailboxRetentionReschedule({
			nowMs,
			hadBlobDeleteFailures: false,
			expiredWorkRemaining: false,
			nextDueAtMs: nowMs + 60_000,
		}),
	).toEqual({ kind: 'next-due', atMs: nowMs + 60_000 })
	expect(
		computeMailboxRetentionReschedule({
			nowMs,
			hadBlobDeleteFailures: false,
			expiredWorkRemaining: false,
			nextDueAtMs: null,
		}),
	).toEqual({ kind: 'idle', atMs: null })

	const earlier = 1_700_000_100_000
	const later = earlier + 60_000
	expect(
		selectMailboxRetentionWriteAlarm({
			proposedAtMs: later,
			existingAtMs: earlier,
		}),
	).toEqual({ action: 'keep-existing' })
	expect(
		selectMailboxRetentionWriteAlarm({
			proposedAtMs: earlier,
			existingAtMs: later,
		}),
	).toEqual({ action: 'set', atMs: earlier })
	expect(
		selectMailboxRetentionWriteAlarm({
			proposedAtMs: earlier + Math.floor(mailboxRetentionAlarmSkewMs / 2),
			existingAtMs: earlier,
		}),
	).toEqual({ action: 'keep-existing' })
	expect(
		selectMailboxRetentionWriteAlarm({
			proposedAtMs: earlier,
			existingAtMs: null,
		}),
	).toEqual({ action: 'set', atMs: earlier })
	expect(
		selectMailboxRetentionWriteAlarm({
			proposedAtMs: null,
			existingAtMs: earlier,
		}),
	).toEqual({ action: 'idle' })
})

test('Mailbox retention deletes canonical R2 keys before metadata and backs off on failure', async () => {
	silenceIncidentalRuntimeWarnings()
	consoleWarn.mockImplementation((...args: Array<unknown>) => {
		const message = String(args[0] ?? '')
		if (message.includes('mailbox-retention-blob-delete-failed')) return
	})

	const userId = uniqueUserId('retention')
	const mailbox = rpcFor(userId)
	const stub = stubFor(userId)

	const oldMessageAt = new Date(
		Date.now() - (mailboxMessageRetentionDays + 3) * 24 * 60 * 60 * 1000,
	).toISOString()
	const oldEventAt = new Date(
		Date.now() - (mailboxDeliveryEventRetentionDays + 3) * 24 * 60 * 60 * 1000,
	).toISOString()
	const freshAt = new Date().toISOString()

	const keepMessage = baseMessage(userId, {
		id: 'keep-msg',
		subject: 'fresh',
		createdAt: freshAt,
		updatedAt: freshAt,
	})
	const dropMessage = baseMessage(userId, {
		id: 'drop-msg',
		threadId: 'drop-thread',
		subject: 'old',
		createdAt: oldMessageAt,
		updatedAt: oldMessageAt,
	})
	const failMessage = baseMessage(userId, {
		id: 'fail-msg',
		subject: 'fail-old',
		createdAt: oldMessageAt,
		updatedAt: oldMessageAt,
	})
	const missingKeyMessage = baseMessage(userId, {
		id: 'missing-key-msg',
		subject: 'missing-stored-key',
		createdAt: oldMessageAt,
		updatedAt: oldMessageAt,
	})
	const dropAttachment = baseAttachment(userId, dropMessage.id, {
		id: 'drop-att',
		createdAt: oldMessageAt,
	})

	await mailbox.mirrorMessage({
		ownerId: userId,
		thread: baseThread({
			id: 'drop-thread',
			lastMessageAt: oldMessageAt,
			createdAt: oldMessageAt,
			updatedAt: oldMessageAt,
		}),
		message: dropMessage,
		attachments: [dropAttachment],
	})
	await mailbox.mirrorMessage({ ownerId: userId, message: keepMessage })
	await mailbox.mirrorMessage({ ownerId: userId, message: failMessage })
	await mailbox.mirrorMessage({ ownerId: userId, message: missingKeyMessage })
	await mailbox.upsertDeliveryEvent({
		ownerId: userId,
		event: baseDeliveryEvent({
			id: 'old-event',
			messageId: keepMessage.id,
			eventType: 'received',
			provider: 'kody',
			createdAt: oldEventAt,
			updatedAt: oldEventAt,
			needsEffectReconcile: false,
		}),
	})
	await mailbox.upsertDeliveryEvent({
		ownerId: userId,
		event: baseDeliveryEvent({
			id: 'fresh-event',
			messageId: keepMessage.id,
			eventType: 'received',
			provider: 'kody',
			createdAt: freshAt,
			updatedAt: freshAt,
			needsEffectReconcile: false,
		}),
	})

	const dropRawKey = emailRawMimeKey(userId, dropMessage.id)
	const dropAttKey = emailAttachmentBlobKey(
		userId,
		dropMessage.id,
		dropAttachment.id,
	)
	const failRawKey = emailRawMimeKey(userId, failMessage.id)
	const keepRawKey = emailRawMimeKey(userId, keepMessage.id)
	const missingRawKey = emailRawMimeKey(userId, missingKeyMessage.id)

	await env.EMAIL_BLOBS.put(dropRawKey, 'drop-raw')
	await env.EMAIL_BLOBS.put(dropAttKey, 'drop-att')
	await env.EMAIL_BLOBS.put(failRawKey, 'fail-raw')
	await env.EMAIL_BLOBS.put(keepRawKey, 'keep-raw')
	await env.EMAIL_BLOBS.put(missingRawKey, 'missing-raw')

	// Stored key missing must not prevent deleting the canonical inbound key.
	await runInDurableObject(stub, async (_instance: Mailbox, state) => {
		state.storage.sql.exec(
			`UPDATE email_messages SET raw_mime_key = NULL WHERE id = ?`,
			missingKeyMessage.id,
		)
	})

	const originalDelete = env.EMAIL_BLOBS.delete.bind(env.EMAIL_BLOBS)
	env.EMAIL_BLOBS.delete = (async (keys: string | Array<string>) => {
		const list = Array.isArray(keys) ? keys : [keys]
		if (list.includes(failRawKey)) {
			throw new Error('simulated R2 delete failure')
		}
		return await originalDelete(keys)
	}) as typeof env.EMAIL_BLOBS.delete

	try {
		const alarmBefore = Date.now()
		const alarmAfterFailure = await runInDurableObject(
			stub,
			async (instance: Mailbox, state) => {
				expect(instance).toBeInstanceOf(Mailbox)
				await state.storage.deleteAlarm()
				await instance.alarm()
				return await state.storage.getAlarm()
			},
		)
		// Overdue retained work (failed R2 delete) must retry with hourly backoff,
		// not every second.
		expect(alarmAfterFailure).toBeTypeOf('number')
		expect(alarmAfterFailure).toBeGreaterThanOrEqual(
			alarmBefore + mailboxRetentionRetryDelayMs - 5_000,
		)
		expect(alarmAfterFailure).toBeLessThanOrEqual(
			alarmBefore + mailboxRetentionRetryDelayMs + 5_000,
		)

		expect(await env.EMAIL_BLOBS.get(dropRawKey)).toBeNull()
		expect(await env.EMAIL_BLOBS.get(dropAttKey)).toBeNull()
		expect(await env.EMAIL_BLOBS.get(missingRawKey)).toBeNull()
		expect(await env.EMAIL_BLOBS.get(failRawKey)).not.toBeNull()
		expect(await env.EMAIL_BLOBS.get(keepRawKey)).not.toBeNull()

		expect(await mailbox.getMessage({ messageId: dropMessage.id })).toBeNull()
		expect(
			await mailbox.listAttachmentsForMessage({ messageId: dropMessage.id }),
		).toHaveLength(0)
		expect(await mailbox.getThread({ threadId: 'drop-thread' })).toBeNull()
		expect(
			await mailbox.getMessage({ messageId: missingKeyMessage.id }),
		).toBeNull()
		expect(
			await mailbox.getMessage({ messageId: failMessage.id }),
		).toMatchObject({
			id: failMessage.id,
		})
		expect(
			await mailbox.getMessage({ messageId: keepMessage.id }),
		).toMatchObject({
			id: keepMessage.id,
		})
		const events = await mailbox.listDeliveryEvents({ limit: 10 })
		expect(events.map((event) => event.id)).toEqual(['fresh-event'])
		await runInDurableObject(stub, async (_instance: Mailbox, state) => {
			const ids = state.storage.sql
				.exec<{ message_id: string }>(
					`SELECT message_id FROM email_message_deletion_tombstones
					ORDER BY message_id`,
				)
				.toArray()
				.map((row) => row.message_id)
			expect(ids).toEqual(['drop-msg', 'missing-key-msg'])
		})
	} finally {
		env.EMAIL_BLOBS.delete = originalDelete
	}

	await runInDurableObject(stub, async (instance: Mailbox) => {
		await instance.alarm()
	})
	expect(await env.EMAIL_BLOBS.get(failRawKey)).toBeNull()
	expect(await mailbox.getMessage({ messageId: failMessage.id })).toBeNull()
	await runInDurableObject(stub, async (_instance: Mailbox, state) => {
		const tombstoned = state.storage.sql
			.exec<{ found: number }>(
				`SELECT 1 AS found FROM email_message_deletion_tombstones
				WHERE message_id = ?`,
				failMessage.id,
			)
			.toArray()[0]
		expect(tombstoned?.found).toBe(1)
	})
})

test('Mailbox runRetentionNow is owner-bound, R2-before-row, and no-ops fresh rows', async () => {
	silenceIncidentalRuntimeWarnings()
	consoleWarn.mockImplementation((...args: Array<unknown>) => {
		const message = String(args[0] ?? '')
		if (message.includes('mailbox-retention-blob-delete-failed')) return
	})

	const userId = uniqueUserId('retention-now')
	const otherOwner = uniqueUserId('retention-other')
	const mailbox = rpcFor(userId)
	const stub = stubFor(userId)

	const oldMessageAt = new Date(
		Date.now() - (mailboxMessageRetentionDays + 3) * 24 * 60 * 60 * 1000,
	).toISOString()
	const freshAt = new Date().toISOString()

	const keepMessage = baseMessage(userId, {
		id: 'keep-fresh',
		subject: 'fresh',
		createdAt: freshAt,
		updatedAt: freshAt,
	})
	const dropMessage = baseMessage(userId, {
		id: 'drop-old',
		threadId: 'drop-thread',
		subject: 'old',
		createdAt: oldMessageAt,
		updatedAt: oldMessageAt,
	})
	const failMessage = baseMessage(userId, {
		id: 'fail-old',
		subject: 'fail-old',
		createdAt: oldMessageAt,
		updatedAt: oldMessageAt,
	})

	await mailbox.mirrorMessage({ ownerId: userId, message: keepMessage })
	await mailbox.mirrorMessage({
		ownerId: userId,
		thread: baseThread({
			id: 'drop-thread',
			lastMessageAt: oldMessageAt,
			createdAt: oldMessageAt,
			updatedAt: oldMessageAt,
		}),
		message: dropMessage,
	})
	await mailbox.mirrorMessage({ ownerId: userId, message: failMessage })

	await runInDurableObject(stub, async (instance: Mailbox) => {
		await assertMailboxThrows(/ownerId mismatch/, () =>
			instance.runRetentionNow({ ownerId: otherOwner }),
		)
	})

	const dropRawKey = emailRawMimeKey(userId, dropMessage.id)
	const failRawKey = emailRawMimeKey(userId, failMessage.id)
	const keepRawKey = emailRawMimeKey(userId, keepMessage.id)
	await env.EMAIL_BLOBS.put(dropRawKey, 'drop-raw')
	await env.EMAIL_BLOBS.put(failRawKey, 'fail-raw')
	await env.EMAIL_BLOBS.put(keepRawKey, 'keep-raw')

	const originalDelete = env.EMAIL_BLOBS.delete.bind(env.EMAIL_BLOBS)
	const deletedKeys: Array<string> = []
	env.EMAIL_BLOBS.delete = (async (keys: string | Array<string>) => {
		const list = Array.isArray(keys) ? keys : [keys]
		deletedKeys.push(...list)
		if (list.includes(failRawKey)) {
			throw new Error('simulated R2 delete failure')
		}
		return await originalDelete(keys)
	}) as typeof env.EMAIL_BLOBS.delete

	try {
		const result = await mailbox.runRetentionNow({ ownerId: userId })
		expect(result.before.messages).toBe(3)
		expect(result.after.messages).toBe(2)
		expect(result.blobDeleteFailures).toBe(true)
		expect(result.expiredRemaining).toBe(true)
		expect(deletedKeys).toEqual(
			expect.arrayContaining([dropRawKey, failRawKey]),
		)
		// R2-before-row via existing fake: successful blob delete drops the
		// row; failed blob delete retains the row and the R2 object.
		expect(await env.EMAIL_BLOBS.get(dropRawKey)).toBeNull()
		expect(await env.EMAIL_BLOBS.get(failRawKey)).not.toBeNull()
		expect(await env.EMAIL_BLOBS.get(keepRawKey)).not.toBeNull()
		expect(await mailbox.getMessage({ messageId: dropMessage.id })).toBeNull()
		expect(
			await mailbox.getMessage({ messageId: failMessage.id }),
		).toMatchObject({ id: failMessage.id })
		expect(
			await mailbox.getMessage({ messageId: keepMessage.id }),
		).toMatchObject({ id: keepMessage.id })
	} finally {
		env.EMAIL_BLOBS.delete = originalDelete
	}

	// Natural cutoff no-op: only fresh rows remain after retry clears the
	// failed delete — later pass reports no further deletions.
	await mailbox.runRetentionNow({ ownerId: userId })
	const noop = await mailbox.runRetentionNow({ ownerId: userId })
	expect(noop.before).toEqual(noop.after)
	expect(noop.blobDeleteFailures).toBe(false)
	expect(noop.expiredRemaining).toBe(false)
	expect(noop.after.messages).toBe(1)
})

test('Mailbox retention blocks a newer mirror across the R2 deletion boundary', async () => {
	silenceIncidentalRuntimeWarnings()
	const userId = uniqueUserId('retention-concurrency')
	const mailbox = rpcFor(userId)
	const oldAt = new Date(
		Date.now() - (mailboxMessageRetentionDays + 3) * 24 * 60 * 60 * 1000,
	).toISOString()
	const message = baseMessage(userId, {
		id: 'retention-concurrent-message',
		createdAt: oldAt,
		updatedAt: oldAt,
	})
	await mailbox.mirrorMessage({ ownerId: userId, message })
	const rawKey = emailRawMimeKey(userId, message.id)
	await env.EMAIL_BLOBS.put(rawKey, 'raw')

	let releaseDelete!: () => void
	const deleteGate = new Promise<void>((resolve) => {
		releaseDelete = resolve
	})
	let deleteStarted = false
	const originalDelete = env.EMAIL_BLOBS.delete.bind(env.EMAIL_BLOBS)
	env.EMAIL_BLOBS.delete = (async (keys: string | Array<string>) => {
		const list = Array.isArray(keys) ? keys : [keys]
		if (list.includes(rawKey)) {
			deleteStarted = true
			await deleteGate
		}
		await originalDelete(keys)
	}) as typeof env.EMAIL_BLOBS.delete

	try {
		const retention = mailbox.runRetentionNow({ ownerId: userId })
		while (!deleteStarted) {
			await new Promise((resolve) => setTimeout(resolve, 1))
		}
		let mirrorSettled = false
		const newerMirror = mailbox
			.mirrorMessage({
				ownerId: userId,
				message: {
					...message,
					subject: 'newer live mirror',
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
			})
			.then((result) => {
				mirrorSettled = true
				return result
			})
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(mirrorSettled).toBe(false)

		releaseDelete()
		await expect(retention).resolves.toMatchObject({
			after: { messages: 0 },
		})
		await expect(newerMirror).resolves.toEqual({ ok: true, accepted: false })
		expect(await mailbox.getMessage({ messageId: message.id })).toBeNull()
	} finally {
		releaseDelete()
		env.EMAIL_BLOBS.delete = originalDelete
	}
})

test('Mailbox can idempotently tombstone only an owner-bound missing message', async () => {
	silenceIncidentalRuntimeWarnings()
	const userId = uniqueUserId('missing-tombstone')
	const otherOwner = uniqueUserId('missing-tombstone-other')
	const mailbox = rpcFor(userId)
	const deletedAt = '2026-08-02T20:00:00.000Z'
	const present = baseMessage(userId, { id: 'present-message' })
	await mailbox.mirrorMessage({ ownerId: userId, message: present })

	await expect(
		mailbox.tombstoneMissingMessage({
			ownerId: userId,
			messageId: present.id,
			deletedAt,
		}),
	).resolves.toEqual({ status: 'message-present' })
	await runInDurableObject(stubFor(userId), async (instance: Mailbox) => {
		await assertMailboxThrows(/ownerId mismatch/, () =>
			instance.tombstoneMissingMessage({
				ownerId: otherOwner,
				messageId: 'missing-message',
				deletedAt,
			}),
		)
	})
	await expect(
		mailbox.tombstoneMissingMessage({
			ownerId: userId,
			messageId: 'missing-message',
			deletedAt,
		}),
	).resolves.toEqual({ status: 'tombstoned', created: true })
	await expect(
		mailbox.tombstoneMissingMessage({
			ownerId: userId,
			messageId: 'missing-message',
			deletedAt: '2026-08-02T20:01:00.000Z',
		}),
	).resolves.toEqual({ status: 'tombstoned', created: false })
	await expect(
		mailbox.mirrorMessage({
			ownerId: userId,
			message: baseMessage(userId, { id: 'missing-message' }),
		}),
	).resolves.toEqual({ ok: true, accepted: false })
})

test('Mailbox single-message delete is owner-bound and R2-durable before metadata', async () => {
	silenceIncidentalRuntimeWarnings()
	const userId = uniqueUserId('delete-message')
	const otherOwner = uniqueUserId('delete-message-other')
	const mailbox = rpcFor(userId)
	const stub = stubFor(userId)
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
		eventType: 'received',
	})
	await mailbox.mirrorMessage({
		ownerId: userId,
		thread,
		message,
		attachments: [attachment],
	})
	await mailbox.upsertDeliveryEvent({ ownerId: userId, event })

	const rawKey = emailRawMimeKey(userId, message.id)
	const attachmentKey = emailAttachmentBlobKey(
		userId,
		message.id,
		attachment.id,
	)
	await env.EMAIL_BLOBS.put(rawKey, 'raw')
	await env.EMAIL_BLOBS.put(attachmentKey, 'attachment')
	await runInDurableObject(stub, async (instance: Mailbox, state) => {
		state.storage.sql.exec(
			`UPDATE email_messages SET raw_mime_key = NULL WHERE id = ?`,
			message.id,
		)
		await assertMailboxThrows(/ownerId mismatch/, () =>
			instance.deleteMessageWithBlobs({
				ownerId: otherOwner,
				messageId: message.id,
			}),
		)
		await assertMailboxThrows(/ownerId mismatch/, () =>
			instance.purgeForParityRebuild({ ownerId: otherOwner }),
		)
	})

	const originalDelete = env.EMAIL_BLOBS.delete.bind(env.EMAIL_BLOBS)
	env.EMAIL_BLOBS.delete = (async () => {
		throw new Error('simulated R2 delete failure')
	}) as typeof env.EMAIL_BLOBS.delete
	try {
		await runInDurableObject(stub, async (instance: Mailbox) => {
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
		await runInDurableObject(stub, async (_instance: Mailbox, state) => {
			const tombstones = state.storage.sql
				.exec<{ count: number }>(
					`SELECT COUNT(*) AS count
					FROM email_message_deletion_tombstones
					WHERE message_id = ?`,
					message.id,
				)
				.toArray()[0]?.count
			expect(Number(tombstones)).toBe(0)
		})
	} finally {
		env.EMAIL_BLOBS.delete = originalDelete
	}

	const result = await mailbox.deleteMessageWithBlobs({
		ownerId: userId,
		messageId: message.id,
	})
	expect(result).toEqual({
		status: 'deleted',
		attachmentsSeen: 1,
		externalAttachmentsSeen: 1,
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

	// Both a queued stale dual-write and a newer parity snapshot are fenced.
	expect(
		await mailbox.mirrorMessage({
			ownerId: userId,
			thread,
			message,
			attachments: [attachment],
		}),
	).toEqual({ ok: true, accepted: false })
	expect(
		await mailbox.mirrorMessage({
			ownerId: userId,
			thread,
			message: {
				...message,
				updatedAt: '2099-01-01T00:00:00.000Z',
			},
			attachments: [attachment],
		}),
	).toEqual({ ok: true, accepted: false })
	expect(await mailbox.getMessage({ messageId: message.id })).toBeNull()

	await runInDurableObject(stub, async (_instance: Mailbox, state) => {
		const tombstone = state.storage.sql
			.exec<{ deleted_at: string }>(
				`SELECT deleted_at FROM email_message_deletion_tombstones
				WHERE message_id = ?`,
				message.id,
			)
			.toArray()[0]
		expect(tombstone?.deleted_at).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
		)
	})

	await mailbox.purgeForParityRebuild({ ownerId: userId })
	expect(
		await mailbox.mirrorMessage({
			ownerId: userId,
			thread,
			message: {
				...message,
				updatedAt: '2099-01-02T00:00:00.000Z',
			},
			attachments: [attachment],
		}),
	).toEqual({ ok: true, accepted: false })

	await mailbox.purge()
	await runInDurableObject(stub, async (_instance: Mailbox, state) => {
		const tombstones = state.storage.sql
			.exec<{ count: number }>(
				`SELECT COUNT(*) AS count
				FROM email_message_deletion_tombstones`,
			)
			.toArray()[0]?.count
		expect(Number(tombstones)).toBe(0)
	})
})
