import {
	deterministicEmbedding,
	embedTextForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#worker/vectorize/embedding.ts'
import {
	CAPABILITY_SEARCH_RRF_K,
	cosineSimilarity,
	lexicalScore,
	reciprocalRankFusion,
	sortIdsByScore,
} from '#worker/vectorize/scoring.ts'
import { getRawIdFromPassthroughVectorId } from '#worker/vectorize/vector-ids.ts'
import { parseJsonStringArray } from './json-string-array.ts'
import { buildMemoryEmbedTextFromRow } from './memory-embed.ts'
import { type McpMemoryRow, type MemorySearchMatch } from './types.ts'

function buildMemoryVectorFilter(input: {
	userId: string
	statuses: ReadonlyArray<McpMemoryRow['status']>
	category?: string | null
}): VectorizeVectorMetadataFilter {
	return {
		kind: { $eq: 'memory' },
		userId: { $eq: input.userId },
		status: { $in: [...input.statuses] },
		...(input.category ? { category: { $eq: input.category } } : {}),
	}
}

/**
 * Queries Vectorize for the user's memory vectors (strict metadata filter on
 * kind, userId, status, and optional category) and returns memory ids ordered
 * by similarity. Returns an empty list when the vector index is unavailable.
 */
export async function queryMemoryVectorIds(input: {
	env: Env
	query: string
	userId: string
	statuses: ReadonlyArray<McpMemoryRow['status']>
	category?: string | null
	topK: number
}): Promise<Array<string>> {
	const index = getCapabilityVectorIndex(input.env)
	if (!index || !input.userId) return []
	const queryVector = await embedTextForVectorize(input.env, input.query)
	const vectorMatches = await index.query(queryVector, {
		topK: input.topK,
		returnMetadata: 'none',
		filter: buildMemoryVectorFilter(input),
	})
	const memoryIds: Array<string> = []
	const seen = new Set<string>()
	for (const match of vectorMatches.matches) {
		if (typeof match.id !== 'string') continue
		const memoryId = getRawIdFromPassthroughVectorId({
			prefix: 'memory',
			vectorId: match.id,
		})
		if (!memoryId || seen.has(memoryId)) continue
		seen.add(memoryId)
		memoryIds.push(memoryId)
	}
	return memoryIds
}

export async function searchMemories(input: {
	env: Env
	query: string
	limit: number
	userId: string
	statuses: ReadonlyArray<McpMemoryRow['status']>
	category?: string | null
	rows: Array<McpMemoryRow>
	vectorRankedIds?: ReadonlyArray<string>
}): Promise<{ matches: Array<MemorySearchMatch>; offline: boolean }> {
	const query = input.query.trim()
	const offline = isCapabilitySearchOffline(input.env)
	if (!query || !input.userId || input.rows.length === 0) {
		return { matches: [], offline }
	}
	if (input.rows.some((row) => row.user_id !== input.userId)) {
		console.warn(
			JSON.stringify({
				message: 'memory search skipped: row userId mismatch',
				expectedUserId: input.userId,
			}),
		)
		return { matches: [], offline }
	}

	const rowsById = new Map(input.rows.map((row) => [row.id, row] as const))
	const ids = [...rowsById.keys()]
	const docsById = Object.fromEntries(
		input.rows.map(
			(row) => [row.id, buildMemoryEmbedTextFromRow(row)] as const,
		),
	)
	const lexicalOrder = sortIdsByScore(ids, (id) =>
		lexicalScore(query, docsById[id]!),
	)

	let vectorOrder: Array<string>
	if (input.vectorRankedIds) {
		vectorOrder = input.vectorRankedIds.filter((id) => rowsById.has(id))
	} else if (offline) {
		const queryVector = deterministicEmbedding(query)
		const similarityById = Object.fromEntries(
			ids.map((id) => {
				const docVector = deterministicEmbedding(docsById[id]!)
				return [id, cosineSimilarity(queryVector, docVector)] as const
			}),
		)
		vectorOrder = sortIdsByScore(ids, (id) => similarityById[id]!)
	} else {
		const index = getCapabilityVectorIndex(input.env)!
		const queryVector = await embedTextForVectorize(input.env, query)
		const topK = Math.min(Math.max(ids.length, input.limit * 5), 100)
		const vectorMatches = await index.query(queryVector, {
			topK,
			returnMetadata: 'none',
			filter: buildMemoryVectorFilter({
				userId: input.userId,
				statuses: input.statuses,
				category: input.category,
			}),
		})
		const seen = new Set<string>()
		const fromIndex: Array<string> = []
		for (const match of vectorMatches.matches) {
			if (typeof match.id !== 'string' || seen.has(match.id)) continue
			const memoryId = getRawIdFromPassthroughVectorId({
				prefix: 'memory',
				vectorId: match.id,
			})
			if (!memoryId || !rowsById.has(memoryId)) continue
			seen.add(match.id)
			fromIndex.push(memoryId)
		}
		vectorOrder = fromIndex
	}

	const lexicalRankById = new Map<string, number>()
	for (let index = 0; index < lexicalOrder.length; index += 1) {
		lexicalRankById.set(lexicalOrder[index]!, index + 1)
	}
	const vectorRankById = new Map<string, number>()
	for (let index = 0; index < vectorOrder.length; index += 1) {
		vectorRankById.set(vectorOrder[index]!, index + 1)
	}

	const fused = reciprocalRankFusion(
		[lexicalOrder, vectorOrder],
		CAPABILITY_SEARCH_RRF_K,
	)
	const ordered = sortIdsByScore(ids, (id) => fused.get(id) ?? 0).slice(
		0,
		Math.max(1, Math.min(input.limit, ids.length)),
	)

	return {
		matches: ordered.map((id) => {
			const row = rowsById.get(id)!
			const vectorRank = vectorRankById.get(id)
			return {
				id: row.id,
				category: row.category,
				status: row.status,
				subject: row.subject,
				summary: row.summary,
				details: row.details,
				tags: parseJsonStringArray(row.tags_json),
				sourceUris: parseJsonStringArray(row.source_uris_json),
				dedupeKey: row.dedupe_key,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				lastAccessedAt: row.last_accessed_at,
				deletedAt: row.deleted_at,
				score: fused.get(id) ?? 0,
				lexicalRank: lexicalRankById.get(id),
				...(vectorRank != null ? { vectorRank } : {}),
			}
		}),
		offline,
	}
}
