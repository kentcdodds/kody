import {
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#worker/vectorize/embedding.ts'
import {
	mergeVectorReindexResults,
	reindexVectorCandidates,
	type VectorReindexResult,
} from '#worker/vectorize/reindex-batches.ts'
import { userVectorNamespace } from '#worker/vectorize/vector-namespaces.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { buildMemoryEmbedTextFromRow } from './memory-embed.ts'
import { listMemoriesPage } from './repo.ts'
import { memoryVectorId } from './memory-vectorize.ts'

// Memories are reindexed in keyset-paged batches so memory stays bounded
// regardless of table size.
const reindexPageSize = 200

export async function reindexMemoryVectors(
	env: Env,
): Promise<VectorReindexResult> {
	const index = getCapabilityVectorIndex(env)
	if (!index) {
		throw new Error('CAPABILITY_VECTOR_INDEX binding is not configured')
	}
	if (isCapabilitySearchOffline(env)) {
		return { upserted: 0 }
	}

	const pageResults: Array<VectorReindexResult> = []
	let afterId: string | null = null
	while (true) {
		const rows = await runD1WithRetry(() =>
			listMemoriesPage({
				db: env.APP_DB,
				afterId,
				limit: reindexPageSize,
			}),
		)
		if (rows.length === 0) break
		pageResults.push(
			await reindexVectorCandidates({
				env,
				index,
				kind: 'memory',
				candidates: rows.map((row) => ({
					id: memoryVectorId(row.id),
					text: buildMemoryEmbedTextFromRow(row),
					namespace: userVectorNamespace(row.user_id),
					metadata: {
						kind: 'memory',
						userId: row.user_id,
						status: row.status,
						...(row.category ? { category: row.category } : {}),
					},
				})),
			}),
		)
		if (rows.length < reindexPageSize) break
		afterId = rows[rows.length - 1]!.id
	}
	return mergeVectorReindexResults('memory', pageResults)
}
