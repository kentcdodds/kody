import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { mailboxDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { mailboxRpc, type MailboxEnv } from './mailbox-client.ts'
import {
	Mailbox,
	mailboxDeliveryEventRetentionDays,
	mailboxMessageRetentionDays,
	mailboxRetentionRetryDelayMs,
	type MailboxAttachmentInput,
	type MailboxMessageInput,
	type MailboxThreadInput,
} from './mailbox-do.ts'

function mailboxEnv(): MailboxEnv & { MAILBOX: DurableObjectNamespace } {
	const mailbox = (env as MailboxEnv).MAILBOX
	if (!mailbox) {
		throw new Error(
			'MAILBOX Durable Object binding is required for mailbox-do workers tests.',
		)
	}
	return { MAILBOX: mailbox }
}

function stubFor(userId: string) {
	const { MAILBOX } = mailboxEnv()
	return MAILBOX.get(MAILBOX.idFromName(mailboxDurableObjectName(userId)))
}

function rpcFor(userId: string) {
	return mailboxRpc({ env: mailboxEnv(), userId })
}

function uniqueUserId(label: string) {
	return `mailbox-${label}-${crypto.randomUUID()}`
}

async function assertMailboxThrows(
	pattern: RegExp,
	run: () => Promise<unknown>,
) {
	try {
		await run()
		throw new Error(`Expected mailbox RPC to throw matching ${pattern}`)
	} catch (error) {
		expect(String(error)).toMatch(pattern)
	}
}

function baseThread(
	overrides?: Partial<MailboxThreadInput>,
): MailboxThreadInput {
	const id = overrides?.id ?? crypto.randomUUID()
	const at = overrides?.lastMessageAt ?? '2026-07-01T12:00:00.000Z'
	return {
		id,
		inboxId: 'inbox-1',
		subjectNormalized: 'hello',
		rootMessageIdHeader: `<root-${id}@example.com>`,
		lastMessageAt: at,
		createdAt: at,
		updatedAt: at,
		...overrides,
	}
}

function baseMessage(
	overrides?: Partial<MailboxMessageInput>,
): MailboxMessageInput {
	const id = overrides?.id ?? crypto.randomUUID()
	const at = overrides?.createdAt ?? '2026-07-01T12:00:00.000Z'
	return {
		id,
		direction: 'inbound',
		inboxId: 'inbox-1',
		threadId: null,
		fromAddress: 'sender@example.com',
		envelopeFrom: 'envelope@example.com',
		toAddresses: ['owner@example.com'],
		subject: 'Hello mailbox',
		messageIdHeader: `<msg-${id}@example.com>`,
		rawMimeKey: `email-raw:v1:owner/${id}`,
		rawSize: 128,
		processingStatus: 'stored',
		classification: 'accepted',
		receivedAt: at,
		createdAt: at,
		updatedAt: at,
		...overrides,
	}
}

function baseAttachment(
	messageId: string,
	overrides?: Partial<MailboxAttachmentInput>,
): MailboxAttachmentInput {
	const id = overrides?.id ?? crypto.randomUUID()
	return {
		id,
		messageId,
		filename: 'note.txt',
		contentType: 'text/plain',
		size: 12,
		storageKind: 'external',
		storageKey: `email-attachment:v1:owner/${messageId}/${id}`,
		createdAt: '2026-07-01T12:00:00.000Z',
		...overrides,
	}
}

test('Mailbox mirrors, reads, searches, isolates owners, and stays idempotent', async () => {
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
						'email_attachments', 'email_delivery_events'
					)
				ORDER BY name ASC`,
			)
			.toArray()
			.map((row) => row.name)
		expect(tables).toEqual([
			'email_attachments',
			'email_delivery_events',
			'email_messages',
			'email_threads',
		])
		expect(await state.storage.getAlarm()).toBeNull()
	})

	const thread = baseThread({ id: 'thread-1' })
	const message = baseMessage({
		id: 'msg-1',
		threadId: thread.id,
		subject: 'Project update',
		fromAddress: 'alice@example.com',
	})
	const attachment = baseAttachment(message.id, { id: 'att-1' })

	await mailboxA.mirrorMessage({
		thread,
		message,
		attachments: [attachment],
	})
	await mailboxA.mirrorMessage({
		thread,
		message: { ...message, subject: 'Project update (edited)' },
		attachments: [attachment],
	})

	const stored = await mailboxA.getMessage({ messageId: message.id })
	expect(stored).toMatchObject({
		id: message.id,
		threadId: thread.id,
		subject: 'Project update (edited)',
		fromAddress: 'alice@example.com',
		rawMimeKey: message.rawMimeKey,
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

	await mailboxB.mirrorMessage({
		thread: baseThread({ id: 'thread-b' }),
		message: baseMessage({
			id: 'msg-b',
			threadId: 'thread-b',
			subject: 'Other owner',
		}),
	})
	expect(await mailboxB.getMessage({ messageId: message.id })).toBeNull()
	expect(await mailboxA.getMessage({ messageId: 'msg-b' })).toBeNull()
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
	await mailboxA.mirrorMessage({
		message: baseMessage({
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
})

test('Mailbox delivery status, promoted inbound fields, export paging, and cursor rejection', async () => {
	silenceIncidentalRuntimeWarnings()
	const userId = uniqueUserId('export')
	const mailbox = rpcFor(userId)

	const thread = baseThread({ id: 'export-thread' })
	const message = baseMessage({
		id: 'export-msg',
		threadId: thread.id,
		direction: 'outbound',
		providerMessageId: 'prov-export',
		processingStatus: 'sent',
		rawMimeKey: 'email-raw:v1:owner/export-msg',
		deliveryStatus: 'delivered',
		deliveryStatusAt: '2026-07-02T10:00:00.000Z',
	})
	const attachment = baseAttachment(message.id, {
		id: 'export-att',
		storageKey: 'email-attachment:v1:owner/export-msg/export-att',
	})
	await mailbox.mirrorMessage({
		thread,
		message,
		attachments: [attachment],
	})

	// Stale dual-write replay must not regress a newer delivery status.
	await mailbox.mirrorMessage({
		message: {
			...message,
			deliveryStatus: 'deferred',
			deliveryStatusAt: '2026-07-02T09:00:00.000Z',
		},
		attachments: [attachment],
	})
	expect(await mailbox.getMessage({ messageId: message.id })).toMatchObject({
		deliveryStatus: 'delivered',
		deliveryStatusAt: '2026-07-02T10:00:00.000Z',
	})

	// Equal timestamps may update (matches D1 <= semantics).
	await mailbox.mirrorMessage({
		message: {
			...message,
			deliveryStatus: 'complained',
			deliveryStatusAt: '2026-07-02T10:00:00.000Z',
		},
		attachments: [attachment],
	})
	expect(await mailbox.getMessage({ messageId: message.id })).toMatchObject({
		deliveryStatus: 'complained',
		deliveryStatusAt: '2026-07-02T10:00:00.000Z',
	})

	const first = await mailbox.upsertDeliveryEvent({
		event: {
			id: 'evt-1',
			messageId: message.id,
			eventType: 'delivered',
			provider: 'cloudflare-email',
			providerMessageId: 'prov-export',
			providerEventId: 'provider-event-1',
			createdAt: '2026-07-02T10:00:00.000Z',
			needsEffectReconcile: false,
		},
		latestDeliveryStatus: {
			messageId: message.id,
			deliveryStatus: 'delivered',
			deliveryStatusAt: '2026-07-02T10:30:00.000Z',
		},
	})
	expect(first).toEqual({ inserted: true, updatedLatestStatus: true })

	const inbound = await mailbox.upsertDeliveryEvent({
		event: {
			id: 'inbound-delivery-1',
			messageId: 'inbound-msg-1',
			inboxId: 'inbox-1',
			eventType: 'received',
			provider: 'cloudflare-email-routing',
			createdAt: '2026-07-02T11:00:00.000Z',
			needsEffectReconcile: true,
			state: 'received',
			fingerprint: 'fp-abc',
			storageLease: null,
			storageLeaseAt: null,
			cleanupLease: null,
			cleanupLeaseAt: null,
			expectedAttachmentCount: 2,
			finalizationToken: 'lease-token-1',
			usageStartedAt: '2026-07-02T10:59:00.000Z',
			usageMonth: '2026-07',
			usageBytes: 2048,
			usageDurationMs: 120,
			subscriptionEffectState: 'pending',
			subscriptionEffectRetryAt: '2026-07-02T12:00:00.000Z',
			detailJson: JSON.stringify({ recipient: 'owner@example.com' }),
		},
	})
	expect(inbound.inserted).toBe(true)
	const inboundRow = (
		await mailbox.listDeliveryEvents({
			messageId: 'inbound-msg-1',
			limit: 1,
		})
	)[0]
	expect(inboundRow).toMatchObject({
		id: 'inbound-delivery-1',
		needsEffectReconcile: true,
		state: 'received',
		fingerprint: 'fp-abc',
		expectedAttachmentCount: 2,
		finalizationToken: 'lease-token-1',
		usageStartedAt: '2026-07-02T10:59:00.000Z',
		usageMonth: '2026-07',
		usageBytes: 2048,
		subscriptionEffectState: 'pending',
		subscriptionEffectRetryAt: '2026-07-02T12:00:00.000Z',
	})
	expect(JSON.parse(inboundRow!.detailJson)).toMatchObject({
		recipient: 'owner@example.com',
	})

	// Default needsEffectReconcile is false unless explicitly true.
	await mailbox.upsertDeliveryEvent({
		event: {
			id: 'evt-default-reconcile',
			messageId: message.id,
			eventType: 'sent',
			provider: 'kody',
			createdAt: '2026-07-02T11:30:00.000Z',
		},
	})
	const defaultReconcile = (
		await mailbox.listDeliveryEvents({ messageId: message.id, limit: 20 })
	).find((event) => event.id === 'evt-default-reconcile')
	expect(defaultReconcile?.needsEffectReconcile).toBe(false)

	const duplicate = await mailbox.upsertDeliveryEvent({
		event: {
			id: 'evt-1-dup',
			messageId: message.id,
			eventType: 'delivered',
			provider: 'cloudflare-email',
			providerMessageId: 'prov-export',
			providerEventId: 'provider-event-1',
			createdAt: '2026-07-02T11:00:00.000Z',
		},
		latestDeliveryStatus: {
			messageId: message.id,
			deliveryStatus: 'delivered',
			deliveryStatusAt: '2026-07-02T11:00:00.000Z',
		},
	})
	expect(duplicate.inserted).toBe(false)

	const stale = await mailbox.upsertDeliveryEvent({
		event: {
			id: 'evt-2',
			messageId: message.id,
			eventType: 'deferred',
			provider: 'cloudflare-email',
			providerMessageId: 'prov-export',
			providerEventId: 'provider-event-2',
			createdAt: '2026-07-02T09:00:00.000Z',
		},
		latestDeliveryStatus: {
			messageId: message.id,
			deliveryStatus: 'deferred',
			deliveryStatusAt: '2026-07-02T09:00:00.000Z',
		},
	})
	expect(stale).toEqual({ inserted: true, updatedLatestStatus: false })
	expect(await mailbox.getMessage({ messageId: message.id })).toMatchObject({
		deliveryStatus: 'delivered',
		deliveryStatusAt: '2026-07-02T10:30:00.000Z',
	})

	// Assert validation failures inside the DO isolate so remote RPC error
	// plumbing does not surface uncaught worker exceptions.
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
			instance.mirrorMessage({
				message: baseMessage({
					id: 'bad-iso',
					createdAt: '2026-07-01T12:00:00Z',
				}),
			}),
		)
	})

	const kinds: Array<string> = []
	let startAfter: string | null = null
	for (let page = 0; page < 30; page += 1) {
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
					expect(row.row.id).toBe(message.id)
					break
				case 'attachment':
					expect(row.row.id).toBe(attachment.id)
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
	expect(kinds.filter((kind) => kind === 'message')).toHaveLength(1)
	expect(kinds.filter((kind) => kind === 'attachment')).toHaveLength(1)
	expect(
		kinds.filter((kind) => kind === 'delivery_event').length,
	).toBeGreaterThanOrEqual(3)

	const blobKinds: Array<string> = []
	let blobCursor: string | null = null
	for (let page = 0; page < 10; page += 1) {
		const pageResult = await mailbox.listBlobReferences({
			pageSize: 1,
			startAfter: blobCursor,
		})
		for (const reference of pageResult.references) {
			blobKinds.push(reference.kind)
			if (reference.kind === 'raw_mime') {
				expect(reference.key).toBe(message.rawMimeKey)
				expect(reference.messageId).toBe(message.id)
			} else {
				expect(reference.key).toBe(attachment.storageKey)
				expect(reference.attachmentId).toBe(attachment.id)
			}
		}
		if (!pageResult.truncated) break
		expect(pageResult.nextStartAfter).not.toBe(blobCursor)
		blobCursor = pageResult.nextStartAfter
	}
	expect(blobKinds).toEqual(['raw_mime', 'attachment'])

	await mailbox.purge()
	expect(await mailbox.countMailbox()).toEqual({
		threads: 0,
		messages: 0,
		attachments: 0,
		deliveryEvents: 0,
	})
})

test('Mailbox retention deletes R2 blobs before metadata and backs off on failure', async () => {
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

	const keepMessage = baseMessage({
		id: 'keep-msg',
		subject: 'fresh',
		createdAt: freshAt,
		updatedAt: freshAt,
		rawMimeKey: 'email-raw:v1:owner/keep-msg',
	})
	const dropMessage = baseMessage({
		id: 'drop-msg',
		threadId: 'drop-thread',
		subject: 'old',
		createdAt: oldMessageAt,
		updatedAt: oldMessageAt,
		rawMimeKey: 'email-raw:v1:owner/drop-msg',
	})
	const failMessage = baseMessage({
		id: 'fail-msg',
		subject: 'fail-old',
		createdAt: oldMessageAt,
		updatedAt: oldMessageAt,
		rawMimeKey: 'email-raw:v1:owner/fail-msg',
	})
	const dropAttachment = baseAttachment(dropMessage.id, {
		id: 'drop-att',
		storageKey: 'email-attachment:v1:owner/drop-msg/drop-att',
		createdAt: oldMessageAt,
	})

	await mailbox.mirrorMessage({
		thread: baseThread({
			id: 'drop-thread',
			lastMessageAt: oldMessageAt,
			createdAt: oldMessageAt,
			updatedAt: oldMessageAt,
		}),
		message: dropMessage,
		attachments: [dropAttachment],
	})
	await mailbox.mirrorMessage({ message: keepMessage })
	await mailbox.mirrorMessage({ message: failMessage })
	await mailbox.upsertDeliveryEvent({
		event: {
			id: 'old-event',
			messageId: keepMessage.id,
			eventType: 'received',
			provider: 'kody',
			createdAt: oldEventAt,
			needsEffectReconcile: false,
		},
	})
	await mailbox.upsertDeliveryEvent({
		event: {
			id: 'fresh-event',
			messageId: keepMessage.id,
			eventType: 'received',
			provider: 'kody',
			createdAt: freshAt,
			needsEffectReconcile: false,
		},
	})

	await env.EMAIL_BLOBS.put(dropMessage.rawMimeKey!, 'drop-raw')
	await env.EMAIL_BLOBS.put(dropAttachment.storageKey!, 'drop-att')
	await env.EMAIL_BLOBS.put(failMessage.rawMimeKey!, 'fail-raw')
	await env.EMAIL_BLOBS.put(keepMessage.rawMimeKey!, 'keep-raw')

	const originalDelete = env.EMAIL_BLOBS.delete.bind(env.EMAIL_BLOBS)
	env.EMAIL_BLOBS.delete = (async (keys: string | Array<string>) => {
		const list = Array.isArray(keys) ? keys : [keys]
		if (list.includes(failMessage.rawMimeKey!)) {
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

		expect(await env.EMAIL_BLOBS.get(dropMessage.rawMimeKey!)).toBeNull()
		expect(await env.EMAIL_BLOBS.get(dropAttachment.storageKey!)).toBeNull()
		expect(await env.EMAIL_BLOBS.get(failMessage.rawMimeKey!)).not.toBeNull()
		expect(await env.EMAIL_BLOBS.get(keepMessage.rawMimeKey!)).not.toBeNull()

		expect(await mailbox.getMessage({ messageId: dropMessage.id })).toBeNull()
		expect(
			await mailbox.listAttachmentsForMessage({ messageId: dropMessage.id }),
		).toHaveLength(0)
		expect(await mailbox.getThread({ threadId: 'drop-thread' })).toBeNull()
		expect(
			await mailbox.getMessage({ messageId: failMessage.id }),
		).toMatchObject({
			id: failMessage.id,
			rawMimeKey: failMessage.rawMimeKey,
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
	expect(await env.EMAIL_BLOBS.get(failMessage.rawMimeKey!)).toBeNull()
	expect(await mailbox.getMessage({ messageId: failMessage.id })).toBeNull()
})
