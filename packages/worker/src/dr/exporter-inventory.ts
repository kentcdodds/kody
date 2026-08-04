import { buildPackageServiceStorageId } from '#worker/package-runtime/package-service.ts'
import { listPlatformStorageBuckets } from '#worker/storage-buckets/service.ts'
import { encodeStorageIdentity } from '#worker/dr/storage-identity.ts'

export type StorageInventoryEntry = {
	userId: string
	storageId: string
	identity: string
}

export type ArtifactInventoryEntry = {
	sourceId: string
	userId: string
	entityKind: string
	entityId: string
	publishedCommit: string
}

export async function listPlatformOwnerInventory(
	db: D1Database,
): Promise<Array<string>> {
	const result = await db
		.prepare(
			`SELECT stable_user_id AS ownerId
			FROM users
			WHERE deleting_at IS NULL
			ORDER BY stable_user_id ASC`,
		)
		.all<{ ownerId: string }>()
	return (result.results ?? []).map((row) => row.ownerId)
}

/**
 * Platform-wide StorageRunner inventory.
 *
 * Deliberate exception to per-user scoping: this operator-level DR exporter
 * iterates every user's storage ids so the sealed day can rebuild the whole
 * platform. Do not copy this pattern into user-facing read/write paths.
 */
export async function listPlatformStorageInventory(
	db: D1Database,
): Promise<Array<StorageInventoryEntry>> {
	// Platform-wide DR has only a D1Database (no per-user Env / network), so
	// service buckets come from projected `package_service_states` rather than
	// package manifests. Ad-hoc / execute buckets come from the authoritative
	// `user_storage_buckets` registry via `listPlatformStorageBuckets`.
	const [jobRows, archivedRows, registeredBuckets, serviceRows] =
		await Promise.all([
			db
				.prepare(
					`SELECT user_id AS userId, storage_id AS storageId
					FROM jobs WHERE storage_id IS NOT NULL`,
				)
				.all<{ userId: string; storageId: string }>(),
			db
				.prepare(
					`SELECT user_id AS userId, storage_id AS storageId
					FROM archived_job_artifacts WHERE storage_id IS NOT NULL`,
				)
				.all<{ userId: string; storageId: string }>(),
			listPlatformStorageBuckets({ db }),
			db
				.prepare(
					`SELECT DISTINCT user_id AS userId, package_id AS packageId,
						service_name AS serviceName
					FROM package_service_states`,
				)
				.all<{
					userId: string
					packageId: string
					serviceName: string
				}>(),
		])

	const seen = new Set<string>()
	const inventory: Array<StorageInventoryEntry> = []
	function push(userId: string, storageId: string) {
		const identity = encodeStorageIdentity(userId, storageId)
		if (seen.has(identity)) return
		seen.add(identity)
		inventory.push({ userId, storageId, identity })
	}
	for (const row of jobRows.results ?? []) push(row.userId, row.storageId)
	for (const row of archivedRows.results ?? []) push(row.userId, row.storageId)
	for (const row of registeredBuckets) push(row.userId, row.storageId)
	for (const row of serviceRows.results ?? []) {
		push(
			row.userId,
			buildPackageServiceStorageId(row.packageId, row.serviceName),
		)
	}
	inventory.sort((left, right) => left.identity.localeCompare(right.identity))
	return inventory
}

export async function listPlatformArtifactInventory(
	db: D1Database,
): Promise<Array<ArtifactInventoryEntry>> {
	const result = await db
		.prepare(
			`SELECT id AS sourceId, user_id AS userId, entity_kind AS entityKind,
				entity_id AS entityId, published_commit AS publishedCommit
			FROM entity_sources
			WHERE published_commit IS NOT NULL AND trim(published_commit) != ''
			ORDER BY id ASC`,
		)
		.all<ArtifactInventoryEntry>()
	return result.results ?? []
}
