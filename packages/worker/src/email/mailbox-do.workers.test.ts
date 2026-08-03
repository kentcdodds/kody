import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { emailAttachmentBlobKey, emailRawMimeKey } from './blob-keys.ts'
import { mapMailboxMessageRow } from './mailbox-mappers.ts'
import { Mailbox } from './mailbox-do.ts'
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
import { mailboxUpsertDeliveryEventsMax } from './mailbox-types.ts'

test('Mailbox upserts, reads, searches, isolates owners, and stays idempotent', async () => {
	silenceIncidentalRuntimeWarnings()
	const ownerA = uniqueUserId('a')
	const ownerB = uniqueUserId('b')
	const mailboxA = rpcFor(ownerA)
	const mailboxB = rpcFor(ownerB)

	const stubA = stubFor(ownerA)
	await runInDurableObject(stubA, async (instance: Mailbox, state) => {
		expect(instance).toBeInstanceOf(Mailbox)
		const tables = state.storage.sql
			.exec<{ name: string }>(
				`SELECT name FROM sqlite_master
				WHERE type = 'table'
					AND name IN (
						'email_threads', 'email_messages',
						'email_attachments', 'email_delivery_events',
						'email_message_deletion_tombstones',
						'email_message_retention_retries',
						'mailbox_owner_identity'
					)
				ORDER BY name ASC`,
			)
			.toArray()
			.map((row) => row.name)
		expect(tables).toEqual([
			'email_attachments',
			'email_delivery_events',
			'email_message_deletion_tombstones',
			'email_message_retention_retries',
			'email_messages',
			'email_threads',
			'mailbox_owner_identity',
		])
		expect(await state.storage.getAlarm()).toBeNull()
	})

	const thread = baseThread({ id: 'thread-1' })
	const message = baseMessage(ownerA, {
		id: 'msg-1',
		threadId: thread.id,
		subject: 'Project update',
		fromAddress: 'alice@example.com',
	})
	const attachment = baseAttachment(ownerA, message.id, { id: 'att-1' })

	await mailboxA.upsertMessageGraph({
		ownerId: ownerA,
		thread,
		message,
		attachments: [attachment],
	})
	await mailboxA.upsertMessageGraph({
		ownerId: ownerA,
		thread,
		message: {
			...message,
			subject: 'Project update (edited)',
			updatedAt: '2026-07-01T12:00:01.000Z',
		},
		attachments: [attachment],
	})

	const stored = await mailboxA.getMessage({ messageId: message.id })
	expect(stored).toMatchObject({
		id: message.id,
		threadId: thread.id,
		subject: 'Project update (edited)',
		fromAddress: 'alice@example.com',
		rawMimeKey: emailRawMimeKey(ownerA, message.id),
	})
	expect(await mailboxA.getThread({ threadId: thread.id })).toMatchObject({
		id: thread.id,
		subjectNormalized: 'hello',
	})
	expect(
		await mailboxA.listAttachmentsForMessage({ messageId: message.id }),
	).toEqual([
		expect.objectContaining({
			id: attachment.id,
			storageKey: attachment.storageKey,
			storageKind: 'external',
		}),
	])
	expect(
		await mailboxA.getAttachment({ attachmentId: attachment.id }),
	).toMatchObject({
		id: attachment.id,
		messageId: message.id,
		storageKind: 'external',
	})
	expect(
		await mailboxA.getAttachment({ attachmentId: 'missing-att' }),
	).toBeNull()
	expect(
		await mailboxA.getMessageByMessageIdHeader({
			messageIdHeader: message.messageIdHeader!,
		}),
	).toMatchObject({ id: message.id })

	const listed = await mailboxA.listMessages({ limit: 10 })
	expect(listed.messages.map((row) => row.id)).toEqual([message.id])
	const searched = await mailboxA.searchMessages({ query: 'project' })
	expect(searched.messages.map((row) => row.id)).toEqual([message.id])
	expect(
		(await mailboxA.searchMessages({ query: 'nope' })).messages,
	).toHaveLength(0)
	expect(await mailboxA.countMessages({})).toEqual({ total: 1 })
	expect(
		await mailboxA.countMessages({
			query: 'project',
			classification: 'accepted',
		}),
	).toEqual({ total: 1 })

	await mailboxB.upsertMessageGraph({
		ownerId: ownerB,
		thread: baseThread({ id: 'thread-b' }),
		message: baseMessage(ownerB, {
			id: 'msg-b',
			threadId: 'thread-b',
			subject: 'Other owner',
		}),
	})
	expect(await mailboxB.getMessage({ messageId: message.id })).toBeNull()
	expect(await mailboxA.getMessage({ messageId: 'msg-b' })).toBeNull()
	expect(
		await mailboxB.getAttachment({ attachmentId: attachment.id }),
	).toBeNull()
	expect(await mailboxA.countMailbox()).toMatchObject({
		threads: 1,
		messages: 1,
		attachments: 1,
		deliveryEvents: 0,
	})
	expect(await mailboxB.countMailbox()).toMatchObject({
		threads: 1,
		messages: 1,
		attachments: 0,
		deliveryEvents: 0,
	})

	const outboundId = 'msg-out-1'
	await mailboxA.upsertMessageGraph({
		ownerId: ownerA,
		message: baseMessage(ownerA, {
			id: outboundId,
			direction: 'outbound',
			subject: 'Sent mail',
			providerMessageId: 'provider-1',
			processingStatus: 'sent',
			rawMimeKey: null,
		}),
	})
	expect(
		await mailboxA.getOutboundMessageByProviderMessageId({
			providerMessageId: 'provider-1',
		}),
	).toMatchObject({ id: outboundId })

	// Cross-user ownerId and forged blob keys must be rejected.
	await runInDurableObject(stubA, async (instance: Mailbox) => {
		await assertMailboxThrows(/ownerId mismatch/, () =>
			instance.upsertMessageGraph({
				ownerId: ownerB,
				message: baseMessage(ownerA, { id: 'cross-user' }),
			}),
		)
		await assertMailboxThrows(/rawMimeKey must equal/, () =>
			instance.upsertMessageGraph({
				ownerId: ownerA,
				message: baseMessage(ownerA, {
					id: 'bad-key',
					rawMimeKey: emailRawMimeKey(ownerB, 'bad-key'),
				}),
			}),
		)
		await assertMailboxThrows(/storageKey must equal/, () =>
			instance.upsertMessageGraph({
				ownerId: ownerA,
				message: baseMessage(ownerA, { id: 'bad-att-msg' }),
				attachments: [
					baseAttachment(ownerA, 'bad-att-msg', {
						id: 'bad-att',
						storageKey: emailAttachmentBlobKey(
							ownerB,
							'bad-att-msg',
							'bad-att',
						),
					}),
				],
			}),
		)
	})
})

