import {
	CAPABILITY_EMBEDDING_MODEL,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#mcp/capabilities/capability-search.ts'
import { buildMemoryEmbedTextFromRow } from './memory-embed.ts'
import { listAllMemories } from './repo.ts'
import { memoryVectorId } from './memory-vectorize.ts'

const upsertBatchSize = 16

export async function reindexMemoryVectors(env: Env): Promise<{
	upserted: number
}> {
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

	let upserted = 0
	for (let offset = 0; offset < rows.length; offset += upsertBatchSize) {
		const batch = rows.slice(offset, offset + upsertBatchSize)
		const texts = batch.map((row) => buildMemoryEmbedTextFromRow(row))
		const result = (await env.AI.run(CAPABILITY_EMBEDDING_MODEL, {
			text: texts,
			pooling: 'mean',
		})) as { data?: Array<Array<number>> }
		const vectors = result.data
		if (!vectors || vectors.length !== batch.length) {
			throw new Error('Workers AI embedding batch size mismatch for memories')
		}
		await index.upsert(
			batch.map((row, index_) => ({
				id: memoryVectorId(row.id),
				values: vectors[index_]!,
				metadata: {
					kind: 'memory',
					userId: row.user_id,
					status: row.status,
					...(row.category ? { category: row.category } : {}),
				},
			})),
		)
		upserted += batch.length
	}

	return { upserted }
}
