import {
	listStorageBucketsMissingEstimates,
	registerMissingRepoSessionStorageBuckets,
	updateStorageBucketEstimate,
} from './service.ts'
import { readInventoriedStorageBucketEstimatedBytes } from '#worker/storage-runner.ts'

/**
 * Cron lane that seeds `user_storage_buckets.estimated_bytes` for
 * StorageRunner and RepoSession inventory rows that have never been measured.
 * Without this, each user's first mutating storage write after deploy pays —
 * and can fail on — a live estimate probe of every unmeasured bucket. With it,
 * inventories converge to "every bucket has a stored estimate" within a few
 * 5-minute ticks and the write path is left with only the target-bucket probe.
 *
 * Failures are per bucket: a bucket whose probe fails stays NULL and is
 * retried on a later sweep; it never blocks the rest of the batch. The lane
 * uses a short retry policy (the write path carries the strong one) because
 * sweep retries are free.
 */

export const storageBucketEstimateBackfillBatchSize = 24
export const maxConcurrentStorageBucketEstimateBackfillReads = 8
export const storageBucketEstimateBackfillRetryDelaysMs = [150] as const

export async function backfillStorageBucketEstimates(input: {
	env: Env
	now?: Date
	batchSize?: number
}): Promise<{ scanned: number; updated: number; failed: number }> {
	const batchSize = input.batchSize ?? storageBucketEstimateBackfillBatchSize
	// Recover active repo sessions whose awaited open-time registration lost
	// its D1 write (registration is deliberately non-blocking for the
	// session). Race-safe: the statement filters on active status, so it can
	// never recreate a row lifecycle cleanup removed. Newly inserted rows have
	// NULL estimates and are picked up by this same sweep.
	await registerMissingRepoSessionStorageBuckets({
		db: input.env.APP_DB,
		env: input.env,
		limit: batchSize,
	}).catch((error: unknown) => {
		console.warn('repo-session-bucket-reconcile-failed', error)
	})
	const rows = await listStorageBucketsMissingEstimates({
		db: input.env.APP_DB,
		limit: batchSize,
	})
	let updated = 0
	let failed = 0
	for (
		let offset = 0;
		offset < rows.length;
		offset += maxConcurrentStorageBucketEstimateBackfillReads
	) {
		const chunk = rows.slice(
			offset,
			offset + maxConcurrentStorageBucketEstimateBackfillReads,
		)
		const results = await Promise.allSettled(
			chunk.map(async (row) => {
				const estimatedBytes = await readInventoriedStorageBucketEstimatedBytes(
					{
						env: input.env,
						userId: row.userId,
						storageId: row.storageId,
						kind: row.kind,
						retryDelaysMs: storageBucketEstimateBackfillRetryDelaysMs,
					},
				)
				await updateStorageBucketEstimate({
					db: input.env.APP_DB,
					userId: row.userId,
					storageId: row.storageId,
					estimatedBytes,
					updatedAt: input.now,
				})
			}),
		)
		for (const [index, result] of results.entries()) {
			if (result.status === 'fulfilled') {
				updated += 1
				continue
			}
			failed += 1
			console.warn(
				'storage-bucket-estimate-backfill-row-failed',
				chunk[index]?.storageId ?? 'unknown',
				result.reason,
			)
		}
	}
	return { scanned: rows.length, updated, failed }
}
