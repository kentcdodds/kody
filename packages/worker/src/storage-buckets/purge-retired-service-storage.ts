import { storageRunnerRpc } from '#worker/storage-runner.ts'
import { deleteStorageBucketInventory } from './service.ts'

/**
 * Retired package-service inventory kind. The live `StorageBucketKind` union
 * no longer includes it; leftover rows stay until this purge clears the
 * matching StorageRunner Durable Objects.
 */
const retiredServiceStorageBucketKind = 'service'

export const retiredServiceStoragePurgeBatchSize = 24

export async function listRetiredServiceStorageBuckets(input: {
	db: D1Database
	limit: number
}): Promise<Array<{ userId: string; storageId: string }>> {
	const result = await input.db
		.prepare(
			`SELECT user_id AS userId, storage_id AS storageId
			FROM user_storage_buckets
			WHERE kind = ?
			ORDER BY user_id ASC, storage_id ASC
			LIMIT ?`,
		)
		.bind(retiredServiceStorageBucketKind, input.limit)
		.all<{ userId: string; storageId: string }>()
	return result.results ?? []
}

/**
 * Clear leftover package-service StorageRunner Durable Objects, then delete
 * their inventory rows. D1 cannot delete Durable Objects, so migration 0016
 * keeps these rows as the only user→storage_id map for export, deletion, and
 * DR until this purge succeeds. A failed clear leaves the row in place.
 */
export async function purgeRetiredServiceStorageBuckets(input: {
	env: Env
	limit?: number
}): Promise<{ scanned: number; purged: number; failed: number }> {
	const rows = await listRetiredServiceStorageBuckets({
		db: input.env.APP_DB,
		limit: input.limit ?? retiredServiceStoragePurgeBatchSize,
	})
	let purged = 0
	let failed = 0
	for (const row of rows) {
		try {
			await storageRunnerRpc({
				env: input.env,
				userId: row.userId,
				storageId: row.storageId,
			}).clearStorage()
			await deleteStorageBucketInventory({
				db: input.env.APP_DB,
				userId: row.userId,
				storageId: row.storageId,
			})
			purged += 1
		} catch (error) {
			failed += 1
			console.warn(
				'retired-service-storage-purge-row-failed',
				row.storageId,
				error,
			)
		}
	}
	return { scanned: rows.length, purged, failed }
}
