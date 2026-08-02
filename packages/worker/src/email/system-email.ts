import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import {
	reconcileSystemEmailGraphFromLegacy,
	type SystemEmailGraphMutationCounts,
} from './system-email-graph-repo.ts'
import { maxRawMimeBytes } from './parser.ts'
import { buildPlatformEmailAddress } from './platform-address.ts'
import {
	createEmailInbox,
	createEmailInboxAddress,
	deleteEmailInboxAddressById,
	emailRawMimeKey,
	getEmailInboxAddressByAddress,
	getEmailInboxById,
	getEmailInboxByName,
} from './repo.ts'
import { type EmailInboxAddressRecord, type EmailInboxRecord } from './types.ts'

export { systemEmailOwnerId }

export const systemEmailLocals = [
	'kody',
	'support',
	'abuse',
	'postmaster',
	'security',
	'admin',
] as const

export type SystemEmailLocal = (typeof systemEmailLocals)[number]

export const systemEmailLimits = {
	maxMessageBytes: maxRawMimeBytes,
	maxReceivesPerDay: 1000,
	maxStoredMessages: 5000,
	retentionDays: 90,
	pruneBatchSize: 500,
} as const

/**
 * Wall-clock budget for one system-email retention run. Deletes keep looping
 * in pruneBatchSize batches until the backlog is drained or the budget is
 * exhausted, so a large backlog never turns into one unbounded DELETE.
 */
export const systemEmailPruneTimeBudgetMs = 10_000

/** D1 caps bound parameters per statement, so IN (...) deletes are chunked. */
const systemEmailDeleteIdsMaxParameters = 100

const systemEmailLocalSet = new Set<string>(systemEmailLocals)

export type ProvisionedSystemEmailInbox = {
	inbox: EmailInboxRecord
	address: EmailInboxAddressRecord
}

export function isSystemEmailLocal(
	localPart: string,
): localPart is SystemEmailLocal {
	return systemEmailLocalSet.has(localPart.trim().toLowerCase())
}

export async function ensureSystemEmailInbox(input: {
	db: D1Database
	localPart: SystemEmailLocal
	domain: string
}): Promise<ProvisionedSystemEmailInbox | null> {
	const localPart = input.localPart.trim().toLowerCase() as SystemEmailLocal
	const address = buildPlatformEmailAddress({
		username: localPart,
		domain: input.domain,
	})

	const readExisting = async () => {
		const existingAddress = await getEmailInboxAddressByAddress({
			db: input.db,
			address,
		})
		if (!existingAddress) return null
		if (existingAddress.userId !== systemEmailOwnerId) {
			await deleteEmailInboxAddressById({
				db: input.db,
				addressId: existingAddress.id,
			})
			return null
		}
		if (!existingAddress.enabled) {
			return { conflict: true as const }
		}
		const inbox = await getEmailInboxById({
			db: input.db,
			userId: systemEmailOwnerId,
			id: existingAddress.inboxId,
		})
		if (!inbox?.enabled) return { conflict: true as const }
		return { conflict: false as const, inbox, address: existingAddress }
	}

	const existing = await readExisting()
	if (existing) {
		return existing.conflict
			? null
			: { inbox: existing.inbox, address: existing.address }
	}

	let inbox = await getEmailInboxByName({
		db: input.db,
		userId: systemEmailOwnerId,
		name: localPart,
	})
	if (!inbox) {
		try {
			inbox = await createEmailInbox({
				db: input.db,
				userId: systemEmailOwnerId,
				name: localPart,
				description: `Operator-owned system inbox for ${address}`,
			})
		} catch (error) {
			inbox = await getEmailInboxByName({
				db: input.db,
				userId: systemEmailOwnerId,
				name: localPart,
			})
			if (!inbox) throw error
		}
	}

	try {
		const created = await createEmailInboxAddress({
			db: input.db,
			inboxId: inbox.id,
			userId: systemEmailOwnerId,
			address,
			localPart,
			domain: input.domain,
		})
		return { inbox, address: created }
	} catch (error) {
		const raced = await readExisting()
		if (raced) {
			return raced.conflict
				? null
				: { inbox: raced.inbox, address: raced.address }
		}
		throw error
	}
}

