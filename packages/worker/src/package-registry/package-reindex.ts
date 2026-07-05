import {
	embedTextsForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#mcp/capabilities/capability-search.ts'
import {
	buildPackageSearchDocument,
	type PackageSearchProjection,
} from './manifest.ts'
import { listAllSavedPackages, savedPackageVectorId } from './repo.ts'
import { type SavedPackageRecord } from './types.ts'

const upsertBatchSize = 16

function buildSavedPackageRecordEmbedText(record: SavedPackageRecord): string {
	const projection = {
		name: record.name,
		kodyId: record.kodyId,
		description: record.description,
		tags: record.tags,
		searchText: record.searchText,
		hasApp: record.hasApp,
		appEntry: null,
		exports: [],
		jobs: [],
		services: [],
		subscriptions: [],
		emits: [],
		retrievers: [],
	} satisfies PackageSearchProjection

	return buildPackageSearchDocument(projection).slice(0, 8_000)
}

export async function reindexSavedPackageVectors(
	env: Env,
): Promise<{ upserted: number }> {
	const index = getCapabilityVectorIndex(env)
	if (!index) {
		throw new Error('CAPABILITY_VECTOR_INDEX binding is not configured')
	}
	if (isCapabilitySearchOffline(env)) {
		return { upserted: 0 }
	}

	const rows = await listAllSavedPackages(env.APP_DB)
	if (rows.length === 0) {
		return { upserted: 0 }
	}

	let upserted = 0
	for (let offset = 0; offset < rows.length; offset += upsertBatchSize) {
		const batch = rows.slice(offset, offset + upsertBatchSize)
		const vectors = await embedTextsForVectorize(
			env,
			batch.map((row) => buildSavedPackageRecordEmbedText(row)),
		)
		await index.upsert(
			batch.map((row, index_) => ({
				id: savedPackageVectorId(row.id),
				values: vectors[index_]!,
				metadata: {
					kind: 'package',
					userId: row.userId,
				},
			})),
		)
		upserted += batch.length
	}

	return { upserted }
}
