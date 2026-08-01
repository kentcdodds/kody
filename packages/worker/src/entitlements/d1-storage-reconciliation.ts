import { type UserMeterEnv } from './user-meter-client.ts'
import {
	listUsersForD1StorageReconciliation,
	markUserD1StorageReconciliationAttempt,
	reconcileUserD1StorageBytes,
} from './service.ts'

/**
 * Corrective physical-storage reconciliation under UserMeter authority.
 * Recomputes a small, oldest-first page of per-user storage bytes from D1
 * payload tables, applies the result to UserMeter via a revision-guarded CAS
 * (never clobbers a live reservation), then mirrors the same absolute to D1.
 *
 * Result codes:
 * - `updated` — CAS applied (or cold init succeeded); UserMeter and D1 updated.
 * - `deferred` — CAS missed a concurrent reserve, or an init race was detected;
 *   the row is rotated to the back of the queue for the next sweep. A deferred
 *   row is **not** a failure.
 * - `failed` — unexpected error; row moved to back of queue.
 *
 * Row failures do not fail the lane; `env` is required (UserMeter is the
 * post-flip authority).
 */
export const d1StorageReconciliationBatchSize = 8

export async function reconcileD1StorageBytes(input: {
	db: D1Database
	now?: Date
	batchSize?: number
	/** Required: UserMeter is authoritative after the cutover. */
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
				// Rotate a deferred row so it is retried on the next sweep.
				await markUserD1StorageReconciliationAttempt({
					db: input.db,
					userId: row.userId,
					now,
				}).catch(() => undefined)
			}
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
	return { scanned: rows.length, updated, failed, deferred }
}
