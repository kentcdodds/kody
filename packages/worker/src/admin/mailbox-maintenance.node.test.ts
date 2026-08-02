import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { systemEmailOwnerId } from '#worker/email/email-owner.ts'
import * as EmailRepo from '#worker/email/repo.ts'
import {
	deleteEmailMessageById,
	emailAttachmentBlobKey,
	emailRawMimeKey,
	getEmailMessageById,
} from '#worker/email/repo.ts'
import {
	mailboxReadCutoverCheckedAtMaxAgeMs,
	mailboxReadCutoverSoakMs,
} from '#worker/email/mailbox-read-cutover.ts'
import { emailMessageRetentionDays } from '#app/retention.ts'
import type * as RetentionModule from '#app/retention.ts'
import type * as MailboxClientModule from '#worker/email/mailbox-client.ts'
import type * as MailboxReconcileModule from '#worker/email/mailbox-reconcile.ts'
import type * as SystemEmailGraphRepoModule from '#worker/email/system-email-graph-repo.ts'

const mocks = vi.hoisted(() => ({
	reconcileMailboxParity: vi.fn(),
	mailboxRpc: vi.fn(),
	pruneUserEmailMessagesForRetention: vi.fn(),
	pruneEmailDeliveryEventsForRetention: vi.fn(),
	loadSystemEmailGraphParityReport: vi.fn(),
	reconcileSystemEmailGraphFromLegacy: vi.fn(),
}))

vi.mock('#worker/email/mailbox-reconcile.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MailboxReconcileModule>()
	return {
		...actual,
		reconcileMailboxParity: mocks.reconcileMailboxParity,
	}
})

vi.mock('#worker/email/mailbox-client.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MailboxClientModule>()
	return {
		...actual,
		mailboxRpc: mocks.mailboxRpc,
	}
})

vi.mock('#app/retention.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof RetentionModule>()
	return {
		...actual,
		pruneUserEmailMessagesForRetention:
			mocks.pruneUserEmailMessagesForRetention,
		pruneEmailDeliveryEventsForRetention:
			mocks.pruneEmailDeliveryEventsForRetention,
	}
})

vi.mock('#worker/email/system-email-graph-repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof SystemEmailGraphRepoModule>()
	return {
		...actual,
		loadSystemEmailGraphParityReport: mocks.loadSystemEmailGraphParityReport,
		reconcileSystemEmailGraphFromLegacy:
			mocks.reconcileSystemEmailGraphFromLegacy,
	}
})

const {
	adminEmailRetentionCutoffIso,
	adminMailboxMaintenanceMaxBatchSize,
	adminMailboxMaintenanceRetentionConcurrency,
	adminMailboxMaintenanceRetentionMaxLimit,
	listUsersForAdminMailboxRetention,
	loadAdminMailboxMaintenanceStatus,
	AdminMailboxMessageNotFoundError,
	runAdminMailboxMaintenanceDeleteMessage,
	runAdminMailboxMaintenanceReconcile,
	runAdminMailboxMaintenanceRetention,
} = await import('./mailbox-maintenance.ts')

const now = new Date('2026-08-01T12:00:00.000Z')
const freshCreatedAt = now.toISOString()

function mockMailboxDeleteFromD1(
	db: D1Database,
	blobs: Pick<R2Bucket, 'delete'>,
) {
	mocks.mailboxRpc.mockImplementation(({ userId }: { userId: string }) => ({
		tombstoneMissingMessage: async ({ ownerId }: { ownerId: string }) => {
			if (ownerId !== userId) throw new Error('Mailbox ownerId mismatch')
			return { status: 'tombstoned' as const, created: true }
		},
		deleteMessageWithBlobs: async ({
			ownerId,
			messageId,
		}: {
			ownerId: string
			messageId: string
		}) => {
			if (ownerId !== userId) throw new Error('Mailbox ownerId mismatch')
			const message = await EmailRepo.getEmailMessageById({
				db,
				userId,
				messageId,
			})
			if (!message) {
				return { status: 'missing' as const, tombstoned: false }
			}
			const attachments = await EmailRepo.listEmailAttachmentsForUserMessage({
				db,
				userId,
				messageId,
			})
			const blobReferences = [
				...(message.direction === 'inbound'
					? [
							{
								kind: 'raw_mime' as const,
								key: emailRawMimeKey(userId, messageId),
								messageId,
								attachmentId: null,
							},
						]
					: []),
				...attachments.flatMap((attachment) => {
					if (attachment.storageKind !== 'external') return []
					const expected = emailAttachmentBlobKey(
						userId,
						messageId,
						attachment.id,
					)
					return attachment.storageKey === expected
						? [
								{
									kind: 'attachment' as const,
									key: expected,
									messageId,
									attachmentId: attachment.id,
								},
							]
						: []
				}),
			]
			await blobs.delete(blobReferences.map((reference) => reference.key))
			return {
				status: 'deleted' as const,
				attachmentsSeen: attachments.length,
				externalAttachmentsSeen: attachments.filter(
					(attachment) => attachment.storageKind === 'external',
				).length,
				blobReferences,
			}
		},
	}))
}

function createMaintenanceDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			stable_user_id TEXT UNIQUE NOT NULL,
			username TEXT NOT NULL,
			email TEXT NOT NULL,
			deleting_at TEXT,
			mailbox_parity_checked_at TEXT,
			mailbox_parity_matching_since TEXT,
			mailbox_parity_mismatch_count INTEGER NOT NULL DEFAULT 0,
			mailbox_parity_last_error TEXT,
			mailbox_parity_content_watermark_at TEXT,
			mailbox_parity_content_replay_upper_at TEXT,
			mailbox_parity_content_replay_cursor_id TEXT,
			mailbox_parity_message_backfill_cursor_id TEXT,
			mailbox_parity_message_backfill_completed_at TEXT,
			mailbox_parity_event_backfill_cursor_id TEXT,
			mailbox_parity_event_backfill_completed_at TEXT,
			created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
			updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
		);
		CREATE TABLE email_messages (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			direction TEXT NOT NULL DEFAULT 'inbound',
			provider_message_id TEXT,
			inbox_id TEXT,
			created_at TEXT NOT NULL DEFAULT '${freshCreatedAt}'
		);
		CREATE TABLE email_outbound_provider_index (
			provider TEXT NOT NULL,
			provider_message_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			inbox_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (provider, provider_message_id),
			FOREIGN KEY (message_id) REFERENCES email_messages(id) ON DELETE CASCADE
		);
		CREATE TABLE email_delivery_events (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT '${freshCreatedAt}'
		);
	`)
	sqlite.exec('PRAGMA foreign_keys = ON')
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function insertEmailMessage(
	sqlite: DatabaseSync,
	input: { id: string; userId: string; createdAt?: string },
) {
	sqlite
		.prepare(
			`INSERT INTO email_messages (id, user_id, created_at) VALUES (?, ?, ?)`,
		)
		.run(input.id, input.userId, input.createdAt ?? freshCreatedAt)
}

function insertTrackedUser(
	sqlite: DatabaseSync,
	input: {
		email: string
		checkedAt?: string | null
		matchingSince?: string | null
		mismatchCount?: number
		lastError?: string | null
		messagesCompletedAt?: string | null
		eventsCompletedAt?: string | null
		contentReplayUpperAt?: string | null
		deletingAt?: string | null
		stableUserId?: string
	},
) {
	const stableUserId =
		input.stableUserId ?? testStableUserIdFromEmail(input.email)
	sqlite
		.prepare(
			`INSERT INTO users (
				stable_user_id, username, email, deleting_at,
				mailbox_parity_checked_at, mailbox_parity_matching_since,
				mailbox_parity_mismatch_count, mailbox_parity_last_error,
				mailbox_parity_message_backfill_completed_at,
				mailbox_parity_event_backfill_completed_at,
				mailbox_parity_content_replay_upper_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			stableUserId,
			input.email.split('@')[0] ?? 'user',
			input.email,
			input.deletingAt ?? null,
			input.checkedAt ?? null,
			input.matchingSince ?? null,
			input.mismatchCount ?? 0,
			input.lastError ?? null,
			input.messagesCompletedAt ?? null,
			input.eventsCompletedAt ?? null,
			input.contentReplayUpperAt ?? null,
		)
	return stableUserId
}

function stubD1Prune() {
	mocks.pruneUserEmailMessagesForRetention.mockResolvedValue({
		deletedMessages: 2,
		deletedAttachments: 1,
		deletedThreads: 1,
		deletedRawMimeBlobs: 2,
		deletedAttachmentBlobs: 1,
		blobDeleteErrors: 0,
		hasMore: false,
		nextCursor: null,
	})
	mocks.pruneEmailDeliveryEventsForRetention.mockResolvedValue({
		selected: 3,
		deleted: 3,
	})
}

function envFor(db: D1Database) {
	return {
		APP_DB: db,
		MAILBOX: {},
		EMAIL_BLOBS: {
			delete: vi.fn(async () => undefined),
			head: vi.fn(async () => null),
		},
	} as unknown as Env
}

function createMemoryEmailBlobs() {
	const objects = new Map<string, Uint8Array>()
	return {
		objects,
		blobs: {
			async put(key: string, value: string | ArrayBuffer | ArrayBufferView) {
				const bytes =
					typeof value === 'string'
						? new TextEncoder().encode(value)
						: value instanceof ArrayBuffer
							? new Uint8Array(value)
							: new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
				objects.set(key, bytes)
				return { key } as R2Object
			},
			async delete(key: string | Array<string>) {
				for (const entry of Array.isArray(key) ? key : [key]) {
					objects.delete(entry)
				}
			},
			async head(key: string) {
				return objects.has(key) ? ({ key } as R2Object) : null
			},
		} satisfies Pick<R2Bucket, 'put' | 'delete' | 'head'>,
	}
}

function createDeleteMessageDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE email_messages (
			id TEXT PRIMARY KEY,
			direction TEXT NOT NULL,
			user_id TEXT NOT NULL,
			inbox_id TEXT,
			thread_id TEXT,
			from_address TEXT NOT NULL,
			subject TEXT NOT NULL DEFAULT '',
			processing_status TEXT NOT NULL,
			raw_mime_key TEXT,
			text_body TEXT,
			html_body TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE email_outbound_provider_index (
			provider TEXT NOT NULL,
			provider_message_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			inbox_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (provider, provider_message_id),
			FOREIGN KEY (message_id) REFERENCES email_messages(id) ON DELETE CASCADE
		);
		CREATE TABLE email_attachments (
			id TEXT PRIMARY KEY,
			message_id TEXT NOT NULL,
			filename TEXT,
			content_type TEXT NOT NULL,
			size INTEGER NOT NULL DEFAULT 0,
			storage_kind TEXT NOT NULL,
			storage_key TEXT,
			created_at TEXT NOT NULL
		);
	`)
	sqlite.exec('PRAGMA foreign_keys = ON')
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

async function seedOwnedMessageWithBlobs(input: {
	sqlite: DatabaseSync
	blobs: Pick<R2Bucket, 'put'>
	userId: string
	messageId: string
	attachmentId: string
	includeBody?: boolean
}) {
	const rawKey = emailRawMimeKey(input.userId, input.messageId)
	const attachmentKey = emailAttachmentBlobKey(
		input.userId,
		input.messageId,
		input.attachmentId,
	)
	input.sqlite
		.prepare(
			`INSERT INTO email_messages (
				id, direction, user_id, from_address, subject, processing_status,
				raw_mime_key, text_body, html_body, created_at, updated_at
			) VALUES (?, 'inbound', ?, 'sender@example.net', 'Subject', 'stored', ?, ?, ?, ?, ?)`,
		)
		.run(
			input.messageId,
			input.userId,
			rawKey,
			input.includeBody === false ? null : 'secret body',
			null,
			freshCreatedAt,
			freshCreatedAt,
		)
	input.sqlite
		.prepare(
			`INSERT INTO email_attachments (
				id, message_id, filename, content_type, size, storage_kind,
				storage_key, created_at
			) VALUES (?, ?, 'note.txt', 'text/plain', 4, 'external', ?, ?)`,
		)
		.run(input.attachmentId, input.messageId, attachmentKey, freshCreatedAt)
	input.sqlite
		.prepare(
			`INSERT INTO email_attachments (
				id, message_id, filename, content_type, size, storage_kind,
				storage_key, created_at
			) VALUES (?, ?, 'inline.png', 'image/png', 0, 'raw-mime', NULL, ?)`,
		)
		.run(`inline-${input.attachmentId}`, input.messageId, freshCreatedAt)
	await input.blobs.put(rawKey, 'raw-mime-bytes')
	await input.blobs.put(attachmentKey, 'att')
	return { rawKey, attachmentKey }
}

test('loadAdminMailboxMaintenanceStatus aggregates buckets without owner ids', async () => {
	const { sqlite, db } = createMaintenanceDb()
	mocks.loadSystemEmailGraphParityReport.mockResolvedValue({
		threads: {
			legacyCount: 1,
			dedicatedCount: 1,
			missingFromDedicatedCount: 0,
			missingFromLegacyCount: 0,
			ownershipMismatchCount: 0,
			referencedOwnerMismatchCount: 0,
			relationshipMismatchCount: 0,
			keyFieldMismatchCount: 0,
			parity: true,
		},
		messages: {
			legacyCount: 2,
			dedicatedCount: 2,
			missingFromDedicatedCount: 0,
			missingFromLegacyCount: 0,
			ownershipMismatchCount: 0,
			referencedOwnerMismatchCount: 0,
			relationshipMismatchCount: 0,
			keyFieldMismatchCount: 0,
			parity: true,
		},
		attachments: {
			legacyCount: 1,
			dedicatedCount: 1,
			missingFromDedicatedCount: 0,
			missingFromLegacyCount: 0,
			ownershipMismatchCount: 0,
			referencedOwnerMismatchCount: 0,
			relationshipMismatchCount: 0,
			keyFieldMismatchCount: 0,
			parity: true,
		},
		deliveryEvents: {
			legacyCount: 1,
			dedicatedCount: 1,
			missingFromDedicatedCount: 0,
			missingFromLegacyCount: 0,
			ownershipMismatchCount: 0,
			referencedOwnerMismatchCount: 0,
			relationshipMismatchCount: 0,
			keyFieldMismatchCount: 0,
			parity: true,
		},
		outboundProviderIndex: {
			legacyProviderLinkedMessageCount: 0,
			dedicatedProviderLinkedMessageCount: 0,
			legacyAuthorityIndexCount: 0,
			missingFromLegacyAuthorityIndexCount: 0,
			missingFromLegacyMessagesCount: 0,
			mismatchedLegacyAuthorityIndexCount: 0,
			classification: 'no-system-provider-links',
			authorityDisposition: 'legacy-email-messages-until-4b-routing',
			parity: true,
		},
		parity: true,
	})
	const matchingSince = new Date(
		now.getTime() - mailboxReadCutoverSoakMs - 60_000,
	).toISOString()
	const freshCheckedAt = new Date(
		now.getTime() - mailboxReadCutoverCheckedAtMaxAgeMs / 2,
	).toISOString()
	const incompleteCheckedAt = '2026-07-01T00:00:00.000Z'

	insertTrackedUser(sqlite, {
		email: 'matching@example.com',
		matchingSince,
		checkedAt: freshCheckedAt,
		messagesCompletedAt: matchingSince,
		eventsCompletedAt: matchingSince,
	})
	insertTrackedUser(sqlite, {
		email: 'mismatch@example.com',
		checkedAt: incompleteCheckedAt,
		mismatchCount: 2,
	})
	insertTrackedUser(sqlite, {
		email: 'error@example.com',
		checkedAt: incompleteCheckedAt,
		lastError: 'countMailbox timed out',
	})
	insertTrackedUser(sqlite, {
		email: 'incomplete@example.com',
		checkedAt: incompleteCheckedAt,
		messagesCompletedAt: null,
	})
	insertTrackedUser(sqlite, {
		email: 'deleting@example.com',
		checkedAt: freshCheckedAt,
		matchingSince,
		deletingAt: now.toISOString(),
		messagesCompletedAt: matchingSince,
		eventsCompletedAt: matchingSince,
	})
	insertTrackedUser(sqlite, {
		email: 'system@example.com',
		stableUserId: systemEmailOwnerId,
		checkedAt: freshCheckedAt,
		matchingSince,
		messagesCompletedAt: matchingSince,
		eventsCompletedAt: matchingSince,
	})

	sqlite.exec(`
		INSERT INTO email_messages (
			id, user_id, direction, provider_message_id, created_at
		) VALUES
			('linked-1', 'user-linked', 'outbound', 'prov-1', '${freshCreatedAt}');
		INSERT INTO email_outbound_provider_index (
			provider, provider_message_id, user_id, message_id, inbox_id,
			created_at, updated_at
		) VALUES
			('cloudflare-email', 'prov-1', 'user-linked', 'linked-1', NULL,
				'${freshCreatedAt}', '${freshCreatedAt}');
	`)

	const status = await loadAdminMailboxMaintenanceStatus({ db, now })
	expect(status).toMatchObject({
		generatedAt: now.toISOString(),
		trackedOwners: 4,
		matching: 1,
		mismatch: 1,
		error: 1,
		incomplete: 1,
		eligible: 1,
		outboundProviderIndex: {
			linkedMessageCount: 1,
			indexCount: 1,
			missingFromIndexCount: 0,
			missingFromMessagesCount: 0,
			mismatchedCount: 0,
			parity: true,
		},
		systemEmailGraph: {
			threads: { legacyCount: 1, dedicatedCount: 1, parity: true },
			messages: { legacyCount: 2, dedicatedCount: 2, parity: true },
			attachments: { legacyCount: 1, dedicatedCount: 1, parity: true },
			deliveryEvents: { legacyCount: 1, dedicatedCount: 1, parity: true },
			outboundProviderIndex: {
				classification: 'no-system-provider-links',
				authorityDisposition: 'legacy-email-messages-until-4b-routing',
				parity: true,
			},
			parity: true,
		},
	})
	expect(status).not.toHaveProperty('outboundProviderIndex.sampleMismatches')
	expect(JSON.stringify(status.outboundProviderIndex)).not.toMatch(/@|prov-1/u)
	expect(JSON.stringify(status.systemEmailGraph)).not.toMatch(/@|prov-1/u)
})

test('runAdminMailboxMaintenanceReconcile clamps batch_size and returns status', async () => {
	const { db } = createMaintenanceDb()
	mocks.reconcileMailboxParity.mockResolvedValue({
		scanned: 1,
		backfilled: 0,
		compared: 1,
		matched: 1,
		mismatched: 0,
		failed: 0,
	})
	const result = await runAdminMailboxMaintenanceReconcile({
		env: envFor(db),
		batchSize: 10_000,
		now,
	})
	expect(mocks.reconcileMailboxParity).toHaveBeenCalledWith({
		env: expect.anything(),
		now,
		batchSize: adminMailboxMaintenanceMaxBatchSize,
	})
	expect(result.metrics.matched).toBe(1)
})

test('retention discovery is stable_user_id keyset ordered, not parity checked_at', async () => {
	const { sqlite, db } = createMaintenanceDb()
	// Lexicographically: aaa... < fff... but checked_at would reverse them.
	const laterChecked = insertTrackedUser(sqlite, {
		email: 'a-owner@example.com',
		stableUserId: 'a'.repeat(64),
		checkedAt: '2026-07-20T00:00:00.000Z',
	})
	const earlierChecked = insertTrackedUser(sqlite, {
		email: 'f-owner@example.com',
		stableUserId: 'f'.repeat(64),
		checkedAt: '2026-07-01T00:00:00.000Z',
	})
	insertEmailMessage(sqlite, { id: 'm1', userId: laterChecked })
	insertEmailMessage(sqlite, { id: 'm2', userId: earlierChecked })

	const firstPage = await listUsersForAdminMailboxRetention({
		db,
		limit: 1,
	})
	expect(firstPage.map((row) => row.userId)).toEqual([laterChecked])
	const secondPage = await listUsersForAdminMailboxRetention({
		db,
		limit: 1,
		startAfterUserId: laterChecked,
	})
	expect(secondPage.map((row) => row.userId)).toEqual([earlierChecked])
	const afterLast = await listUsersForAdminMailboxRetention({
		db,
		limit: 1,
		startAfterUserId: earlierChecked,
	})
	expect(afterLast).toEqual([])
})

test('retention runs D1 prune before DO, pages by cursor, isolates failures', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createMaintenanceDb()
	const callOrder: Array<string> = []
	const ownerA = 'a'.repeat(64)
	const ownerB = 'b'.repeat(64)
	const ownerC = 'c'.repeat(64)
	for (const [id, email] of [
		[ownerA, 'a@example.com'],
		[ownerB, 'b@example.com'],
		[ownerC, 'c@example.com'],
	] as const) {
		insertTrackedUser(sqlite, {
			email,
			stableUserId: id,
			checkedAt: '2026-07-01T00:00:00.000Z',
		})
		insertEmailMessage(sqlite, { id: `m-${id.slice(0, 4)}`, userId: id })
	}

	mocks.pruneUserEmailMessagesForRetention.mockImplementation(async () => {
		callOrder.push('d1-messages')
		return {
			deletedMessages: 2,
			deletedAttachments: 1,
			deletedThreads: 0,
			deletedRawMimeBlobs: 2,
			deletedAttachmentBlobs: 1,
			blobDeleteErrors: 1,
			hasMore: false,
			nextCursor: null,
		}
	})
	mocks.pruneEmailDeliveryEventsForRetention.mockImplementation(async () => {
		callOrder.push('d1-events')
		return { selected: 4, deleted: 4 }
	})

	const runRetentionNow = vi.fn(async ({ ownerId }: { ownerId: string }) => {
		callOrder.push(`do:${ownerId.slice(0, 1)}`)
		if (ownerId === ownerB) throw new Error('mailbox unavailable')
		return {
			before: {
				threads: 1,
				messages: 2,
				attachments: 1,
				deliveryEvents: 1,
			},
			after: {
				threads: 0,
				messages: 1,
				attachments: 0,
				deliveryEvents: 0,
			},
			blobDeleteFailures: false,
			expiredRemaining: false,
		}
	})
	mocks.mailboxRpc.mockImplementation(({ userId }: { userId: string }) => {
		callOrder.push(`rpc:${userId.slice(0, 1)}`)
		return { runRetentionNow: () => runRetentionNow({ ownerId: userId }) }
	})

	const first = await runAdminMailboxMaintenanceRetention({
		env: envFor(db),
		limit: 2,
		now,
	})
	expect(callOrder.slice(0, 2)).toEqual(['d1-messages', 'd1-events'])
	expect(callOrder.indexOf('d1-messages')).toBeLessThan(
		callOrder.findIndex((entry) => entry.startsWith('rpc:')),
	)
	expect(first.truncated).toBe(true)
	expect(first.nextStartAfter).toBe(ownerB)
	expect(first.metrics.d1).toEqual({
		messagesDeleted: 2,
		attachmentsDeleted: 1,
		threadsDeleted: 0,
		deliveryEventsDeleted: 4,
		rawMimeBlobsDeleted: 2,
		attachmentBlobsDeleted: 1,
		blobDeleteErrors: 1,
	})
	expect(first.metrics.mailbox.ownersAttempted).toBe(2)
	expect(first.metrics.mailbox.ownersSucceeded).toBe(1)
	expect(first.metrics.mailbox.ownersFailed).toBe(1)
	expect(first.metrics.mailbox.pendingD1Owners).toBe(0)
	expect(first.metrics.mailbox.before).toEqual({
		threads: 1,
		messages: 2,
		attachments: 1,
		deliveryEvents: 1,
	})
	expect(first.metrics.mailbox.after).toEqual({
		threads: 0,
		messages: 1,
		attachments: 0,
		deliveryEvents: 0,
	})
	expect(JSON.stringify(first)).not.toContain('mailbox unavailable')

	callOrder.length = 0
	stubD1Prune()
	mocks.pruneUserEmailMessagesForRetention.mockImplementation(async () => {
		callOrder.push('d1-messages')
		return {
			deletedMessages: 0,
			deletedAttachments: 0,
			deletedThreads: 0,
			deletedRawMimeBlobs: 0,
			deletedAttachmentBlobs: 0,
			blobDeleteErrors: 0,
			hasMore: false,
			nextCursor: null,
		}
	})
	mocks.pruneEmailDeliveryEventsForRetention.mockImplementation(async () => {
		callOrder.push('d1-events')
		return { selected: 0, deleted: 0 }
	})

	const second = await runAdminMailboxMaintenanceRetention({
		env: envFor(db),
		limit: 2,
		startAfterUserId: first.nextStartAfter,
		now,
	})
	expect(second.metrics.mailbox.ownersAttempted).toBe(1)
	expect(second.metrics.mailbox.ownersSucceeded).toBe(1)
	expect(second.truncated).toBe(false)
	expect(second.nextStartAfter).toBeNull()
	expect(runRetentionNow.mock.calls.map((call) => call[0]?.ownerId)).toEqual([
		ownerA,
		ownerB,
		ownerC,
	])
})

test('retention concurrency stays at most 4 and budget truncates with cursor', async () => {
	consoleWarn.mockImplementation(() => {})
	stubD1Prune()
	const { sqlite, db } = createMaintenanceDb()
	const owners = Array.from({ length: 8 }, (_, index) => {
		const id = `${index.toString(16).padStart(2, '0')}${'a'.repeat(62)}`
		insertTrackedUser(sqlite, {
			email: `u${index}@example.com`,
			stableUserId: id,
			checkedAt: '2026-07-01T00:00:00.000Z',
		})
		insertEmailMessage(sqlite, { id: `m${index}`, userId: id })
		return id
	}).sort()

	const emptyCounts = {
		threads: 0,
		messages: 0,
		attachments: 0,
		deliveryEvents: 0,
	}
	let inFlight = 0
	let maxInFlight = 0
	let scheduled = 0
	mocks.mailboxRpc.mockImplementation(() => {
		scheduled += 1
		return {
			runRetentionNow: async () => {
				inFlight += 1
				maxInFlight = Math.max(maxInFlight, inFlight)
				await Promise.resolve()
				inFlight -= 1
				return {
					before: emptyCounts,
					after: emptyCounts,
					blobDeleteFailures: false,
					expiredRemaining: false,
				}
			},
		}
	})

	const result = await runAdminMailboxMaintenanceRetention({
		env: envFor(db),
		limit: adminMailboxMaintenanceRetentionMaxLimit,
		now,
		budgetMs: 100,
		// After the first concurrency window is scheduled, expire the budget so
		// no further owners are launched.
		nowMs: () =>
			scheduled >= adminMailboxMaintenanceRetentionConcurrency ? 1_000 : 0,
	})

	expect(maxInFlight).toBeLessThanOrEqual(
		adminMailboxMaintenanceRetentionConcurrency,
	)
	expect(maxInFlight).toBe(adminMailboxMaintenanceRetentionConcurrency)
	expect(result.metrics.mailbox.ownersAttempted).toBe(
		adminMailboxMaintenanceRetentionConcurrency,
	)
	expect(result.truncated).toBe(true)
	expect(result.nextStartAfter).toBe(
		owners[adminMailboxMaintenanceRetentionConcurrency - 1],
	)
	expect(result.metrics.mailbox.ownersAttempted).toBeLessThan(owners.length)
	expect(result.metrics.mailbox.pendingD1Owners).toBe(0)
})

test('retention skips DO while owner still has expired D1 rows omitted by global batch', async () => {
	stubD1Prune()
	const { sqlite, db } = createMaintenanceDb()
	const pendingOwner = 'a'.repeat(64)
	const clearOwner = 'b'.repeat(64)
	insertTrackedUser(sqlite, {
		email: 'pending@example.com',
		stableUserId: pendingOwner,
		checkedAt: '2026-07-01T00:00:00.000Z',
	})
	insertTrackedUser(sqlite, {
		email: 'clear@example.com',
		stableUserId: clearOwner,
		checkedAt: '2026-07-01T00:00:00.000Z',
	})
	const expiredCreatedAt = adminEmailRetentionCutoffIso(
		now,
		emailMessageRetentionDays + 1,
	)
	// Expired row remains after mocked global prune (oldest-batch omitted this owner).
	insertEmailMessage(sqlite, {
		id: 'expired-pending',
		userId: pendingOwner,
		createdAt: expiredCreatedAt,
	})
	insertEmailMessage(sqlite, {
		id: 'fresh-clear',
		userId: clearOwner,
		createdAt: freshCreatedAt,
	})

	const runRetentionNow = vi.fn(async () => ({
		before: {
			threads: 1,
			messages: 1,
			attachments: 0,
			deliveryEvents: 0,
		},
		after: {
			threads: 0,
			messages: 0,
			attachments: 0,
			deliveryEvents: 0,
		},
		blobDeleteFailures: false,
		expiredRemaining: false,
	}))
	mocks.mailboxRpc.mockImplementation(({ userId }: { userId: string }) => ({
		runRetentionNow: () => runRetentionNow({ ownerId: userId }),
	}))

	const first = await runAdminMailboxMaintenanceRetention({
		env: envFor(db),
		limit: 2,
		now,
	})
	expect(first.metrics.mailbox.pendingD1Owners).toBe(1)
	expect(first.metrics.mailbox.ownersAttempted).toBe(1)
	expect(first.metrics.mailbox.ownersSucceeded).toBe(1)
	expect(runRetentionNow).toHaveBeenCalledTimes(1)
	expect(runRetentionNow).toHaveBeenCalledWith({ ownerId: clearOwner })
	// Cursor still advanced past the pending owner so global D1 batches can drain.
	expect(first.nextStartAfter).toBe(clearOwner)
	expect(first.truncated).toBe(true)

	// After D1 clears the omitted expired row, DO retention runs for that owner.
	sqlite
		.prepare(`DELETE FROM email_messages WHERE id = ?`)
		.run('expired-pending')
	const second = await runAdminMailboxMaintenanceRetention({
		env: envFor(db),
		limit: 2,
		startAfterUserId: null,
		now,
	})
	expect(second.metrics.mailbox.pendingD1Owners).toBe(0)
	expect(second.metrics.mailbox.ownersSucceeded).toBe(2)
	expect(runRetentionNow.mock.calls.map((call) => call[0]?.ownerId)).toEqual([
		clearOwner,
		pendingOwner,
		clearOwner,
	])
})

test('delete_message enforces owner isolation and verifies D1/R2 linkage aggregates', async () => {
	const { sqlite, db } = createDeleteMessageDb()
	const { blobs, objects } = createMemoryEmailBlobs()
	mockMailboxDeleteFromD1(db, blobs)
	const ownerA = testStableUserIdFromEmail('owner-a@example.com')
	const ownerB = testStableUserIdFromEmail('owner-b@example.com')
	const messageA = 'msg-owner-a'
	const messageB = 'msg-owner-b'
	const attachmentA = 'att-owner-a'
	const attachmentB = 'att-owner-b'
	const seededA = await seedOwnedMessageWithBlobs({
		sqlite,
		blobs,
		userId: ownerA,
		messageId: messageA,
		attachmentId: attachmentA,
	})
	const seededB = await seedOwnedMessageWithBlobs({
		sqlite,
		blobs,
		userId: ownerB,
		messageId: messageB,
		attachmentId: attachmentB,
	})
	const env = {
		APP_DB: db,
		MAILBOX: {},
		EMAIL_BLOBS: blobs,
	} as unknown as Env

	await expect(
		runAdminMailboxMaintenanceDeleteMessage({
			env,
			stableUserId: ownerA,
			messageId: messageB,
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof AdminMailboxMessageNotFoundError &&
			error.message ===
				`Email message not found for stable_user_id=${ownerA} message_id=${messageB}`,
	)
	await expect(
		runAdminMailboxMaintenanceDeleteMessage({
			env,
			stableUserId: ownerA,
			messageId: 'missing-message',
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof AdminMailboxMessageNotFoundError &&
			error.message ===
				`Email message not found for stable_user_id=${ownerA} message_id=missing-message`,
	)
	expect(
		await getEmailMessageById({
			db,
			userId: ownerB,
			messageId: messageB,
		}),
	).not.toBeNull()
	expect(objects.has(seededB.rawKey)).toBe(true)
	expect(objects.has(seededB.attachmentKey)).toBe(true)

	const result = await runAdminMailboxMaintenanceDeleteMessage({
		env,
		stableUserId: ownerA,
		messageId: messageA,
	})
	expect(result).toEqual({
		d1MessageAbsent: true,
		attachmentsSeen: 2,
		externalAttachmentsSeen: 1,
		rawMimeBlobAbsent: true,
		externalAttachmentBlobsAbsent: 1,
		allCapturedBlobsAbsent: true,
	})
	expect(JSON.stringify(result)).not.toMatch(
		/@|secret body|email-raw:|email-attachment:/,
	)
	expect(
		await getEmailMessageById({
			db,
			userId: ownerA,
			messageId: messageA,
		}),
	).toBeNull()
	expect(objects.has(seededA.rawKey)).toBe(false)
	expect(objects.has(seededA.attachmentKey)).toBe(false)
	expect(
		await getEmailMessageById({
			db,
			userId: ownerB,
			messageId: messageB,
		}),
	).not.toBeNull()
	expect(objects.has(seededB.rawKey)).toBe(true)
	expect(objects.has(seededB.attachmentKey)).toBe(true)
})

test('delete_message leaves the D1 projection when authoritative R2 deletion fails', async () => {
	const { sqlite, db } = createDeleteMessageDb()
	const { blobs, objects } = createMemoryEmailBlobs()
	const owner = testStableUserIdFromEmail('r2-failure@example.com')
	const messageId = 'msg-r2-failure'
	const seeded = await seedOwnedMessageWithBlobs({
		sqlite,
		blobs,
		userId: owner,
		messageId,
		attachmentId: 'att-r2-failure',
	})
	sqlite
		.prepare(`UPDATE email_messages SET raw_mime_key = NULL WHERE id = ?`)
		.run(messageId)
	const failingBlobs = {
		...blobs,
		async delete() {
			throw new Error('simulated authoritative R2 failure')
		},
	}
	mockMailboxDeleteFromD1(db, failingBlobs)

	await expect(
		runAdminMailboxMaintenanceDeleteMessage({
			env: {
				APP_DB: db,
				MAILBOX: {},
				EMAIL_BLOBS: failingBlobs,
			} as unknown as Env,
			stableUserId: owner,
			messageId,
		}),
	).rejects.toThrow('simulated authoritative R2 failure')
	expect(
		await getEmailMessageById({ db, userId: owner, messageId }),
	).not.toBeNull()
	expect(objects.has(seeded.rawKey)).toBe(true)
	expect(objects.has(seeded.attachmentKey)).toBe(true)
})

test('delete_message fences a Mailbox-missing D1 projection before destructive cleanup', async () => {
	const { sqlite, db } = createDeleteMessageDb()
	const { blobs, objects } = createMemoryEmailBlobs()
	const owner = testStableUserIdFromEmail('missing-mailbox@example.com')
	const messageId = 'msg-missing-mailbox'
	const seeded = await seedOwnedMessageWithBlobs({
		sqlite,
		blobs,
		userId: owner,
		messageId,
		attachmentId: 'att-missing-mailbox',
	})
	const order: Array<string> = []
	const originalDelete = blobs.delete.bind(blobs)
	blobs.delete = async (keys) => {
		order.push('r2-delete')
		await originalDelete(keys)
	}
	const tombstoneMissingMessage = vi.fn(async () => {
		order.push('mailbox-tombstone')
		return { status: 'tombstoned' as const, created: true }
	})
	mocks.mailboxRpc.mockImplementation(() => ({
		deleteMessageWithBlobs: async () => ({
			status: 'missing' as const,
			tombstoned: false,
		}),
		tombstoneMissingMessage,
	}))

	await expect(
		runAdminMailboxMaintenanceDeleteMessage({
			env: { APP_DB: db, EMAIL_BLOBS: blobs, MAILBOX: {} } as Env,
			stableUserId: owner,
			messageId,
		}),
	).resolves.toMatchObject({ d1MessageAbsent: true })

	expect(order).toEqual(['mailbox-tombstone', 'r2-delete'])
	expect(tombstoneMissingMessage).toHaveBeenCalledWith(
		expect.objectContaining({ ownerId: owner, messageId }),
	)
	expect(objects.has(seeded.rawKey)).toBe(false)
	expect(objects.has(seeded.attachmentKey)).toBe(false)
})

test('delete_message performs no R2 or D1 cleanup when missing-message tombstoning fails', async () => {
	const { sqlite, db } = createDeleteMessageDb()
	const { blobs, objects } = createMemoryEmailBlobs()
	const owner = testStableUserIdFromEmail('tombstone-failure@example.com')
	const messageId = 'msg-tombstone-failure'
	const seeded = await seedOwnedMessageWithBlobs({
		sqlite,
		blobs,
		userId: owner,
		messageId,
		attachmentId: 'att-tombstone-failure',
	})
	const deleteBlob = vi.spyOn(blobs, 'delete')
	mocks.mailboxRpc.mockImplementation(() => ({
		deleteMessageWithBlobs: async () => ({
			status: 'missing' as const,
			tombstoned: false,
		}),
		tombstoneMissingMessage: async () => {
			throw new Error('simulated tombstone failure')
		},
	}))

	await expect(
		runAdminMailboxMaintenanceDeleteMessage({
			env: { APP_DB: db, EMAIL_BLOBS: blobs, MAILBOX: {} } as Env,
			stableUserId: owner,
			messageId,
		}),
	).rejects.toThrow('simulated tombstone failure')

	expect(deleteBlob).not.toHaveBeenCalled()
	expect(
		await getEmailMessageById({ db, userId: owner, messageId }),
	).not.toBeNull()
	expect(objects.has(seeded.rawKey)).toBe(true)
	expect(objects.has(seeded.attachmentKey)).toBe(true)
})

test('delete_message retry cleans D1 after Mailbox succeeded before a D1 failure', async () => {
	const { sqlite, db } = createDeleteMessageDb()
	const { blobs, objects } = createMemoryEmailBlobs()
	const owner = testStableUserIdFromEmail('d1-retry@example.com')
	const messageId = 'msg-d1-retry'
	const attachmentId = 'att-d1-retry'
	const seeded = await seedOwnedMessageWithBlobs({
		sqlite,
		blobs,
		userId: owner,
		messageId,
		attachmentId,
	})
	let failNextBatch = true
	const retryDb = {
		prepare(query: string) {
			return db.prepare(query)
		},
		async batch(statements: Array<D1PreparedStatement>) {
			if (failNextBatch) {
				failNextBatch = false
				throw new Error('injected D1 projection cleanup failure')
			}
			return await db.batch(statements)
		},
		async exec(query: string) {
			return await db.exec(query)
		},
	} as unknown as D1Database
	let mailboxDeleted = false
	const deleteMessageWithBlobs = vi.fn(async () => {
		if (mailboxDeleted) {
			return { status: 'missing' as const, tombstoned: true }
		}
		mailboxDeleted = true
		await blobs.delete([seeded.rawKey, seeded.attachmentKey])
		return {
			status: 'deleted' as const,
			attachmentsSeen: 2,
			externalAttachmentsSeen: 1,
			blobReferences: [
				{
					kind: 'raw_mime' as const,
					key: seeded.rawKey,
					messageId,
					attachmentId: null,
				},
				{
					kind: 'attachment' as const,
					key: seeded.attachmentKey,
					messageId,
					attachmentId,
				},
			],
		}
	})
	mocks.mailboxRpc.mockImplementation(() => ({ deleteMessageWithBlobs }))
	const env = {
		APP_DB: retryDb,
		MAILBOX: {},
		EMAIL_BLOBS: blobs,
	} as unknown as Env

	await expect(
		runAdminMailboxMaintenanceDeleteMessage({
			env,
			stableUserId: owner,
			messageId,
		}),
	).rejects.toThrow('injected D1 projection cleanup failure')
	expect(
		await getEmailMessageById({ db, userId: owner, messageId }),
	).not.toBeNull()
	expect(objects.has(seeded.rawKey)).toBe(false)
	expect(objects.has(seeded.attachmentKey)).toBe(false)

	await expect(
		runAdminMailboxMaintenanceDeleteMessage({
			env,
			stableUserId: owner,
			messageId,
		}),
	).resolves.toEqual({
		d1MessageAbsent: true,
		attachmentsSeen: 2,
		externalAttachmentsSeen: 1,
		rawMimeBlobAbsent: true,
		externalAttachmentBlobsAbsent: 1,
		allCapturedBlobsAbsent: true,
	})
	expect(deleteMessageWithBlobs).toHaveBeenCalledTimes(2)
	expect(await getEmailMessageById({ db, userId: owner, messageId })).toBeNull()
})

test('deleteEmailMessageById expectedUserId fence rejects foreign owners without mutating', async () => {
	const { sqlite, db } = createDeleteMessageDb()
	const { blobs, objects } = createMemoryEmailBlobs()
	const owner = testStableUserIdFromEmail('fence-owner@example.com')
	const other = testStableUserIdFromEmail('fence-other@example.com')
	const messageId = 'msg-fence'
	const attachmentId = 'att-fence'
	const seeded = await seedOwnedMessageWithBlobs({
		sqlite,
		blobs,
		userId: owner,
		messageId,
		attachmentId,
	})

	await expect(
		deleteEmailMessageById({
			db,
			blobs: blobs as R2Bucket,
			messageId,
			expectedUserId: other,
		}),
	).rejects.toThrow(
		`Email message not found for expected_user_id=${other} message_id=${messageId}`,
	)
	expect(
		await getEmailMessageById({
			db,
			userId: owner,
			messageId,
		}),
	).not.toBeNull()
	expect(objects.has(seeded.rawKey)).toBe(true)
	expect(objects.has(seeded.attachmentKey)).toBe(true)

	const deletion = await deleteEmailMessageById({
		db,
		blobs: blobs as R2Bucket,
		messageId,
		expectedUserId: owner,
	})
	expect(deletion.messageFound).toBe(true)
	expect(deletion.ownerUserId).toBe(owner)
	expect(deletion.attachmentsSeen).toBe(2)
	expect(deletion.externalAttachmentsSeen).toBe(1)
	expect(deletion.blobDeletions.map((entry) => entry.key)).toEqual([
		seeded.rawKey,
		seeded.attachmentKey,
	])
	expect(deletion.blobDeletions.every((entry) => entry.deleted)).toBe(true)
})

test('delete_message head-checks exact keys captured after verification drift', async () => {
	const { sqlite, db } = createDeleteMessageDb()
	const { blobs, objects } = createMemoryEmailBlobs()
	const owner = testStableUserIdFromEmail('drift-owner@example.com')
	const messageId = 'msg-drift'
	const attachmentId = 'att-original'
	const seeded = await seedOwnedMessageWithBlobs({
		sqlite,
		blobs,
		userId: owner,
		messageId,
		attachmentId,
	})
	const driftAttachmentId = 'att-drifted'
	const driftKey = emailAttachmentBlobKey(owner, messageId, driftAttachmentId)
	const attachments = await EmailRepo.listEmailAttachmentsForUserMessage({
		db,
		userId: owner,
		messageId,
	})
	mocks.mailboxRpc.mockImplementation(() => ({
		deleteMessageWithBlobs: async () => {
			// Simulate D1 projection drift after the authoritative Mailbox
			// inventory was captured but before compatibility cleanup.
			if (!objects.has(driftKey)) {
				sqlite
					.prepare(
						`INSERT INTO email_attachments (
							id, message_id, filename, content_type, size, storage_kind,
							storage_key, created_at
						) VALUES (?, ?, 'drift.txt', 'text/plain', 5, 'external', ?, ?)`,
					)
					.run(driftAttachmentId, messageId, driftKey, freshCreatedAt)
				await blobs.put(driftKey, 'drift')
			}
			await blobs.delete([seeded.rawKey, seeded.attachmentKey])
			return {
				status: 'deleted' as const,
				attachmentsSeen: attachments.length,
				externalAttachmentsSeen: attachments.filter(
					(attachment) => attachment.storageKind === 'external',
				).length,
				blobReferences: [
					{
						kind: 'raw_mime' as const,
						key: seeded.rawKey,
						messageId,
						attachmentId: null,
					},
					{
						kind: 'attachment' as const,
						key: seeded.attachmentKey,
						messageId,
						attachmentId,
					},
				],
			}
		},
	}))
	const headedKeys: Array<string> = []
	const trackingBlobs = {
		async put(key: string, value: string | ArrayBuffer | ArrayBufferView) {
			return blobs.put(key, value)
		},
		async delete(key: string | Array<string>) {
			return blobs.delete(key)
		},
		async head(key: string) {
			headedKeys.push(key)
			return blobs.head(key)
		},
	}
	const env = {
		APP_DB: db,
		MAILBOX: {},
		EMAIL_BLOBS: trackingBlobs,
	} as unknown as Env

	const result = await runAdminMailboxMaintenanceDeleteMessage({
		env,
		stableUserId: owner,
		messageId,
	})
	expect(result).toEqual({
		d1MessageAbsent: true,
		attachmentsSeen: 2,
		externalAttachmentsSeen: 1,
		rawMimeBlobAbsent: true,
		externalAttachmentBlobsAbsent: 1,
		allCapturedBlobsAbsent: true,
	})
	expect(headedKeys).toEqual([seeded.rawKey, seeded.attachmentKey])
	expect(objects.has(seeded.rawKey)).toBe(false)
	expect(objects.has(seeded.attachmentKey)).toBe(false)
	// A D1-only projection drift is not an authoritative Mailbox blob ref.
	expect(objects.has(driftKey)).toBe(true)
	expect(JSON.stringify(result)).not.toMatch(
		/@|secret body|email-raw:|email-attachment:/,
	)
})
