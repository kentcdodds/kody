import {
	embedTextsForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#mcp/capabilities/capability-search.ts'
import { buildSavedPackageEmbedText } from './embed.ts'
import { listAllSavedPackages, savedPackageVectorId } from './repo.ts'
import { loadPackageManifestBySourceId } from './source.ts'

const upsertBatchSize = 16

export async function reindexSavedPackageVectors(
	env: Env,
	input: { baseUrl: string },
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
		const manifests = await Promise.all(
			batch.map((row) =>
				loadPackageManifestBySourceId({
					env,
					baseUrl: input.baseUrl,
					userId: row.userId,
					sourceId: row.sourceId,
				}),
			),
		)
		const vectors = await embedTextsForVectorize(
			env,
			manifests.map(({ manifest }) => buildSavedPackageEmbedText(manifest)),
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
