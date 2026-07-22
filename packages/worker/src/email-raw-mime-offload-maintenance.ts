import {
	emailRawMimeKey,
	isEmailRawMimeKeyReferenced,
	isOwnedEmailRawMimeKey,
} from '#worker/email/repo.ts'
import {
	handleSecretMaintenanceRequest,
	MaintenanceFailureError,
} from './maintenance-handler.ts'

/**
 * Bounded batch size for one maintenance request. Rows may hold up to ~512KiB
 * of MIME, so keep each HTTP call small enough for Worker memory and R2 put
 * fan-out. Deploy loops requests until `complete` (or hits its attempt cap).
 */
export const emailRawMimeOffloadPageSize = 10

/** Bounded retries for orphan blob cleanup after a CAS miss or queue drain. */
export const emailRawMimeOrphanDeleteAttempts = 3

type InlineRawMimeRow = {
	id: string
	userId: string
	rawMime: string
	priorRawMimeKey: string | null
}

type EmailMessageMimeState = {
	id: string
	userId: string
	rawMime: string | null
	rawMimeKey: string | null
	rawMimeOffloadBlocked: boolean
}

type CleanupQueueRow = {
	objectKey: string
	userId: string
	messageId: string
}

export type CleanupBatchResult = {
	scanned: number
	deleted: number
	failed: number
}

function emptyCleanupBatchResult(): CleanupBatchResult {
	return { scanned: 0, deleted: 0, failed: 0 }
}

/**
 * Delete a deterministic orphan raw-MIME blob, retrying a small fixed number of
 * times. Propagates the last error when every attempt fails so the caller can
 * count the row as failed instead of reporting success with an orphan left
 * behind.
 */
