import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { emailAttachmentBlobKey, emailRawMimeKey } from './blob-keys.ts'
import { type Mailbox } from './mailbox-do.ts'
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

test('Mailbox mutation RPCs: owner bind, monotonic updates, and stale rejection', async () => {
	silenceIncidentalRuntimeWarnings()
	const ownerA = uniqueUserId('mut-a')
	const ownerB = uniqueUserId('mut-b')
	const mailbox = rpcFor(ownerA)
	const stub = stubFor(ownerA)

	const thread = baseThread({
		id: 'mut-thread',
		lastMessageAt: '2026-07-01T12:00:00.000Z',
		updatedAt: '2026-07-01T12:00:00.000Z',
	})
	const message = baseMessage(ownerA, {
		id: 'mut-msg',
		threadId: thread.id,
		processingStatus: 'stored',
		classification: 'accepted',
		updatedAt: '2026-07-01T12:00:00.000Z',
	})
	await mailbox.mirrorMessage({
		ownerId: ownerA,
		thread,
		message,
		attachments: [baseAttachment(ownerA, message.id, { id: 'mut-att' })],
	})

	await runInDurableObject(stub, async (instance: Mailbox) => {
		await assertMailboxThrows(/ownerId mismatch/, () =>
			instance.touchThread({
				ownerId: ownerB,
				threadId: thread.id,
				lastMessageAt: '2026-07-01T13:00:00.000Z',
				updatedAt: '2026-07-01T13:00:00.000Z',
			}),
		)
		await assertMailboxThrows(/ownerId mismatch/, () =>
			instance.updateMessageDelivery({
				ownerId: ownerB,
				messageId: message.id,
				processingStatus: 'sent',
				providerMessageId: 'prov',
				error: null,
				sentAt: '2026-07-01T13:00:00.000Z',
				updatedAt: '2026-07-01T13:00:00.000Z',
			}),
		)
		await assertMailboxThrows(/ownerId mismatch/, () =>
			instance.setMessageClassification({
				ownerId: ownerB,
				messageId: message.id,
				classification: 'quarantined',
				classificationReason: 'spam',
				updatedAt: '2026-07-01T13:00:00.000Z',
			}),
		)
		await assertMailboxThrows(/ownerId mismatch/, () =>
			instance.deleteMessageMetadata({
				ownerId: ownerB,
				messageId: message.id,
				deletedAt: '2026-07-01T13:00:00.000Z',
			}),
		)
		await assertMailboxThrows(/ownerId mismatch/, () =>
			instance.deleteDeliveryEvent({
				ownerId: ownerB,
				eventId: 'missing',
				deletedAt: '2026-07-01T13:00:00.000Z',
			}),
		)
	})

	const staleTouch = await mailbox.touchThread({
		ownerId: ownerA,
		threadId: thread.id,
		lastMessageAt: '2026-07-01T14:00:00.000Z',
		updatedAt: '2026-07-01T11:00:00.000Z',
	})
	expect(staleTouch).toEqual({ accepted: false })
	expect(await mailbox.getThread({ threadId: thread.id })).toMatchObject({
		lastMessageAt: '2026-07-01T12:00:00.000Z',
		updatedAt: '2026-07-01T12:00:00.000Z',
	})

	const regressTouch = await mailbox.touchThread({
		ownerId: ownerA,
		threadId: thread.id,
		lastMessageAt: '2026-06-01T00:00:00.000Z',
		updatedAt: '2026-07-01T12:00:01.000Z',
	})
	expect(regressTouch).toEqual({ accepted: true })
	expect(await mailbox.getThread({ threadId: thread.id })).toMatchObject({
		lastMessageAt: '2026-07-01T12:00:00.000Z',
		updatedAt: '2026-07-01T12:00:01.000Z',
	})

	const advanceTouch = await mailbox.touchThread({
		ownerId: ownerA,
		threadId: thread.id,
		lastMessageAt: '2026-07-01T15:00:00.000Z',
		updatedAt: '2026-07-01T12:00:02.000Z',
	})
	expect(advanceTouch).toEqual({ accepted: true })
	expect(await mailbox.getThread({ threadId: thread.id })).toMatchObject({
		lastMessageAt: '2026-07-01T15:00:00.000Z',
		updatedAt: '2026-07-01T12:00:02.000Z',
	})

	expect(
		await mailbox.touchThread({
			ownerId: ownerA,
			threadId: 'missing-thread',
			lastMessageAt: '2026-07-01T16:00:00.000Z',
			updatedAt: '2026-07-01T16:00:00.000Z',
		}),
	).toEqual({ accepted: false })

	const staleDelivery = await mailbox.updateMessageDelivery({
		ownerId: ownerA,
		messageId: message.id,
		processingStatus: 'failed',
		providerMessageId: 'stale-prov',
		error: 'stale',
		sentAt: null,
		updatedAt: '2026-07-01T11:00:00.000Z',
	})
	expect(staleDelivery).toEqual({ accepted: false })
	expect(await mailbox.getMessage({ messageId: message.id })).toMatchObject({
		processingStatus: 'stored',
		providerMessageId: null,
		error: null,
		updatedAt: '2026-07-01T12:00:00.000Z',
	})

	const deliveryUpdate = await mailbox.updateMessageDelivery({
		ownerId: ownerA,
		messageId: message.id,
		processingStatus: 'sent',
		providerMessageId: 'prov-1',
		error: null,
		sentAt: '2026-07-01T12:05:00.000Z',
		updatedAt: '2026-07-01T12:00:00.000Z',
	})
	expect(deliveryUpdate).toEqual({ accepted: true })
	expect(await mailbox.getMessage({ messageId: message.id })).toMatchObject({
		processingStatus: 'sent',
		providerMessageId: 'prov-1',
		sentAt: '2026-07-01T12:05:00.000Z',
		updatedAt: '2026-07-01T12:00:00.000Z',
	})

	const staleClass = await mailbox.setMessageClassification({
		ownerId: ownerA,
		messageId: message.id,
		classification: 'quarantined',
		classificationReason: 'stale',
		updatedAt: '2026-06-01T00:00:00.000Z',
	})
	expect(staleClass).toEqual({ accepted: false })
	expect(await mailbox.getMessage({ messageId: message.id })).toMatchObject({
		classification: 'accepted',
		classificationReason: null,
	})

	const classUpdate = await mailbox.setMessageClassification({
		ownerId: ownerA,
		messageId: message.id,
		classification: 'quarantined',
		classificationReason: 'Sender matched quarantine rule.',
		updatedAt: '2026-07-01T12:00:03.000Z',
	})
	expect(classUpdate).toEqual({ accepted: true })
	expect(await mailbox.getMessage({ messageId: message.id })).toMatchObject({
		classification: 'quarantined',
		classificationReason: 'Sender matched quarantine rule.',
		updatedAt: '2026-07-01T12:00:03.000Z',
	})
})

