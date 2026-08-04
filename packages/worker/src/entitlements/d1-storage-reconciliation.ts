import { type UserMeterEnv } from './user-meter-client.ts'
import {
	listUsersForD1StorageReconciliation,
	markUserD1StorageReconciliationAttempt,
	reconcileUserD1StorageBytes,
} from './service.ts'

/**
 * Corrective physical-storage reconciliation under UserMeter authority.
 * Recomputes a small, oldest-first page of per-user storage bytes from D1
 * payload tables and applies the result to UserMeter via a revision-guarded
 * CAS (never clobbers a live reservation).
 *
 * Result codes:
 * - `updated` — CAS applied (or cold init succeeded); UserMeter updated.
 * - `deferred` — CAS missed a concurrent reserve, or an init race was detected;
 *   the row is rotated to the back of the queue for the next sweep. A deferred
 *   row is **not** a failure.
 * - `failed` — unexpected error; row moved to back of queue.
 *
 * Every processed row is rotated to the back of the sweep queue
 * (`users.d1_storage_bytes_updated_at` is the rotation cursor only — no byte
 * values are written to D1). Row failures do not fail the lane; `env` is
 * required (UserMeter is the authority).
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
			}
		} catch (error) {
			failed += 1
			console.warn('d1-storage-reconciliation-row-failed', row.userId, error)
		}
		// Rotate every processed row to the back of the oldest-first queue so
		// the bounded sweep advances through the remaining users.
		await markUserD1StorageReconciliationAttempt({
			db: input.db,
			userId: row.userId,
			now,
		}).catch(() => undefined)
	}
	return { scanned: rows.length, updated, failed, deferred }
}
