import {
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#worker/vectorize/embedding.ts'
import {
	reindexPagedVectorRows,
	type VectorReindexSweepOptions,
	type VectorReindexSweepResult,
} from '#worker/vectorize/reindex-sweep.ts'
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
	options?: VectorReindexSweepOptions,
): Promise<VectorReindexSweepResult> {
	const index = getCapabilityVectorIndex(env)
	if (!index) {
		throw new Error('CAPABILITY_VECTOR_INDEX binding is not configured')
	}
	if (isCapabilitySearchOffline(env)) {
		return { upserted: 0, complete: true, afterId: null }
	}

	return reindexPagedVectorRows({
		env,
		index,
		kind: 'memory',
		pageSize: reindexPageSize,
		afterId: options?.afterId,
		deadlineMs: options?.deadlineMs,
		listPage: ({ afterId, limit }) =>
			runD1WithRetry(() =>
				listMemoriesPage({
					db: env.APP_DB,
					afterId,
					limit,
				}),
			),
		rowId: (row) => row.id,
		toCandidate: (row) => ({
			id: memoryVectorId(row.id),
			text: buildMemoryEmbedTextFromRow(row),
			namespace: userVectorNamespace(row.user_id),
			metadata: {
				kind: 'memory',
				userId: row.user_id,
				status: row.status,
				...(row.category ? { category: row.category } : {}),
			},
		}),
	})
}