test('Mailbox stale snapshots, attachment omit/clear, delivery-event updatedAt', async () => {
	silenceIncidentalRuntimeWarnings()
	const userId = uniqueUserId('stale')
	const mailbox = rpcFor(userId)

	const thread = baseThread({ id: 'stale-thread' })
	const message = baseMessage(userId, {
		id: 'stale-msg',
		threadId: thread.id,
		classification: 'accepted',
		updatedAt: '2026-07-01T12:00:00.000Z',
	})
	const attachment = baseAttachment(userId, message.id, { id: 'stale-att' })

	await mailbox.upsertMessageGraph({
		ownerId: userId,
		thread,
		message,
		attachments: [attachment],
	})

	// Omitted attachments leave existing metadata unchanged.
	await mailbox.upsertMessageGraph({
		ownerId: userId,
		message: {
			...message,
			subject: 'edited without attachments field',
			updatedAt: '2026-07-01T12:00:01.000Z',
		},
	})
	expect(
		await mailbox.listAttachmentsForMessage({ messageId: message.id }),
	).toHaveLength(1)

	// Stale snapshot must not regress classification, thread time, or attachments.
	const staleUpsert = await mailbox.upsertMessageGraph({
		ownerId: userId,
		thread: {
			...thread,
			lastMessageAt: '2026-06-01T00:00:00.000Z',
			updatedAt: '2026-06-01T00:00:00.000Z',
		},
		message: {
			...message,
			classification: 'quarantined',
			subject: 'stale subject',
			updatedAt: '2026-07-01T11:00:00.000Z',
		},
		attachments: [],
	})
	expect(staleUpsert.accepted).toBe(false)
	expect(await mailbox.getMessage({ messageId: message.id })).toMatchObject({
		classification: 'accepted',
		subject: 'edited without attachments field',
		updatedAt: '2026-07-01T12:00:01.000Z',
	})
	expect(await mailbox.getThread({ threadId: thread.id })).toMatchObject({
		lastMessageAt: thread.lastMessageAt,
	})
	expect(
		await mailbox.listAttachmentsForMessage({ messageId: message.id }),
	).toHaveLength(1)

	// Explicit [] clears only when the message snapshot is accepted.
	await mailbox.upsertMessageGraph({
		ownerId: userId,
		message: {
			...message,
			subject: 'cleared attachments',
			updatedAt: '2026-07-01T12:00:02.000Z',
		},
		attachments: [],
	})
	expect(
		await mailbox.listAttachmentsForMessage({ messageId: message.id }),
	).toHaveLength(0)

	const outbound = baseMessage(userId, {
		id: 'stale-out',
		direction: 'outbound',
		providerMessageId: 'prov-stale',
		processingStatus: 'sent',
		deliveryStatus: 'delivered',
		deliveryStatusAt: '2026-07-02T10:00:00.000Z',
		updatedAt: '2026-07-02T10:00:00.000Z',
	})
	await mailbox.upsertMessageGraph({ ownerId: userId, message: outbound })
	await mailbox.upsertMessageGraph({
		ownerId: userId,
		message: {
			...outbound,
			deliveryStatus: 'deferred',
			deliveryStatusAt: '2026-07-02T09:00:00.000Z',
			updatedAt: '2026-07-02T10:00:01.000Z',
		},
	})
	expect(await mailbox.getMessage({ messageId: outbound.id })).toMatchObject({
		deliveryStatus: 'delivered',
		deliveryStatusAt: '2026-07-02T10:00:00.000Z',
	})

	const first = await mailbox.upsertDeliveryEvent({
		ownerId: userId,
		event: baseDeliveryEvent({
			id: 'evt-1',
			messageId: outbound.id,
			eventType: 'delivered',
			provider: 'cloudflare-email',
			providerMessageId: 'prov-stale',
			providerEventId: 'provider-event-1',
			createdAt: '2026-07-02T10:00:00.000Z',
			updatedAt: '2026-07-02T10:00:00.000Z',
			needsEffectReconcile: false,
			state: 'received',
			fingerprint: 'fp-1',
		}),
		latestDeliveryStatus: {
			messageId: outbound.id,
			deliveryStatus: 'delivered',
			deliveryStatusAt: '2026-07-02T10:30:00.000Z',
		},
	})
	expect(first).toEqual({
		inserted: true,
		accepted: true,
		updatedLatestStatus: true,
	})

	const staleEvent = await mailbox.upsertDeliveryEvent({
		ownerId: userId,
		event: baseDeliveryEvent({
			id: 'evt-1',
			messageId: outbound.id,
			eventType: 'deferred',
			provider: 'cloudflare-email',
			providerEventId: 'provider-event-1',
			createdAt: '2026-07-02T10:00:00.000Z',
			updatedAt: '2026-07-02T09:00:00.000Z',
			needsEffectReconcile: true,
			state: null,
			fingerprint: null,
		}),
	})
	expect(staleEvent).toEqual({
		inserted: false,
		accepted: false,
		updatedLatestStatus: false,
	})
	const eventRow = (
		await mailbox.listDeliveryEvents({ messageId: outbound.id, limit: 5 })
	).find((row) => row.id === 'evt-1')
	expect(eventRow).toMatchObject({
		eventType: 'delivered',
		state: 'received',
		fingerprint: 'fp-1',
		needsEffectReconcile: false,
		updatedAt: '2026-07-02T10:00:00.000Z',
	})

	const duplicate = await mailbox.upsertDeliveryEvent({
		ownerId: userId,
		event: baseDeliveryEvent({
			id: 'evt-1-dup',
			messageId: outbound.id,
			eventType: 'delivered',
			provider: 'cloudflare-email',
			providerEventId: 'provider-event-1',
			createdAt: '2026-07-02T11:00:00.000Z',
			updatedAt: '2026-07-02T11:00:00.000Z',
		}),
	})
	expect(duplicate).toEqual({
		inserted: false,
		accepted: false,
		updatedLatestStatus: false,
	})

	expect(() =>
		mapMailboxMessageRow({
			id: 'corrupt',
			direction: 'bogus',
			processing_status: 'stored',
			classification: 'accepted',
			to_addresses_json: '[]',
			cc_addresses_json: '[]',
			bcc_addresses_json: '[]',
			reply_to_addresses_json: '[]',
			references_json: '[]',
			headers_json: '{}',
			created_at: '2026-07-01T12:00:00.000Z',
			updated_at: '2026-07-01T12:00:00.000Z',
		}),
	).toThrow(/persisted direction is invalid/)
})

