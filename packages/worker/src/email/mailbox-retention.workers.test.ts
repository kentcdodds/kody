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
	} finally {
		env.EMAIL_BLOBS.delete = originalDelete
	}

	await runInDurableObject(stub, async (instance: Mailbox) => {
		await instance.alarm()
	})
	expect(await env.EMAIL_BLOBS.get(failRawKey)).toBeNull()
	expect(await mailbox.getMessage({ messageId: failMessage.id })).toBeNull()
})