async function deleteOrphanRawMimeBlobWithRetry(input: {
	blobs: R2Bucket
	key: string
	messageId: string
}): Promise<void> {
	let lastError: unknown
	for (
		let attempt = 1;
		attempt <= emailRawMimeOrphanDeleteAttempts;
		attempt += 1
	) {
		try {
			await input.blobs.delete(input.key)
			return
		} catch (error) {
			lastError = error
			console.warn(
				'email-raw-mime-offload-orphan-delete-failed',
				input.messageId,
				attempt,
				error,
			)
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error(`orphan-delete-failed:${input.key}`)
}

async function upsertCleanupQueueRow(input: {
	db: D1Database
	objectKey: string
	userId: string
	messageId: string
}): Promise<void> {
	const now = new Date().toISOString()
	const result = await input.db
		.prepare(
			`INSERT INTO email_raw_mime_cleanup_queue (
				object_key, user_id, message_id, attempt_count, last_error, created_at, updated_at
			) VALUES (?, ?, ?, 0, NULL, ?, ?)
			ON CONFLICT(object_key) DO UPDATE SET
				message_id = excluded.message_id,
				updated_at = excluded.updated_at
			WHERE email_raw_mime_cleanup_queue.user_id = excluded.user_id`,
		)
		.bind(input.objectKey, input.userId, input.messageId, now, now)
		.run()
	if ((result.meta.changes ?? 0) === 0) {
		throw new Error(
			`cleanup-queue-upsert-rejected:${input.objectKey}:${input.userId}`,
		)
	}
}

async function deleteCleanupQueueRow(input: {
	db: D1Database
	objectKey: string
	userId: string
}): Promise<void> {
	await input.db
		.prepare(
			`DELETE FROM email_raw_mime_cleanup_queue
			WHERE object_key = ?
				AND user_id = ?`,
		)
		.bind(input.objectKey, input.userId)
		.run()
}

async function markCleanupQueueFailure(input: {
	db: D1Database
	objectKey: string
	userId: string
	error: unknown
}): Promise<void> {
	const message =
		input.error instanceof Error ? input.error.message : String(input.error)
	await input.db
		.prepare(
			`UPDATE email_raw_mime_cleanup_queue
			SET attempt_count = attempt_count + 1,
				last_error = ?,
				updated_at = ?
			WHERE object_key = ?
				AND user_id = ?`,
		)
		.bind(message, new Date().toISOString(), input.objectKey, input.userId)
		.run()
}

/**
 * Sticky orphan cleanup: upsert a user-scoped queue tombstone first, retry R2
 * delete, then remove the queue row only after a confirmed delete. On failure
 * leave/update the queue row and rethrow so the request fails stickily.
 * Rejects keys not owned by userId (never queues or deletes cross-user keys).
 */
async function cleanupOrphanRawMimeBlob(input: {
	db: D1Database
	blobs: R2Bucket
	objectKey: string
	userId: string
	messageId: string
}): Promise<void> {
	if (!isOwnedEmailRawMimeKey(input.userId, input.objectKey)) {
		console.warn(
			'email-raw-mime-offload-key-ownership-rejected',
			input.messageId,
			input.userId,
			input.objectKey,
		)
		return
	}
	const referenced = await isEmailRawMimeKeyReferenced({
		db: input.db,
		objectKey: input.objectKey,
		excludeMessageIds: [input.messageId],
	})
	if (referenced) {
		console.warn(
			'email-raw-mime-offload-key-still-referenced',
			input.messageId,
			input.objectKey,
		)
		return
	}
	await upsertCleanupQueueRow({
		db: input.db,
		objectKey: input.objectKey,
		userId: input.userId,
		messageId: input.messageId,
	})
	try {
		await deleteOrphanRawMimeBlobWithRetry({
			blobs: input.blobs,
			key: input.objectKey,
			messageId: input.messageId,
		})
		await deleteCleanupQueueRow({
			db: input.db,
			objectKey: input.objectKey,
			userId: input.userId,
		})
	} catch (error) {
		await markCleanupQueueFailure({
			db: input.db,
			objectKey: input.objectKey,
			userId: input.userId,
			error,
		})
		throw error
	}
}

/**
 * After a successful offload clear to the deterministic key, delete a prior
 * divergent same-user blob through the sticky queue protocol when safe.
 */
async function cleanupDivergentPriorRawMimeKey(input: {
	db: D1Database
	blobs: R2Bucket
	userId: string
	messageId: string
	priorRawMimeKey: string | null
	newRawMimeKey: string
}): Promise<void> {
	const prior = input.priorRawMimeKey
	if (prior == null || prior === input.newRawMimeKey) return
	await cleanupOrphanRawMimeBlob({
		db: input.db,
		blobs: input.blobs,
		objectKey: prior,
		userId: input.userId,
		messageId: input.messageId,
	})
}

async function listCleanupQueueBatch(input: {
	db: D1Database
	limit: number
}): Promise<Array<CleanupQueueRow>> {
	// Prefer lower attempt_count / older updated_at so a permanently failing
	// head item cannot starve later queue rows across bounded batches. Failures
	// still bump attempt_count/updated_at and leave remainingBlobCleanup > 0.
	const rows = await input.db
		.prepare(
			`SELECT object_key, user_id, message_id
			FROM email_raw_mime_cleanup_queue
			ORDER BY attempt_count ASC, updated_at ASC, object_key ASC
			LIMIT ?`,
		)
		.bind(input.limit)
		.all<Record<string, unknown>>()

	return (rows.results ?? []).flatMap((row) => {
		const objectKey =
			typeof row['object_key'] === 'string' ? row['object_key'] : null
		const userId = typeof row['user_id'] === 'string' ? row['user_id'] : null
		const messageId =
			typeof row['message_id'] === 'string' ? row['message_id'] : null
		if (!objectKey || !userId || !messageId) return []
		return [{ objectKey, userId, messageId }]
	})
}

async function processCleanupQueueBatch(input: {
	db: D1Database
	blobs: R2Bucket
	pageSize: number
}): Promise<CleanupBatchResult> {
	const rows = await listCleanupQueueBatch({
		db: input.db,
		limit: input.pageSize,
	})
	const result = emptyCleanupBatchResult()
	for (const row of rows) {
		result.scanned += 1
		if (!isOwnedEmailRawMimeKey(row.userId, row.objectKey)) {
			// Invalid tombstone: drop without touching R2 so we cannot delete
			// another user's object via a corrupted queue row.
			await deleteCleanupQueueRow({
				db: input.db,
				objectKey: row.objectKey,
				userId: row.userId,
			})
			console.warn(
				'email-raw-mime-offload-cleanup-queue-ownership-rejected',
				row.messageId,
				row.userId,
				row.objectKey,
			)
			result.deleted += 1
			continue
		}
		const referenced = await isEmailRawMimeKeyReferenced({
			db: input.db,
			objectKey: row.objectKey,
		})
		if (referenced) {
			await deleteCleanupQueueRow({
				db: input.db,
				objectKey: row.objectKey,
				userId: row.userId,
			})
			console.warn(
				'email-raw-mime-offload-cleanup-queue-still-referenced',
				row.messageId,
				row.objectKey,
			)
			result.deleted += 1
			continue
		}
		try {
			await deleteOrphanRawMimeBlobWithRetry({
				blobs: input.blobs,
				key: row.objectKey,
				messageId: row.messageId,
			})
			await deleteCleanupQueueRow({
				db: input.db,
				objectKey: row.objectKey,
				userId: row.userId,
			})
			result.deleted += 1
		} catch (error) {
			await markCleanupQueueFailure({
				db: input.db,
				objectKey: row.objectKey,
				userId: row.userId,
				error,
			})
			result.failed += 1
			console.warn(
				'email-raw-mime-offload-cleanup-queue-failed',
				row.messageId,
				error,
			)
		}
	}
	return result
}

async function countRemainingBlobCleanup(db: D1Database): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS remaining FROM email_raw_mime_cleanup_queue`)
		.first<{ remaining: number }>()
	return Number(row?.remaining ?? 0)
}

async function listEmailMessagesWithInlineRawMimeBatch(input: {
	db: D1Database
	limit: number
}): Promise<Array<InlineRawMimeRow>> {
	const rows = await input.db
		.prepare(
			`SELECT id, user_id, raw_mime, raw_mime_key
			FROM email_messages
			WHERE raw_mime IS NOT NULL
				AND raw_mime_offload_blocked = 0
			ORDER BY id
			LIMIT ?`,
		)
		.bind(input.limit)
		.all<Record<string, unknown>>()

	return (rows.results ?? []).flatMap((row) => {
		const id = typeof row['id'] === 'string' ? row['id'] : null
		const userId = typeof row['user_id'] === 'string' ? row['user_id'] : null
		const rawMime = typeof row['raw_mime'] === 'string' ? row['raw_mime'] : null
		if (!id || !userId || rawMime == null) return []
		return [
			{
				id,
				userId,
				rawMime,
				priorRawMimeKey:
					typeof row['raw_mime_key'] === 'string' ? row['raw_mime_key'] : null,
			},
		]
	})
}

async function clearInlineRawMimeAfterOffload(input: {
	db: D1Database
	id: string
	userId: string
	rawMimeKey: string
}): Promise<boolean> {
	const result = await input.db
		.prepare(
			`UPDATE email_messages
			SET raw_mime = NULL,
				raw_mime_key = ?,
				updated_at = ?
			WHERE id = ?
				AND user_id = ?
				AND raw_mime IS NOT NULL
				AND raw_mime_offload_blocked = 0`,
		)
		.bind(input.rawMimeKey, new Date().toISOString(), input.id, input.userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

async function readEmailMessageMimeState(input: {
	db: D1Database
	id: string
	userId: string
}): Promise<EmailMessageMimeState | null> {
	const row = await input.db
		.prepare(
			`SELECT id, user_id, raw_mime, raw_mime_key, raw_mime_offload_blocked
			FROM email_messages
			WHERE id = ?
				AND user_id = ?`,
		)
		.bind(input.id, input.userId)
		.first<Record<string, unknown>>()
	if (!row) return null
	const id = typeof row['id'] === 'string' ? row['id'] : null
	const userId = typeof row['user_id'] === 'string' ? row['user_id'] : null
	if (!id || !userId) return null
	return {
		id,
		userId,
		rawMime: typeof row['raw_mime'] === 'string' ? row['raw_mime'] : null,
		rawMimeKey:
			typeof row['raw_mime_key'] === 'string' ? row['raw_mime_key'] : null,
		rawMimeOffloadBlocked: Number(row['raw_mime_offload_blocked'] ?? 0) === 1,
	}
}

export type InlineRawMimeResidualCounts = {
	/** Every row still holding inline raw_mime, blocked or not. */
	remainingInline: number
	/** Unblocked residuals the offload sweep can still process. */
	remainingOffloadableInline: number
	/** Deletion-claimed residuals; deletion owns cleanup. */
	remainingBlockedInline: number
}

/**
 * Single aggregate over residual inline raw_mime rows so production logs can
 * distinguish offloadable work from deletion-owned blocked residuals.
 */
export async function countInlineRawMimeResiduals(
	db: D1Database,
): Promise<InlineRawMimeResidualCounts> {
	const row = await db
		.prepare(
			`SELECT
				COUNT(*) AS remaining_inline,
				COALESCE(SUM(CASE WHEN raw_mime_offload_blocked = 0 THEN 1 ELSE 0 END), 0)
					AS remaining_offloadable_inline,
				COALESCE(SUM(CASE WHEN raw_mime_offload_blocked = 1 THEN 1 ELSE 0 END), 0)
					AS remaining_blocked_inline
			FROM email_messages
			WHERE raw_mime IS NOT NULL`,
		)
		.first<{
			remaining_inline: number
			remaining_offloadable_inline: number
			remaining_blocked_inline: number
		}>()
	return {
		remainingInline: Number(row?.remaining_inline ?? 0),
		remainingOffloadableInline: Number(row?.remaining_offloadable_inline ?? 0),
		remainingBlockedInline: Number(row?.remaining_blocked_inline ?? 0),
	}
}

async function resolveCasMissAfterPut(input: {
	db: D1Database
	blobs: R2Bucket
	id: string
	userId: string
	key: string
}): Promise<'gone' | 'offloaded' | 'skipped' | 'failed'> {
	const current = await readEmailMessageMimeState({
		db: input.db,
		id: input.id,
		userId: input.userId,
	})
	if (!current) {
		// Row deleted while we held the new blob: remove the orphan or fail the
		// row so deploy does not report success with a stranded object.
		await cleanupOrphanRawMimeBlob({
			db: input.db,
			blobs: input.blobs,
			objectKey: input.key,
			userId: input.userId,
			messageId: input.id,
		})
		return 'gone'
	}
	if (current.rawMimeOffloadBlocked) {
		// Deletion claimed the row: drop our just-put blob and skip. Do not count
		// as offloaded; cleanup failure must fail the row.
		await cleanupOrphanRawMimeBlob({
			db: input.db,
			blobs: input.blobs,
			objectKey: input.key,
			userId: input.userId,
			messageId: input.id,
		})
		return 'skipped'
	}
	if (current.rawMime == null && current.rawMimeKey != null) {
		// Already offloaded (possibly by a concurrent worker). Drop our put only
		// when it targeted a different key than the row now points at.
		if (current.rawMimeKey !== input.key) {
			await cleanupOrphanRawMimeBlob({
				db: input.db,
				blobs: input.blobs,
				objectKey: input.key,
				userId: input.userId,
				messageId: input.id,
			})
		}
		return 'offloaded'
	}
	return 'failed'
}

/**
 * Process one bounded cleanup-queue batch, then one bounded batch of residual
 * inline `raw_mime` rows: put each payload into EMAIL_BLOBS under
 * `emailRawMimeKey(userId, id)`, then clear the D1 column only after a
 * successful put. Dual-state rows treat inline bytes as authoritative. When a
 * prior stored key diverges from the deterministic key, clean it through the
 * sticky queue after a successful clear. Callers (deploy) loop until
 * `complete` is true.
 */
export async function offloadInlineEmailRawMime(input: {
	db: D1Database
	blobs: R2Bucket
	pageSize?: number
}) {
	const pageSize = Math.max(
		1,
		Math.min(
			input.pageSize ?? emailRawMimeOffloadPageSize,
			emailRawMimeOffloadPageSize,
		),
	)

	const cleanup = await processCleanupQueueBatch({
		db: input.db,
		blobs: input.blobs,
		pageSize,
	})

	const rows = await listEmailMessagesWithInlineRawMimeBatch({
		db: input.db,
		limit: pageSize,
	})

	let scanned = 0
	let offloaded = 0
	let inlineFailed = 0

	for (const row of rows) {
		scanned += 1
		const key = emailRawMimeKey(row.userId, row.id)
		try {
			await input.blobs.put(key, row.rawMime)
			const cleared = await clearInlineRawMimeAfterOffload({
				db: input.db,
				id: row.id,
				userId: row.userId,
				rawMimeKey: key,
			})
			if (cleared) {
				await cleanupDivergentPriorRawMimeKey({
					db: input.db,
					blobs: input.blobs,
					userId: row.userId,
					messageId: row.id,
					priorRawMimeKey: row.priorRawMimeKey,
					newRawMimeKey: key,
				})
				offloaded += 1
				continue
			}
			const resolution = await resolveCasMissAfterPut({
				db: input.db,
				blobs: input.blobs,
				id: row.id,
				userId: row.userId,
				key,
			})
			if (resolution === 'offloaded') {
				offloaded += 1
			} else if (resolution === 'failed') {
				inlineFailed += 1
				console.warn(
					'email-raw-mime-offload-row-failed',
					row.id,
					new Error('conditional-update-miss-inline-remains'),
				)
			}
			// resolution === 'gone' | 'skipped': scanned only; orphan cleanup ran.
		} catch (error) {
			inlineFailed += 1
			console.warn('email-raw-mime-offload-row-failed', row.id, error)
		}
	}

	const residuals = await countInlineRawMimeResiduals(input.db)
	const remainingBlobCleanup = await countRemainingBlobCleanup(input.db)
	const failed = cleanup.failed + inlineFailed
	return {
		scanned,
		offloaded,
		failed,
		cleanup,
		remainingBlobCleanup,
		...residuals,
		// Sticky across requests: complete only when both the cleanup queue and
		// every unblocked inline residual are gone. Blocked inline rows remain
		// visible via remainingBlockedInline / remainingInline for Stage 4.
		complete:
			residuals.remainingOffloadableInline === 0 && remainingBlobCleanup === 0,
	}
}

/**
 * `POST /__maintenance/offload-email-raw-mime`: secret-gated, idempotent
 * single-batch offload of legacy inline `email_messages.raw_mime` into
 * EMAIL_BLOBS. Authenticated with Bearer `CAPABILITY_REINDEX_SECRET`.
 * Incomplete progress with `failed=0` returns HTTP 200 / `ok=true`; any row
 * failure returns HTTP 500.
 */
export async function handleEmailRawMimeOffloadRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	return handleSecretMaintenanceRequest({
		request,
		secret: env.CAPABILITY_REINDEX_SECRET,
		notConfiguredMessage: 'Email raw MIME offload is not configured',
		run: async () => {
			const result = await offloadInlineEmailRawMime({
				db: env.APP_DB,
				blobs: env.EMAIL_BLOBS,
			})
			if (result.failed > 0) {
				throw new MaintenanceFailureError(
					`Email raw MIME offload failed for ${result.failed} row(s)`,
					result,
				)
			}
			return result
		},
	})
}