test('Mailbox delivery status, promoted inbound fields, export paging, and cursor rejection', async () => {
	silenceIncidentalRuntimeWarnings()
	const userId = uniqueUserId('export')
	const mailbox = rpcFor(userId)

	const thread = baseThread({ id: 'export-thread' })
	const message = baseMessage(userId, {
		id: 'export-msg',
		threadId: thread.id,
		direction: 'outbound',
		providerMessageId: 'prov-export',
		processingStatus: 'sent',
		rawMimeKey: null,
		deliveryStatus: 'delivered',
		deliveryStatusAt: '2026-07-02T10:00:00.000Z',
	})
	const attachment = baseAttachment(userId, message.id, {
		id: 'export-att',
	})
	const inboundBlobMessage = baseMessage(userId, {
		id: 'export-inbound',
		subject: 'inbound for blobs',
	})
	const inboundAttachment = baseAttachment(userId, inboundBlobMessage.id, {
		id: 'export-inbound-att',
	})
	await mailbox.upsertMessageGraph({
		ownerId: userId,
		thread,
		message,
		attachments: [attachment],
	})
	await mailbox.upsertMessageGraph({
		ownerId: userId,
		message: inboundBlobMessage,
		attachments: [inboundAttachment],
	})

	// A stale replay must not regress a newer delivery status.
	await mailbox.upsertMessageGraph({
		ownerId: userId,
		message: {
			...message,
			deliveryStatus: 'deferred',
			deliveryStatusAt: '2026-07-02T09:00:00.000Z',
			updatedAt: '2026-07-02T10:00:01.000Z',
		},
	})
	expect(await mailbox.getMessage({ messageId: message.id })).toMatchObject({
		deliveryStatus: 'delivered',
		deliveryStatusAt: '2026-07-02T10:00:00.000Z',
	})

	// Equal timestamps may update (matches D1 <= semantics).
	await mailbox.upsertMessageGraph({
		ownerId: userId,
		message: {
			...message,
			deliveryStatus: 'complained',
			deliveryStatusAt: '2026-07-02T10:00:00.000Z',
			updatedAt: '2026-07-02T10:00:02.000Z',
		},
	})
	expect(await mailbox.getMessage({ messageId: message.id })).toMatchObject({
		deliveryStatus: 'complained',
		deliveryStatusAt: '2026-07-02T10:00:00.000Z',
	})

	const first = await mailbox.upsertDeliveryEvent({
		ownerId: userId,
		event: baseDeliveryEvent({
			id: 'evt-1',
			messageId: message.id,
			eventType: 'delivered',
			provider: 'cloudflare-email',
			providerMessageId: 'prov-export',
			providerEventId: 'provider-event-1',
			createdAt: '2026-07-02T10:00:00.000Z',
			updatedAt: '2026-07-02T10:00:00.000Z',
			needsEffectReconcile: false,
		}),
		latestDeliveryStatus: {
			messageId: message.id,
			deliveryStatus: 'delivered',
			deliveryStatusAt: '2026-07-02T10:30:00.000Z',
		},
	})
	expect(first).toEqual({
		inserted: true,
		accepted: true,
		updatedLatestStatus: true,
	})

	// Explicit needsEffectReconcile: false is stored as false.
	await mailbox.upsertDeliveryEvent({
		ownerId: userId,
		event: baseDeliveryEvent({
			id: 'evt-default-reconcile',
			messageId: message.id,
			eventType: 'sent',
			provider: 'kody',
			createdAt: '2026-07-02T11:30:00.000Z',
			updatedAt: '2026-07-02T11:30:00.000Z',
			needsEffectReconcile: false,
		}),
	})
	const defaultReconcile = (
		await mailbox.listDeliveryEvents({ messageId: message.id, limit: 20 })
	).find((event) => event.id === 'evt-default-reconcile')
	expect(defaultReconcile?.needsEffectReconcile).toBe(false)

	const duplicate = await mailbox.upsertDeliveryEvent({
		ownerId: userId,
		event: baseDeliveryEvent({
			id: 'evt-1-dup',
			messageId: message.id,
			eventType: 'delivered',
			provider: 'cloudflare-email',
			providerMessageId: 'prov-export',
			providerEventId: 'provider-event-1',
			createdAt: '2026-07-02T11:00:00.000Z',
			updatedAt: '2026-07-02T11:00:00.000Z',
		}),
		latestDeliveryStatus: {
			messageId: message.id,
			deliveryStatus: 'delivered',
			deliveryStatusAt: '2026-07-02T11:00:00.000Z',
		},
	})
	expect(duplicate.inserted).toBe(false)
	expect(duplicate.accepted).toBe(false)

	const stale = await mailbox.upsertDeliveryEvent({
		ownerId: userId,
		event: baseDeliveryEvent({
			id: 'evt-2',
			messageId: message.id,
			eventType: 'deferred',
			provider: 'cloudflare-email',
			providerMessageId: 'prov-export',
			providerEventId: 'provider-event-2',
			createdAt: '2026-07-02T09:00:00.000Z',
			updatedAt: '2026-07-02T09:00:00.000Z',
		}),
		latestDeliveryStatus: {
			messageId: message.id,
			deliveryStatus: 'deferred',
			deliveryStatusAt: '2026-07-02T09:00:00.000Z',
		},
	})
	expect(stale).toEqual({
		inserted: true,
		accepted: true,
		updatedLatestStatus: false,
	})
	expect(await mailbox.getMessage({ messageId: message.id })).toMatchObject({
		deliveryStatus: 'delivered',
		deliveryStatusAt: '2026-07-02T10:30:00.000Z',
	})

	const stub = stubFor(userId)
	await runInDurableObject(stub, async (instance: Mailbox) => {
		await assertMailboxThrows(/export cursor is invalid/, () =>
			instance.exportMailbox({ pageSize: 1, startAfter: 'not-a-cursor' }),
		)
		await assertMailboxThrows(/list cursor is invalid/, () =>
			instance.listMessages({ limit: 1, cursor: '%%%' }),
		)
		await assertMailboxThrows(/blob-reference cursor is invalid/, () =>
			instance.listBlobReferences({ pageSize: 1, startAfter: 'bad' }),
		)
		await assertMailboxThrows(/canonical ISO-8601/, () =>
			instance.upsertMessageGraph({
				ownerId: userId,
				message: baseMessage(userId, {
					id: 'bad-iso',
					createdAt: '2026-07-01T12:00:00Z',
					updatedAt: '2026-07-01T12:00:00Z',
				}),
			}),
		)
	})

	const kinds: Array<string> = []
	let startAfter: string | null = null
	for (let page = 0; page < 40; page += 1) {
		const exported = await mailbox.exportMailbox({
			pageSize: 1,
			startAfter,
		})
		for (const row of exported.rows) {
			kinds.push(row.kind)
			switch (row.kind) {
				case 'thread':
					expect(row.row.id).toBe(thread.id)
					break
				case 'message':
					expect(['export-msg', 'export-inbound']).toContain(row.row.id)
					break
				case 'attachment':
					expect(['export-att', 'export-inbound-att']).toContain(row.row.id)
					break
				case 'delivery_event':
					expect(typeof row.row.id).toBe('string')
					break
				default: {
					const exhaustive: never = row
					throw new Error(`Unhandled export kind: ${String(exhaustive)}`)
				}
			}
		}
		if (!exported.truncated) break
		expect(exported.nextStartAfter).not.toBe(startAfter)
		startAfter = exported.nextStartAfter
	}
	expect(kinds.filter((kind) => kind === 'thread')).toHaveLength(1)
	expect(kinds.filter((kind) => kind === 'message')).toHaveLength(2)
	expect(kinds.filter((kind) => kind === 'attachment')).toHaveLength(2)
	expect(
		kinds.filter((kind) => kind === 'delivery_event').length,
	).toBeGreaterThanOrEqual(3)

	const blobKinds: Array<string> = []
	const blobKeys: Array<string> = []
	let blobCursor: string | null = null
	for (let page = 0; page < 10; page += 1) {
		const pageResult = await mailbox.listBlobReferences({
			pageSize: 1,
			startAfter: blobCursor,
		})
		for (const reference of pageResult.references) {
			blobKinds.push(reference.kind)
			blobKeys.push(reference.key)
			if (reference.kind === 'raw_mime') {
				expect(reference.key).toBe(
					emailRawMimeKey(userId, inboundBlobMessage.id),
				)
				expect(reference.messageId).toBe(inboundBlobMessage.id)
			} else {
				expect(reference.key).toBe(
					emailAttachmentBlobKey(
						userId,
						reference.messageId,
						reference.attachmentId!,
					),
				)
			}
		}
		if (!pageResult.truncated) break
		expect(pageResult.nextStartAfter).not.toBe(blobCursor)
		blobCursor = pageResult.nextStartAfter
	}
	expect(blobKinds[0]).toBe('raw_mime')
	expect(blobKinds.filter((kind) => kind === 'attachment').length).toBe(2)
	expect(blobKeys).toContain(
		emailAttachmentBlobKey(userId, message.id, attachment.id),
	)

	await mailbox.purge()
	expect(await mailbox.countMailbox()).toEqual({
		threads: 0,
		messages: 0,
		attachments: 0,
		deliveryEvents: 0,
	})
})