export function systemEmailDayKey(now = new Date()) {
	return utcDayKey(now)
}

export async function consumeSystemEmailDailyReceive(input: {
	db: D1Database
	localPart: SystemEmailLocal
	now?: Date
	limit?: number
}) {
	const now = input.now ?? new Date()
	const limit = input.limit ?? systemEmailLimits.maxReceivesPerDay
	const row = await input.db
		.prepare(
			`INSERT INTO system_email_daily_counters (
				local_part, day, count, updated_at
			) VALUES (?, ?, 1, ?)
			ON CONFLICT(local_part, day) DO UPDATE SET
				count = count + 1,
				updated_at = excluded.updated_at
			WHERE count < ?
			RETURNING count`,
		)
		.bind(input.localPart, systemEmailDayKey(now), now.toISOString(), limit)
		.first<{ count: number }>()
	return row ? Number(row.count) : null
}

/**
 * Atomically refund one previously consumed system-inbox daily receive for
 * the given local_part/UTC day (floors at zero). Scoped by `local_part` so a
 * refund cannot touch another system inbox's counter. Pass the same `now`
 * (day key) as the matching `consumeSystemEmailDailyReceive` call.
 */
export async function refundSystemEmailDailyReceive(input: {
	db: D1Database
	localPart: SystemEmailLocal
	now?: Date
}): Promise<void> {
	const now = input.now ?? new Date()
	await input.db
		.prepare(
			`UPDATE system_email_daily_counters
			SET count = MAX(0, count - 1),
				updated_at = ?
			WHERE local_part = ?
				AND day = ?`,
		)
		.bind(now.toISOString(), input.localPart, systemEmailDayKey(now))
		.run()
}

