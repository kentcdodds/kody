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
import {
	type JournalEntryRow,
	type JournalEntrySearchFilters,
	listJournalEntriesByUserId,
} from './journal-entries-repo.ts'
import { parseJournalTags } from './shared.ts'

const defaultJournalEmbedMaxChars = 8_000

type JournalSearchHit = {
	entryId: string
	fusedScore: number
	lexicalRank?: number
	vectorRank?: number
}

export function journalEntryVectorId(entryId: string): string {
	return `journal_${entryId}`
}

export function buildJournalEntryEmbedText(
	row: Pick<
		JournalEntryRow,
		| 'id'
		| 'title'
		| 'content'
		| 'tags'
		| 'entry_at'
		| 'created_at'
		| 'updated_at'
	>,
	maxChars: number = defaultJournalEmbedMaxChars,
): string {
	const tags = parseJournalTags(row.tags)
	const parts = [
		'journaling',
		'journal',
		'entry',
		row.title,
		row.content,
		tags.join(' '),
		...(row.entry_at ? [row.entry_at] : []),
		row.created_at,
		row.updated_at,
	]
	return parts.join('\n').slice(0, maxChars)
}

export async function upsertJournalEntryVector(
	env: Env,
	input: { entryId: string; userId: string; embedText: string },
): Promise<void> {
	const index = getCapabilityVectorIndex(env)
	if (!index || isCapabilitySearchOffline(env)) return
	const values = await embedTextForVectorize(env, input.embedText)
	await index.upsert([
		{
			id: journalEntryVectorId(input.entryId),
			values,
			metadata: { kind: 'journal_entry', userId: input.userId },
		},
	])
}

export async function deleteJournalEntryVector(
	env: Env,
	entryId: string,
): Promise<void> {
	const index = getCapabilityVectorIndex(env)
	if (!index) return
	await index.deleteByIds([journalEntryVectorId(entryId)])
}

export async function searchJournalEntriesSemantic(input: {
	env: Env
	db: D1Database
	userId: string
	filters: JournalEntrySearchFilters
}): Promise<{ rows: Array<JournalEntryRow>; offline: boolean }> {
	const candidateLimit = Math.min(Math.max(input.filters.limit * 5, 25), 100)
	const rows = await listJournalEntriesByUserId(input.db, input.userId, {
		limit: candidateLimit,
		tag: input.filters.tag,
	})
	const offline = isCapabilitySearchOffline(input.env)
	if (rows.length === 0) {
		return { rows: [], offline }
	}

	const idSet = new Map(rows.map((row) => [row.id, row] as const))
	const ids = [...idSet.keys()]
	const docsById = Object.fromEntries(
		rows.map((row) => [row.id, buildJournalEntryEmbedText(row)] as const),
	)
	const query = input.filters.query.trim()

	const lexicalOrder = sortIdsByScore(ids, (id) =>
		lexicalScore(query, docsById[id]!),
	)

	let vectorOrder: Array<string>
	if (offline) {
		const queryVector = deterministicEmbedding(query)
		const similarityById = Object.fromEntries(
			ids.map((id) => {
				const rowVector = deterministicEmbedding(docsById[id]!)
				return [id, cosineSimilarity(queryVector, rowVector)] as const
			}),
		)
		vectorOrder = sortIdsByScore(ids, (id) => similarityById[id]!)
	} else {
		const index = getCapabilityVectorIndex(input.env)!
		const queryVector = await embedTextForVectorize(input.env, query)
		const topK = Math.min(Math.max(ids.length, input.filters.limit * 5), 100)

		async function collectOrder(
			filter?: VectorizeVectorMetadataFilter,
		): Promise<Array<string>> {
			const matches = await index.query(queryVector, {
				topK,
				returnMetadata: 'none',
				...(filter ? { filter } : {}),
			})
			const seen = new Set<string>()
			const order: Array<string> = []
			for (const match of matches.matches) {
				if (typeof match.id !== 'string' || seen.has(match.id)) continue
				if (!match.id.startsWith('journal_')) continue
				const entryId = match.id.slice('journal_'.length)
				const row = idSet.get(entryId)
				if (!row || row.user_id !== input.userId) continue
				seen.add(match.id)
				order.push(entryId)
			}
			return order
		}

		let fromIndex = await collectOrder({
			kind: { $eq: 'journal_entry' },
			userId: { $eq: input.userId },
		})
		if (fromIndex.length === 0) {
			fromIndex = await collectOrder(undefined)
		}
		const seenEntryIds = new Set(fromIndex)
		vectorOrder = [...fromIndex, ...ids.filter((id) => !seenEntryIds.has(id))]
	}

	const lexicalRankById = new Map<string, number>()
	for (let rank = 0; rank < lexicalOrder.length; rank += 1) {
		lexicalRankById.set(lexicalOrder[rank]!, rank + 1)
	}
	const vectorRankById = new Map<string, number>()
	for (let rank = 0; rank < vectorOrder.length; rank += 1) {
		vectorRankById.set(vectorOrder[rank]!, rank + 1)
	}

	const fused = reciprocalRankFusion(
		[lexicalOrder, vectorOrder],
		CAPABILITY_SEARCH_RRF_K,
	)
	const orderedHits: Array<JournalSearchHit> = sortIdsByScore(
		ids,
		(id) => fused.get(id) ?? 0,
	)
		.slice(0, Math.max(1, Math.min(input.filters.limit, ids.length)))
		.map((id) => ({
			entryId: id,
			fusedScore: fused.get(id) ?? 0,
			lexicalRank: lexicalRankById.get(id),
			vectorRank: vectorRankById.get(id),
		}))

	return {
		rows: orderedHits.map((hit) => idSet.get(hit.entryId)!).filter(Boolean),
		offline,
	}
}