test('Mailbox upsertDeliveryEvents validates bounds, owns batch, and arms retention once', async () => {
	silenceIncidentalRuntimeWarnings()
	const userId = uniqueUserId('batch')
	const otherUserId = uniqueUserId('batch-other')
	const mailbox = rpcFor(userId)
	const stub = stubFor(userId)

	const message = baseMessage(userId, {
		id: 'batch-msg',
		direction: 'outbound',
		processingStatus: 'sent',
		rawMimeKey: null,
		deliveryStatus: 'delivered',
		deliveryStatusAt: '2026-07-02T10:00:00.000Z',
	})
	await mailbox.upsertMessageGraph({ ownerId: userId, message })

	await runInDurableObject(stub, async (instance: Mailbox) => {
		await assertMailboxThrows(/events must be non-empty/, () =>
			instance.upsertDeliveryEvents({ ownerId: userId, events: [] }),
		)
	})
	const tooMany = Array.from(
		{ length: mailboxUpsertDeliveryEventsMax + 1 },
		(_, index) =>
			baseDeliveryEvent({
				id: `overflow-${index}`,
				messageId: message.id,
				eventType: 'sent',
				provider: 'kody',
				createdAt: '2026-07-02T10:00:00.000Z',
				updatedAt: '2026-07-02T10:00:00.000Z',
			}),
	)
	await runInDurableObject(stub, async (instance: Mailbox) => {
		await assertMailboxThrows(/exceed max of/, () =>
			instance.upsertDeliveryEvents({ ownerId: userId, events: tooMany }),
		)
	})

	await runInDurableObject(stub, async (_instance: Mailbox, state) => {
		await state.storage.deleteAlarm()
	})

	const batch = [
		baseDeliveryEvent({
			id: 'batch-evt-1',
			messageId: message.id,
			eventType: 'send_requested',
			provider: 'kody',
			createdAt: '2026-07-02T10:00:01.000Z',
			updatedAt: '2026-07-02T10:00:01.000Z',
		}),
		baseDeliveryEvent({
			id: 'batch-evt-2',
			messageId: message.id,
			eventType: 'sent',
			provider: 'kody',
			providerEventId: 'provider-batch-2',
			createdAt: '2026-07-02T10:00:02.000Z',
			updatedAt: '2026-07-02T10:00:02.000Z',
		}),
	]
	const first = await mailbox.upsertDeliveryEvents({
		ownerId: userId,
		events: batch,
	})
	expect(first).toEqual({
		results: [
			{ eventId: 'batch-evt-1', inserted: true, accepted: true },
			{ eventId: 'batch-evt-2', inserted: true, accepted: true },
		],
	})
	// Batch must not patch message latest delivery status.
	expect(await mailbox.getMessage({ messageId: message.id })).toMatchObject({
		deliveryStatus: 'delivered',
		deliveryStatusAt: '2026-07-02T10:00:00.000Z',
	})
	expect(
		new Set(
			(
				await mailbox.listDeliveryEvents({ messageId: message.id, limit: 10 })
			).map((event) => event.id),
		),
	).toEqual(new Set(['batch-evt-1', 'batch-evt-2']))

	const alarmAfterBatch = await runInDurableObject(
		stub,
		async (_instance: Mailbox, state) => state.storage.getAlarm(),
	)
	expect(alarmAfterBatch).toBeTypeOf('number')

	const replay = await mailbox.upsertDeliveryEvents({
		ownerId: userId,
		events: [
			batch[0]!,
			baseDeliveryEvent({
				id: 'batch-evt-2-dup',
				messageId: message.id,
				eventType: 'sent',
				provider: 'kody',
				providerEventId: 'provider-batch-2',
				createdAt: '2026-07-02T11:00:00.000Z',
				updatedAt: '2026-07-02T11:00:00.000Z',
			}),
		],
	})
	expect(replay).toEqual({
		results: [
			{ eventId: 'batch-evt-1', inserted: false, accepted: true },
			{ eventId: 'batch-evt-2-dup', inserted: false, accepted: false },
		],
	})

	await runInDurableObject(stub, async (instance: Mailbox) => {
		await assertMailboxThrows(/ownerId mismatch/, () =>
			instance.upsertDeliveryEvents({
				ownerId: otherUserId,
				events: [
					baseDeliveryEvent({
						id: 'batch-evt-other',
						messageId: message.id,
						eventType: 'sent',
						provider: 'kody',
					}),
				],
			}),
		)
	})

	// Transactionality: a mid-batch validation failure rolls back prior writes.
	const beforeCount = (await mailbox.countMailbox()).deliveryEvents
	await runInDurableObject(stub, async (instance: Mailbox) => {
		await assertMailboxThrows(/canonical ISO-8601/, () =>
			instance.upsertDeliveryEvents({
				ownerId: userId,
				events: [
					baseDeliveryEvent({
						id: 'batch-txn-ok',
						messageId: message.id,
						eventType: 'delivered',
						provider: 'kody',
						createdAt: '2026-07-02T12:00:00.000Z',
						updatedAt: '2026-07-02T12:00:00.000Z',
					}),
					baseDeliveryEvent({
						id: 'batch-txn-bad',
						messageId: message.id,
						eventType: 'delivered',
						provider: 'kody',
						createdAt: '2026-07-02T12:00:00Z',
						updatedAt: '2026-07-02T12:00:00Z',
					}),
				],
			}),
		)
	})
	expect((await mailbox.countMailbox()).deliveryEvents).toBe(beforeCount)
	expect(
		(
			await mailbox.listDeliveryEvents({ messageId: message.id, limit: 20 })
		).some((event) => event.id === 'batch-txn-ok'),
	).toBe(false)
})