export async function countStoredSystemEmailMessages(input: {
	db: D1Database
}) {
	const row = await input.db
		.prepare(
			`SELECT COUNT(*) AS count
			FROM email_messages
			WHERE user_id = ?
				AND direction = 'inbound'`,
		)
		.bind(systemEmailOwnerId)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

type SystemEmailMessageCursor = {
	createdAt: string
	id: string
}

async function listSystemEmailMessages(input: {
	db: D1Database
	before?: string
	/**
	 * Keyset cursor (last row examined in the newest-first ordering) so batches
	 * within one prune run advance past rows skipped for blob reasons instead
	 * of reselecting the same blocked head.
	 */
	cursor?: SystemEmailMessageCursor | null
	offset?: number
	limit: number
}) {
	const where = [`user_id = ?`, `direction = 'inbound'`]
	const bindings: Array<string | number> = [systemEmailOwnerId]
	if (input.before) {
		where.push(`created_at < ?`)
		bindings.push(input.before)
	}
	if (input.cursor) {
		where.push(`(created_at < ? OR (created_at = ? AND id < ?))`)
		bindings.push(
			input.cursor.createdAt,
			input.cursor.createdAt,
			input.cursor.id,
		)
	}
	const offset = input.offset ?? 0
	const result = await input.db
		.prepare(
			`SELECT id, created_at
			FROM email_messages
			WHERE ${where.join(' AND ')}
			ORDER BY created_at DESC, id DESC
			LIMIT ? OFFSET ?`,
		)
		.bind(...bindings, input.limit, offset)
		.all<{ id: string; created_at: string }>()
	return result.results ?? []
}

async function deleteSystemEmailMessagesByIds(input: {
	db: D1Database
	blobs: R2Bucket
	messageIds: ReadonlyArray<string>
}) {
	const result = {
		deletedMessages: 0,
		deletedRawMimeBlobs: 0,
		blobDeleteErrors: 0,
	}
	for (
		let index = 0;
		index < input.messageIds.length;
		index += systemEmailDeleteIdsMaxParameters
	) {
		const messageIds = input.messageIds.slice(
			index,
			index + systemEmailDeleteIdsMaxParameters,
		)
		const chunkPlaceholders = messageIds.map(() => '?').join(', ')
		const { results } = await input.db
			.prepare(
				`SELECT id, user_id, raw_mime_key
				FROM email_messages
				WHERE id IN (${chunkPlaceholders})`,
			)
			.bind(...messageIds)
			.all<{ id: string; user_id: string; raw_mime_key: string | null }>()
		const blobRows = results ?? []
		// Delete R2 blobs before their rows, mirroring the user-mail retention
		// policy: once a row is gone its keys are lost, so a failed blob delete
		// would orphan the object forever. Deletes use the deterministic
		// canonical key. Rows whose blob cannot be deleted are skipped and
		// retried on a later run.
		let deletableIds: ReadonlyArray<string> = messageIds
		if (blobRows.length > 0) {
			const blobRowIds = new Set(blobRows.map((row) => row.id))
			const blobKeys = blobRows.map((row) =>
				emailRawMimeKey(row.user_id, row.id),
			)
			try {
				await input.blobs.delete(blobKeys)
				result.deletedRawMimeBlobs += blobRows.filter(
					(row) => row.raw_mime_key !== null,
				).length
			} catch (error) {
				result.blobDeleteErrors += blobRows.length
				deletableIds = messageIds.filter((id) => !blobRowIds.has(id))
				console.warn('system-email-raw-mime-blob-delete-failed', error)
			}
		}
		if (deletableIds.length === 0) continue
		const placeholders = deletableIds.map(() => '?').join(', ')
		await input.db
			.prepare(
				`DELETE FROM email_attachments
				WHERE message_id IN (${placeholders})`,
			)
			.bind(...deletableIds)
			.run()
		await input.db
			.prepare(
				`DELETE FROM email_delivery_events
				WHERE message_id IN (${placeholders})`,
			)
			.bind(...deletableIds)
			.run()
		// Provider-index rows cascade via FK ON DELETE CASCADE from email_messages.
		await input.db
			.prepare(
				`DELETE FROM email_messages
				WHERE id IN (${placeholders})`,
			)
			.bind(...deletableIds)
			.run()
		result.deletedMessages += deletableIds.length
	}
	return result
}

export type SystemEmailRetentionResult = {
	deletedMessages: number
	deletedDeliveryEvents: number
	deletedCounters: number
	deletedThreads: number
	deletedRawMimeBlobs: number
	blobDeleteErrors: number
	dedicatedGraphSync:
		| {
				status: 'reconciled'
				upserted: SystemEmailGraphMutationCounts
				deleted: SystemEmailGraphMutationCounts
				referencedOwnerMismatchCount: number
				parity: boolean
		  }
		| {
				status: 'skipped'
				reason: 'legacy-blob-delete-errors'
				blobDeleteErrors: number
		  }
	warnings: Array<
		'dedicated-graph-sync-skipped' | 'dedicated-graph-post-reconcile-mismatch'
	>
}

export async function pruneSystemEmailRetention(input: {
	db: D1Database
	/** EMAIL_BLOBS bucket; raw-MIME blobs are deleted before their rows. */
	blobs: R2Bucket
	now?: Date
	timeBudgetMs?: number
}) {
	const now = input.now ?? new Date()
	const timeBudgetMs = input.timeBudgetMs ?? systemEmailPruneTimeBudgetMs
	const deadlineMs = Date.now() + timeBudgetMs
	const cutoff = new Date(
		now.getTime() - systemEmailLimits.retentionDays * 24 * 60 * 60 * 1000,
	)
	const cutoffIso = cutoff.toISOString()
	const cutoffDay = systemEmailDayKey(cutoff)
	const result: SystemEmailRetentionResult = {
		deletedMessages: 0,
		deletedDeliveryEvents: 0,
		deletedCounters: 0,
		deletedThreads: 0,
		deletedRawMimeBlobs: 0,
		blobDeleteErrors: 0,
		dedicatedGraphSync: {
			status: 'skipped',
			reason: 'legacy-blob-delete-errors',
			blobDeleteErrors: 0,
		},
		warnings: [],
	}

	const addMessageDelete = (batch: {
		deletedMessages: number
		deletedRawMimeBlobs: number
		blobDeleteErrors: number
	}) => {
		result.deletedMessages += batch.deletedMessages
		result.deletedRawMimeBlobs += batch.deletedRawMimeBlobs
		result.blobDeleteErrors += batch.blobDeleteErrors
	}

	// Age prune loops batches within the time budget. The keyset cursor marks
	// the last row examined (not the last deleted), so rows skipped because
	// their blob could not be deleted never block later expired rows in the
	// same run; the next run retries the skipped rows from the head.
	let ageCursor: SystemEmailMessageCursor | null = null
	let selectedInBatch = 0
	do {
		const oldMessages = await listSystemEmailMessages({
			db: input.db,
			before: cutoffIso,
			cursor: ageCursor,
			limit: systemEmailLimits.pruneBatchSize,
		})
		selectedInBatch = oldMessages.length
		const lastMessage = oldMessages.at(-1)
		if (!lastMessage) break
		ageCursor = { createdAt: lastMessage.created_at, id: lastMessage.id }
		addMessageDelete(
			await deleteSystemEmailMessagesByIds({
				db: input.db,
				blobs: input.blobs,
				messageIds: oldMessages.map((message) => message.id),
			}),
		)
	} while (
		selectedInBatch >= systemEmailLimits.pruneBatchSize &&
		Date.now() < deadlineMs
	)

	const overCapMessages = await listSystemEmailMessages({
		db: input.db,
		offset: systemEmailLimits.maxStoredMessages,
		limit: systemEmailLimits.pruneBatchSize,
	})
	addMessageDelete(
		await deleteSystemEmailMessagesByIds({
			db: input.db,
			blobs: input.blobs,
			messageIds: overCapMessages.map((message) => message.id),
		}),
	)

	let deletedEventsInBatch = 0
	do {
		const eventDelete = await input.db
			.prepare(
				`DELETE FROM email_delivery_events
				WHERE id IN (
					SELECT id
					FROM email_delivery_events
					WHERE user_id = ?
						AND created_at < ?
					ORDER BY created_at ASC, id ASC
					LIMIT ?
				)`,
			)
			.bind(systemEmailOwnerId, cutoffIso, systemEmailLimits.pruneBatchSize)
			.run()
		deletedEventsInBatch = eventDelete.meta.changes ?? 0
		result.deletedDeliveryEvents += deletedEventsInBatch
	} while (
		deletedEventsInBatch >= systemEmailLimits.pruneBatchSize &&
		Date.now() < deadlineMs
	)

	const counterDelete = await input.db
		.prepare(`DELETE FROM system_email_daily_counters WHERE day < ?`)
		.bind(cutoffDay)
		.run()
	result.deletedCounters = counterDelete.meta.changes ?? 0

	const threadDelete = await input.db
		.prepare(
			`DELETE FROM email_threads
			WHERE user_id = ?
				AND NOT EXISTS (
					SELECT 1 FROM email_messages WHERE email_messages.thread_id = email_threads.id
				)`,
		)
		.bind(systemEmailOwnerId)
		.run()
	result.deletedThreads = threadDelete.meta.changes ?? 0

	if (result.blobDeleteErrors > 0) {
		result.dedicatedGraphSync = {
			status: 'skipped',
			reason: 'legacy-blob-delete-errors',
			blobDeleteErrors: result.blobDeleteErrors,
		}
		result.warnings.push('dedicated-graph-sync-skipped')
		console.warn('system-email-dedicated-graph-sync-skipped', {
			reason: 'legacy-blob-delete-errors',
			blobDeleteErrors: result.blobDeleteErrors,
		})
		return result
	}

	const graphSync = await reconcileSystemEmailGraphFromLegacy({ db: input.db })
	result.dedicatedGraphSync = {
		status: 'reconciled',
		upserted: graphSync.metrics.upserted,
		deleted: graphSync.metrics.deleted,
		referencedOwnerMismatchCount:
			graphSync.metrics.referencedOwnerMismatchCount,
		parity: graphSync.postReport.parity,
	}
	if (!graphSync.postReport.parity) {
		result.warnings.push('dedicated-graph-post-reconcile-mismatch')
		console.warn('system-email-dedicated-graph-post-reconcile-mismatch', {
			referencedOwnerMismatchCount:
				graphSync.metrics.referencedOwnerMismatchCount,
			upserted: graphSync.metrics.upserted,
			deleted: graphSync.metrics.deleted,
		})
	}

	return result
}
