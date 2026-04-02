import {
	CAPABILITY_SEARCH_RRF_K,
	cosineSimilarity,
	deterministicEmbedding,
	embedTextForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
	lexicalScore,
	reciprocalRankFusion,
	sortIdsByScore,
} from '#mcp/capabilities/capability-search.ts'
import { buildMemoryEmbedTextFromRow } from './memory-embed.ts'
import { type McpMemoryRow, type MemorySearchMatch } from './types.ts'

export async function searchMemories(input: {
	env: Env
	query: string
	limit: number
	rows: Array<McpMemoryRow>
}): Promise<{ matches: Array<MemorySearchMatch>; offline: boolean }> {
	const query = input.query.trim()
	const rowsById = new Map(input.rows.map((row) => [row.id, row] as const))
	const ids = [...rowsById.keys()]
	const offline = isCapabilitySearchOffline(input.env)

	if (!query || ids.length === 0) {
		return { matches: [], offline }
	}

	const docsById = Object.fromEntries(
		input.rows.map((row) => [row.id, buildMemoryEmbedTextFromRow(row)] as const),
	)
	const lexicalOrder = sortIdsByScore(ids, (id) =>
		lexicalScore(query, docsById[id]!),
	)

	let vectorOrder: Array<string>
	if (offline) {
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
			filter: {
				kind: { $eq: 'memory' },
			},
		})
		const seen = new Set<string>()
		const fromIndex: Array<string> = []
		for (const match of vectorMatches.matches) {
			if (typeof match.id !== 'string' || seen.has(match.id)) continue
			if (!match.id.startsWith('memory_')) continue
			const memoryId = match.id.slice('memory_'.length)
			if (!rowsById.has(memoryId)) continue
			seen.add(match.id)
			fromIndex.push(memoryId)
		}
		vectorOrder = [...fromIndex, ...ids.filter((id) => !fromIndex.includes(id))]
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
			return {
				id: row.id,
				category: row.category,
				status: row.status,
				subject: row.subject,
				summary: row.summary,
				details: row.details,
				tags: parseTags(row.tags_json),
				dedupeKey: row.dedupe_key,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				lastAccessedAt: row.last_accessed_at,
				deletedAt: row.deleted_at,
				score: fused.get(id) ?? 0,
				lexicalRank: lexicalRankById.get(id),
				vectorRank: vectorRankById.get(id),
			}
		}),
		offline,
	}
}

function parseTags(raw: string): Array<string> {
	try {
		const parsed = JSON.parse(raw) as unknown
		if (!Array.isArray(parsed)) return []
		return parsed.filter((item): item is string => typeof item === 'string')
	} catch {
		return []
	}
}
