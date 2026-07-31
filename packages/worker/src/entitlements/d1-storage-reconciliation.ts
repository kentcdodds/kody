import {
	listUsersForD1StorageReconciliation,
	markUserD1StorageReconciliationAttempt,
	reconcileUserD1StorageBytes,
} from './service.ts'

/**
 * Recomputes a small, oldest-first page of per-user D1 storage counters.
 * Reservations keep the hot path conservative between sweeps; this lane
 * corrects drift from deletes, failed writes after reservation, and D1
 * surfaces whose writes do not pass through storage-byte enforcement.
 */
export const d1StorageReconciliationBatchSize = 8

export async function reconcileD1StorageBytes(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}): Promise<{ scanned: number; updated: number; failed: number }> {
	const now = input.now ?? new Date()
	const rows = await listUsersForD1StorageReconciliation({
		db: input.db,
		limit: input.batchSize ?? d1StorageReconciliationBatchSize,
	})
	let updated = 0
	let failed = 0
	for (const row of rows) {
		try {
			const result = await reconcileUserD1StorageBytes({
				db: input.db,
				userId: row.userId,
				now,
			})
			if (result.updated) updated += 1
		} catch (error) {
			failed += 1
			// Move a poison row to the back of the oldest-first queue while
			// retaining its conservative counter. It will be retried after the
			// bounded sweep rotates through the remaining users.
			await markUserD1StorageReconciliationAttempt({
				db: input.db,
				userId: row.userId,
				now,
			}).catch(() => undefined)
			console.warn('d1-storage-reconciliation-row-failed', row.userId, error)
		}
	}
	return { scanned: rows.length, updated, failed }
}
