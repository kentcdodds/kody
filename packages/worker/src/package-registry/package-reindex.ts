import {
	embedTextsForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#mcp/capabilities/capability-search.ts'
import { getErrorMessage } from '#mcp/capabilities/error-message.ts'
import { buildSavedPackageEmbedText } from './embed.ts'
import { listAllSavedPackages, savedPackageVectorId } from './repo.ts'
import { loadPackageManifestBySourceId } from './source.ts'

const upsertBatchSize = 16

export async function reindexSavedPackageVectors(
	env: Env,
	input: { baseUrl: string },
): Promise<{ upserted: number; failed?: number; error?: string }> {
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
	let failed = 0
	for (let offset = 0; offset < rows.length; offset += upsertBatchSize) {
		const batch = rows.slice(offset, offset + upsertBatchSize)
		const loaded: Array<{ row: (typeof batch)[number]; embedText: string }> = []
		for (const row of batch) {
			try {
				const { manifest } = await loadPackageManifestBySourceId({
					env,
					baseUrl: input.baseUrl,
					userId: row.userId,
					sourceId: row.sourceId,
				})
				loaded.push({
					row,
					embedText: buildSavedPackageEmbedText(manifest),
				})
			} catch (error) {
				failed += 1
				console.error(
					JSON.stringify({
						message: 'saved package vector reindex skipped package',
						packageId: row.id,
						sourceId: row.sourceId,
						error: getErrorMessage(error),
					}),
				)
			}
		}
		if (loaded.length === 0) continue
		const vectors = await embedTextsForVectorize(
			env,
			loaded.map(({ embedText }) => embedText),
		)
		await index.upsert(
			loaded.map(({ row }, index_) => ({
				id: savedPackageVectorId(row.id),
				values: vectors[index_]!,
				metadata: {
					kind: 'package',
					userId: row.userId,
				},
			})),
		)
		upserted += loaded.length
	}

	return failed > 0
		? {
				upserted,
				failed,
				error: `${failed} saved package vector(s) failed to reindex`,
			}
		: { upserted }
}
