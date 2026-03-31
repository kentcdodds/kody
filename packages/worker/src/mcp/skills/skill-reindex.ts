import {
	CAPABILITY_EMBEDDING_MODEL,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#mcp/capabilities/capability-search.ts'
import { buildSkillEmbedTextFromStoredRow } from './skill-mutation.ts'
import { listAllMcpSkills, skillVectorId } from './mcp-skills-repo.ts'

const upsertBatchSize = 16

/**
 * Re-embeds every user skill and upserts into `CAPABILITY_VECTOR_INDEX`
 * (`skill_<uuid>` ids). Use when skill rows in D1 and Vectorize are out of sync
 * (e.g. after a restore or manual D1 edits without a corresponding Vectorize upsert).
 */
export async function reindexSkillVectors(env: Env): Promise<{
	upserted: number
}> {
	const index = getCapabilityVectorIndex(env)
	if (!index) {
		throw new Error('CAPABILITY_VECTOR_INDEX binding is not configured')
	}
	if (isCapabilitySearchOffline(env)) {
		return { upserted: 0 }
	}

	const rows = await listAllMcpSkills(env.APP_DB)
	if (rows.length === 0) {
		return { upserted: 0 }
	}

	let upserted = 0

	for (let offset = 0; offset < rows.length; offset += upsertBatchSize) {
		const batch = rows.slice(offset, offset + upsertBatchSize)
		const embedTexts = await Promise.all(
			batch.map((row) => buildSkillEmbedTextFromStoredRow(row)),
		)
		const result = (await env.AI.run(CAPABILITY_EMBEDDING_MODEL, {
			text: embedTexts,
			pooling: 'mean',
		})) as { data?: Array<Array<number>> }

		const vecRows = result.data
		if (!vecRows || vecRows.length !== batch.length) {
			throw new Error('Workers AI embedding batch size mismatch for skills')
		}

		const vectors = batch.map((row, index_) => ({
			id: skillVectorId(row.id),
			values: vecRows[index_]!,
			metadata: {
				kind: 'skill',
				userId: row.user_id,
				...(row.collection_slug ? { collectionSlug: row.collection_slug } : {}),
			},
		}))

		await index.upsert(vectors)
		upserted += vectors.length
	}

	return { upserted }
}