test('Mailbox deleteMessageMetadata: stale guard, orphan thread, idempotency, no R2', async () => {
	silenceIncidentalRuntimeWarnings()
	const userId = uniqueUserId('del-msg')
	const mailbox = rpcFor(userId)

	const thread = baseThread({ id: 'del-thread' })
	const alone = baseMessage(userId, {
		id: 'del-alone',
		threadId: thread.id,
		updatedAt: '2026-07-01T12:00:00.000Z',
	})
	const attachment = baseAttachment(userId, alone.id, { id: 'del-att' })
	await mailbox.mirrorMessage({
		ownerId: userId,
		thread,
		message: alone,
		attachments: [attachment],
	})

	const rawKey = emailRawMimeKey(userId, alone.id)
	const attKey = emailAttachmentBlobKey(userId, alone.id, attachment.id)
	await env.EMAIL_BLOBS.put(rawKey, 'raw-bytes')
	await env.EMAIL_BLOBS.put(attKey, 'att-bytes')

	const originalDelete = env.EMAIL_BLOBS.delete.bind(env.EMAIL_BLOBS)
	let blobDeleteCalls = 0
	env.EMAIL_BLOBS.delete = ((keys: string | Array<string>) => {
		blobDeleteCalls += 1
		return originalDelete(keys)
	}) as typeof env.EMAIL_BLOBS.delete

	try {
		const staleDelete = await mailbox.deleteMessageMetadata({
			ownerId: userId,
			messageId: alone.id,
			deletedAt: '2026-07-01T11:00:00.000Z',
		})
		expect(staleDelete).toEqual({ deleted: false, stale: true })
		expect(await mailbox.getMessage({ messageId: alone.id })).not.toBeNull()
		expect(await mailbox.getThread({ threadId: thread.id })).not.toBeNull()
		expect(
			await mailbox.listAttachmentsForMessage({ messageId: alone.id }),
		).toHaveLength(1)

		const deleted = await mailbox.deleteMessageMetadata({
			ownerId: userId,
			messageId: alone.id,
			deletedAt: '2026-07-01T12:00:00.000Z',
		})
		expect(deleted).toEqual({
			deleted: true,
			stale: false,
			orphanThreadDeleted: true,
		})
		expect(await mailbox.getMessage({ messageId: alone.id })).toBeNull()
		expect(await mailbox.getThread({ threadId: thread.id })).toBeNull()
		expect(
			await mailbox.listAttachmentsForMessage({ messageId: alone.id }),
		).toHaveLength(0)
		expect(await env.EMAIL_BLOBS.get(rawKey)).not.toBeNull()
		expect(await env.EMAIL_BLOBS.get(attKey)).not.toBeNull()
		expect(blobDeleteCalls).toBe(0)

		const again = await mailbox.deleteMessageMetadata({
			ownerId: userId,
			messageId: alone.id,
			deletedAt: '2026-07-01T13:00:00.000Z',
		})
		// Missing (`!deleted && !stale`): idempotent success for best-effort callers.
		expect(again).toEqual({ deleted: false, stale: false })
		expect(blobDeleteCalls).toBe(0)
	} finally {
		env.EMAIL_BLOBS.delete = originalDelete
		await env.EMAIL_BLOBS.delete(rawKey)
		await env.EMAIL_BLOBS.delete(attKey)
	}

	const sharedThread = baseThread({ id: 'shared-thread' })
	const keep = baseMessage(userId, {
		id: 'keep-msg',
		threadId: sharedThread.id,
		updatedAt: '2026-07-02T10:00:00.000Z',
	})
	const drop = baseMessage(userId, {
		id: 'drop-msg',
		threadId: sharedThread.id,
		updatedAt: '2026-07-02T10:00:00.000Z',
	})
	await mailbox.mirrorMessage({
		ownerId: userId,
		thread: sharedThread,
		message: keep,
	})
	await mailbox.mirrorMessage({
		ownerId: userId,
		message: drop,
	})
	const dropOnly = await mailbox.deleteMessageMetadata({
		ownerId: userId,
		messageId: drop.id,
		deletedAt: '2026-07-02T10:00:00.000Z',
	})
	expect(dropOnly).toEqual({
		deleted: true,
		stale: false,
		orphanThreadDeleted: false,
	})
	expect(await mailbox.getMessage({ messageId: keep.id })).not.toBeNull()
	expect(await mailbox.getThread({ threadId: sharedThread.id })).not.toBeNull()
})

