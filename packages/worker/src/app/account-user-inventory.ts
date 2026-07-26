import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { listPackageServices } from '#worker/package-registry/manifest.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { buildPackageServiceStorageId } from '#worker/package-runtime/package-service.ts'
import { listRunRecordStorageIds } from '#worker/run-records/service.ts'
import { listUserStorageBucketIds } from '#worker/storage-buckets/service.ts'

export type AccountUserPackageService = {
	packageId: string
	kodyId: string
	sourceId: string
	serviceName: string
}

function uniqueStrings(values: Iterable<string | null | undefined>) {
	return Array.from(
		new Set(
			Array.from(values)
				.map((value) => value?.trim() ?? '')
				.filter((value) => value.length > 0),
		),
	)
}

function packageServiceKey(service: AccountUserPackageService) {
	return `${service.packageId}\0${service.serviceName}`
}

/**
 * Enumerate package services for account deletion and one-shot full export
 * inventory. Not for paginated export discovery — that path uses D1 keyset SQL
 * only (see account-export durable_object_summaries).
 *
 * Authoritative sources are the package manifest (`kody.services`) unioned with
 * projected `package_service_states` rows. Manifest loads can fail (network /
 * source bindings); those failures warn and fall back to state-table rows so
 * deletion never aborts for a missing manifest.
 */
export async function listAccountUserPackageServices(input: {
	env: Env
	userId: string
	baseUrl: string
}): Promise<Array<AccountUserPackageService>> {
	const stateRows = await input.env.APP_DB.prepare(
		`SELECT
			s.package_id AS package_id,
			p.kody_id AS kody_id,
			p.source_id AS source_id,
			s.service_name AS name
		FROM package_service_states AS s
		LEFT JOIN saved_packages AS p
			ON p.id = s.package_id AND p.user_id = s.user_id
		WHERE s.user_id = ?`,
	)
		.bind(input.userId)
		.all<{
			package_id: string
			kody_id: string | null
			source_id: string | null
			name: string
		}>()

	const byKey = new Map<string, AccountUserPackageService>()
	for (const row of stateRows.results ?? []) {
		const service: AccountUserPackageService = {
			packageId: row.package_id,
			kodyId: row.kody_id ?? '',
			sourceId: row.source_id ?? '',
			serviceName: row.name,
		}
		byKey.set(packageServiceKey(service), service)
	}

	try {
		const packages = await listSavedPackagesByUserId(input.env.APP_DB, {
			userId: input.userId,
		})
		for (const savedPackage of packages) {
			try {
				const loaded = await loadPackageManifestBySourceId({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.userId,
					sourceId: savedPackage.sourceId,
				})
				for (const service of listPackageServices(loaded.manifest)) {
					const entry: AccountUserPackageService = {
						packageId: savedPackage.id,
						kodyId: savedPackage.kodyId,
						sourceId: savedPackage.sourceId,
						serviceName: service.name,
					}
					const key = packageServiceKey(entry)
					const existing = byKey.get(key)
					if (existing) {
						byKey.set(key, {
							packageId: existing.packageId,
							kodyId: existing.kodyId || entry.kodyId,
							sourceId: existing.sourceId || entry.sourceId,
							serviceName: existing.serviceName,
						})
						continue
					}
					byKey.set(key, entry)
				}
			} catch (error) {
				console.warn(
					`Failed to load package manifest for service enumeration (package ${savedPackage.id}): ${getErrorMessage(error)}`,
				)
			}
		}
	} catch (error) {
		console.warn(
			`Failed to enumerate package services from manifests for user ${input.userId}: ${getErrorMessage(error)}`,
		)
	}

	return Array.from(byKey.values()).sort((left, right) => {
		const byPackage = left.packageId.localeCompare(right.packageId)
		if (byPackage !== 0) return byPackage
		return left.serviceName.localeCompare(right.serviceName)
	})
}

/**
 * Enumerate StorageRunner bucket ids for account deletion and one-shot full
 * export inventory. Not for paginated export discovery — that path uses D1
 * keyset SQL only (see account-export durable_object_summaries).
 *
 * Unions authoritative entity tables, the user storage-bucket registry,
 * declared/projected package services, and current RunLog ids.
 */
export async function listAccountUserStorageIds(input: {
	env: Env
	userId: string
	baseUrl: string
}): Promise<Array<string>> {
	const [
		jobRows,
		archivedRows,
		bucketIds,
		packageRows,
		packageServices,
		runRecordStorageIds,
	] = await Promise.all([
		input.env.APP_DB.prepare(
			`SELECT storage_id FROM jobs WHERE user_id = ? AND storage_id IS NOT NULL`,
		)
			.bind(input.userId)
			.all<{ storage_id: string }>(),
		input.env.APP_DB.prepare(
			`SELECT storage_id FROM archived_job_artifacts WHERE user_id = ? AND storage_id IS NOT NULL`,
		)
			.bind(input.userId)
			.all<{ storage_id: string }>(),
		listUserStorageBucketIds({
			env: input.env,
			userId: input.userId,
		}),
		input.env.APP_DB.prepare(
			`SELECT id FROM saved_packages WHERE user_id = ? AND has_app = 1`,
		)
			.bind(input.userId)
			.all<{ id: string }>(),
		listAccountUserPackageServices(input),
		listRunRecordStorageIds({ env: input.env, userId: input.userId }),
	])
	return uniqueStrings([
		...(jobRows.results ?? []).map((row) => row.storage_id),
		...(archivedRows.results ?? []).map((row) => row.storage_id),
		...bucketIds,
		...(packageRows.results ?? []).map((row) => row.id),
		...packageServices.map((service) =>
			buildPackageServiceStorageId(service.packageId, service.serviceName),
		),
		...runRecordStorageIds,
	])
}
