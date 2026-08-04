import { type UserMeterEnv } from './user-meter-client.ts'
import {
	advanceD1StorageReconciliationCursor,
	listUsersForD1StorageReconciliation,
	reconcileUserD1StorageBytes,
} from './service.ts'

/**
 * Corrective physical-storage reconciliation under UserMeter authority.
 * Recomputes a small keyset page of per-user storage bytes from D1 payload
 * tables and applies the result to UserMeter via a revision-guarded CAS
 * (never clobbers a live reservation).
 *
 * Result codes:
 * - `updated` — CAS applied (or cold init succeeded); UserMeter updated.
 * - `deferred` — CAS missed a concurrent reserve, or an init race was
 *   detected; the row is retried on the next full sweep wrap. A deferred row
 *   is **not** a failure.
 * - `failed` — unexpected error; retried on the next sweep wrap.
 *
 * Pages walk `users.stable_user_id` ascending from the platform-owned
 * `d1_storage_reconcile_cursor` singleton, wrapping at the tail. Row failures
 * do not fail the lane; `env` is required (UserMeter is the authority).
 */
export const d1StorageReconciliationBatchSize = 8

export async function reconcileD1StorageBytes(input: {
	db: D1Database
	now?: Date
	batchSize?: number
	/** Required because UserMeter is the storage-usage authority. */
	env: UserMeterEnv
}): Promise<{
	scanned: number
	updated: number
	failed: number
	deferred: number
}> {
	const now = input.now ?? new Date()
	const rows = await listUsersForD1StorageReconciliation({
		db: input.db,
		limit: input.batchSize ?? d1StorageReconciliationBatchSize,
	})
	let updated = 0
	let failed = 0
	let deferred = 0
	for (const row of rows) {
		try {
			const result = await reconcileUserD1StorageBytes({
				db: input.db,
				env: input.env,
				userId: row.userId,
				now,
			})
			if (result.updated) {
				updated += 1
			} else if (result.deferred) {
				deferred += 1
			}
		} catch (error) {
			failed += 1
			console.warn('d1-storage-reconciliation-row-failed', row.userId, error)
		}
	}
	const lastUserId = rows.at(-1)?.userId
	if (lastUserId != null) {
		await advanceD1StorageReconciliationCursor({
			db: input.db,
			lastUserId,
			now,
		}).catch(() => undefined)
	}
	return { scanned: rows.length, updated, failed, deferred }
}
