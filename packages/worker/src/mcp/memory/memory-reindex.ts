import {
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#mcp/capabilities/capability-search.ts'
import {
	reindexVectorCandidates,
	type VectorReindexResult,
} from '#mcp/capabilities/reindex-batches.ts'
import { buildMemoryEmbedTextFromRow } from './memory-embed.ts'
import { listAllMemories } from './repo.ts'
import { memoryVectorId } from './memory-vectorize.ts'

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

	const rows = await listAllMemories({
		db: env.APP_DB,
	})
	if (rows.length === 0) {
		return { upserted: 0 }
	}

	return reindexVectorCandidates({
		env,
		index,
		kind: 'memory',
		candidates: rows.map((row) => ({
			id: memoryVectorId(row.id),
			text: buildMemoryEmbedTextFromRow(row),
			metadata: {
				kind: 'memory',
				userId: row.user_id,
				status: row.status,
				...(row.category ? { category: row.category } : {}),
			},
		})),
	})
}