test('Mailbox direct and batch delivery-event writes detach tombstoned messages', async () => {
	silenceIncidentalRuntimeWarnings()
	const userId = uniqueUserId('event-tombstone')
	const mailbox = rpcFor(userId)
	const messageId = 'event-tombstoned-message'
	await mailbox.tombstoneMissingMessage({
		ownerId: userId,
		messageId,
		deletedAt: '2026-08-02T20:00:00.000Z',
	})

	await expect(
		mailbox.upsertDeliveryEvent({
			ownerId: userId,
			event: baseDeliveryEvent({
				id: 'event-tombstone-direct',
				messageId,
			}),
		}),
	).resolves.toMatchObject({ inserted: true, accepted: true })
	await expect(
		mailbox.upsertDeliveryEvents({
			ownerId: userId,
			events: [
				baseDeliveryEvent({
					id: 'event-tombstone-batch',
					messageId,
					updatedAt: '2026-07-02T10:00:01.000Z',
				}),
			],
		}),
	).resolves.toMatchObject({
		results: [
			{ eventId: 'event-tombstone-batch', inserted: true, accepted: true },
		],
	})

	const events = await mailbox.listDeliveryEvents({ limit: 10 })
	expect(
		events
			.filter((event) => event.id.startsWith('event-tombstone-'))
			.map((event) => ({ id: event.id, messageId: event.messageId })),
	).toEqual(
		expect.arrayContaining([
			{ id: 'event-tombstone-batch', messageId: null },
			{ id: 'event-tombstone-direct', messageId: null },
		]),
	)
})