test('Mailbox deleteDeliveryEvent: stale, deleted, and missing outcomes', async () => {
	silenceIncidentalRuntimeWarnings()
	const userId = uniqueUserId('del-evt')
	const mailbox = rpcFor(userId)

	const message = baseMessage(userId, {
		id: 'evt-msg',
		direction: 'outbound',
		processingStatus: 'sent',
		rawMimeKey: null,
	})
	await mailbox.mirrorMessage({ ownerId: userId, message })
	await mailbox.upsertDeliveryEvent({
		ownerId: userId,
		event: baseDeliveryEvent({
			id: 'evt-del',
			messageId: message.id,
			eventType: 'delivered',
			provider: 'cloudflare-email',
			createdAt: '2026-07-02T10:00:00.000Z',
			updatedAt: '2026-07-02T10:00:00.000Z',
		}),
	})

	const staleDelete = await mailbox.deleteDeliveryEvent({
		ownerId: userId,
		eventId: 'evt-del',
		deletedAt: '2026-07-02T09:00:00.000Z',
	})
	expect(staleDelete).toEqual({ deleted: false, stale: true })
	expect(
		await mailbox.listDeliveryEvents({ messageId: message.id, limit: 5 }),
	).toHaveLength(1)

	const deleted = await mailbox.deleteDeliveryEvent({
		ownerId: userId,
		eventId: 'evt-del',
		deletedAt: '2026-07-02T10:00:00.000Z',
	})
	expect(deleted).toEqual({ deleted: true, stale: false })
	expect(
		await mailbox.listDeliveryEvents({ messageId: message.id, limit: 5 }),
	).toHaveLength(0)

	const again = await mailbox.deleteDeliveryEvent({
		ownerId: userId,
		eventId: 'evt-del',
		deletedAt: '2026-07-02T11:00:00.000Z',
	})
	expect(again).toEqual({ deleted: false, stale: false })
})
