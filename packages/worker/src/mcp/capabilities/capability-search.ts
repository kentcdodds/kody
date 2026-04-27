import { compressSchemaForLlm } from './schema-compression.ts'
import { type CapabilitySpec } from './types.ts'

type CapabilityVectorizeEnv = { CAPABILITY_VECTOR_INDEX?: VectorizeIndex }

export function getCapabilityVectorIndex(env: Env): VectorizeIndex | undefined {
	return (env as unknown as CapabilityVectorizeEnv).CAPABILITY_VECTOR_INDEX
}

/** Must match Vectorize index dimensions for production indexes. */
export const CAPABILITY_EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5'
export const CAPABILITY_EMBEDDING_DIMENSIONS = 384

export const CAPABILITY_SEARCH_RRF_K = 60
const vectorizeEmbedBatchSize = 16

function fnv1a32(input: string): number {
	let hash = 2_166_136_261
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i)
		hash = Math.imul(hash, 16_777_619)
	}
	return hash >>> 0
}

/**
 * L2-normalized pseudo-embedding for offline / test search (no Workers AI call).
 */
export function deterministicEmbedding(
	text: string,
	dimensions: number = CAPABILITY_EMBEDDING_DIMENSIONS,
): number[] {
	const normalized = text.toLowerCase().trim()
	const vec = new Float64Array(dimensions)
	for (let i = 0; i < dimensions; i += 1) {
		const h = fnv1a32(`${normalized}:${i}`)
		vec[i] = h / 2 ** 32 - 0.5
	}
	let norm = 0
	for (let i = 0; i < dimensions; i += 1) norm += vec[i]! * vec[i]!
	norm = Math.sqrt(norm) || 1
	for (let i = 0; i < dimensions; i += 1) vec[i]! /= norm
	return [...vec]
}

export function cosineSimilarity(
	a: ReadonlyArray<number>,
	b: ReadonlyArray<number>,
): number {
	let dot = 0
	for (let i = 0; i < a.length; i += 1) dot += a[i]! * b[i]!
	return dot
}

// Keep hybrid lexical+vector scores on the same scale as lexical-only matches.
export function blendLexicalAndVectorScore(lexical: number, vector: number) {
	return (lexical + Math.max(0, vector)) / 2
}

export function buildCapabilityEmbedText(spec: CapabilitySpec): string {
	const keywords = spec.keywords.join(' ')
	const fields = [...spec.inputFields, ...spec.outputFields].join(' ')
	return [spec.name, spec.domain, spec.description, keywords, fields]
		.join('\n')
		.slice(0, 8_000)
}

function tokenize(s: string): Set<string> {
	return new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? [])
}

export function lexicalScore(query: string, doc: string): number {
	const q = tokenize(query)
	const d = tokenize(doc)
	if (q.size === 0) return 0
	let intersection = 0
	for (const t of q) {
		if (d.has(t)) intersection += 1
	}
	return intersection / q.size
}

export function hybridSearchScore(lexical: number, vector: number): number {
	return blendLexicalAndVectorScore(lexical, vector)
}

export function normalizeHybridSearchScore(input: {
	lexical: number
	vector: number
}): number {
	return hybridSearchScore(input.lexical, input.vector)
}

export function reciprocalRankFusion(
	rankedLists: Array<Array<string>>,
	k: number,
): Map<string, number> {
	const scores = new Map<string, number>()
	for (const list of rankedLists) {
		for (let rank = 0; rank < list.length; rank += 1) {
			const id = list[rank]!
			scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1))
		}
	}
	return scores
}

export function sortIdsByScore(
	ids: ReadonlyArray<string>,
	scoreFn: (id: string) => number,
): Array<string> {
	return [...ids].sort((a, b) => scoreFn(b) - scoreFn(a))
}

export type CapabilitySummaryRow = {
	name: string
	domain: string
	description: string
	requiredInputFields: Array<string>
}

export type CapabilityDetailRow = CapabilitySummaryRow & {
	description: string
	keywords: Array<string>
	readOnly: boolean
	idempotent: boolean
	destructive: boolean
	inputSchema: unknown
	outputSchema?: unknown
	inputFields?: Array<string>
	outputFields?: Array<string>
}

export type RankedCapabilityHit = CapabilitySummaryRow | CapabilityDetailRow

export type CapabilitySearchHit = RankedCapabilityHit & {
	fusedScore: number
	lexicalRank?: number
	vectorRank?: number
	lexicalScore: number
	vectorScore: number
}

function toSummary(spec: CapabilitySpec): CapabilitySummaryRow {
	return {
		name: spec.name,
		domain: spec.domain,
		description: spec.description,
		requiredInputFields: spec.requiredInputFields,
	}
}

function toDetail(spec: CapabilitySpec): CapabilityDetailRow {
	const inputSchema = compressSchemaForLlm(spec.inputSchema)
	const outputSchema =
		'outputSchema' in spec && spec.outputSchema !== undefined
			? compressSchemaForLlm(spec.outputSchema, {
					stripRootObjectType: false,
				})
			: undefined
	const row: CapabilityDetailRow = {
		...toSummary(spec),
		description: spec.description,
		keywords: spec.keywords,
		readOnly: spec.readOnly,
		idempotent: spec.idempotent,
		destructive: spec.destructive,
		inputSchema,
		...(outputSchema ? { outputSchema } : {}),
	}
	if (!spec.inputSchema) {
		row.inputFields = spec.inputFields
	}
	if (!spec.outputSchema) {
		row.outputFields = spec.outputFields
	}
	return row
}

export function isCapabilitySearchOffline(env: Env): boolean {
	const runtime = env as unknown as Record<string, string | undefined>
	if (runtime['SENTRY_ENVIRONMENT'] === 'test') return true
	if (runtime['WRANGLER_IS_LOCAL_DEV'] === 'true') return true
	if (!getCapabilityVectorIndex(env)) return true
	return false
}

export async function embedTextForVectorize(
	env: Env,
	text: string,
): Promise<Array<number>> {
	const rows = await embedTextsForVectorize(env, [text])
	return rows[0]!
}

export async function embedTextsForVectorize(
	env: Env,
	texts: ReadonlyArray<string>,
): Promise<Array<Array<number>>> {
	if (texts.length === 0) return []

	const vectors: Array<Array<number>> = []

	for (
		let offset = 0;
		offset < texts.length;
		offset += vectorizeEmbedBatchSize
	) {
		const batch = texts.slice(offset, offset + vectorizeEmbedBatchSize)
		const textInput = batch.length === 1 ? batch[0]! : batch
		const out = (await env.AI.run(CAPABILITY_EMBEDDING_MODEL, {
			text: textInput,
			pooling: 'mean',
		})) as { data?: Array<Array<number>> }
		const rows = out.data
		if (!rows || rows.length !== batch.length) {
			throw new Error('Workers AI embedding batch size mismatch')
		}
		vectors.push(...rows)
	}

	return vectors
}

export async function searchCapabilities(input: {
	env: Env
	query: string
	limit: number
	detail: boolean
	specs: Record<string, CapabilitySpec>
	/** When set (online only), Vectorize query uses this metadata filter first; falls back to unfiltered if no spec ids match. */
	vectorMetadataFilter?: VectorizeVectorMetadataFilter
}): Promise<{ matches: Array<CapabilitySearchHit>; offline: boolean }> {
	const q = input.query.trim()
	const specs = input.specs
	const ids = Object.keys(specs)
	const docsById = Object.fromEntries(
		ids.map((id) => [id, buildCapabilityEmbedText(specs[id]!)] as const),
	)
	const lexicalScoreById = Object.fromEntries(
		ids.map((id) => [id, lexicalScore(q, docsById[id]!)] as const),
	)

	const lexicalOrder = sortIdsByScore(ids, (id) => lexicalScoreById[id]!)

	let vectorOrder: Array<string>
	let vectorScoreById: Record<string, number>

	const offline = isCapabilitySearchOffline(input.env)

	if (offline) {
		const qVec = deterministicEmbedding(q)
		vectorScoreById = Object.fromEntries(
			ids.map((id) => {
				const cVec = deterministicEmbedding(docsById[id]!)
				return [id, cosineSimilarity(qVec, cVec)] as const
			}),
		)
		vectorOrder = sortIdsByScore(ids, (id) => vectorScoreById[id]!)
	} else {
		const index = getCapabilityVectorIndex(input.env)!
		const qVec = await embedTextForVectorize(input.env, q)
		const topK = Math.min(Math.max(ids.length, input.limit * 5), 100)
		const vectorScoreMap = new Map<string, number>()

		async function queryVectorize(filter?: VectorizeVectorMetadataFilter) {
			return index.query(qVec, {
				topK,
				returnMetadata: 'none',
				...(filter ? { filter } : {}),
			})
		}

		let vecMatches = await queryVectorize(input.vectorMetadataFilter)
		const collectFromMatches = (
			raw: typeof vecMatches.matches,
		): { fromIndex: Array<string>; seen: Set<string> } => {
			const seen = new Set<string>()
			const fromIndex: Array<string> = []
			for (const m of raw) {
				if (typeof m.id !== 'string' || !specs[m.id] || seen.has(m.id)) continue
				seen.add(m.id)
				fromIndex.push(m.id)
				vectorScoreMap.set(m.id, m.score)
			}
			return { fromIndex, seen }
		}

		let { fromIndex, seen } = collectFromMatches(vecMatches.matches)
		if (fromIndex.length === 0 && input.vectorMetadataFilter) {
			vecMatches = await queryVectorize(undefined)
			;({ fromIndex, seen } = collectFromMatches(vecMatches.matches))
		}
		const missingIds = ids.filter((id) => !seen.has(id))
		if (missingIds.length > 0) {
			const missingVectors = await embedTextsForVectorize(
				input.env,
				missingIds.map((id) => docsById[id]!),
			)
			for (let index_ = 0; index_ < missingIds.length; index_ += 1) {
				vectorScoreMap.set(
					missingIds[index_]!,
					cosineSimilarity(qVec, missingVectors[index_]!),
				)
			}
		}
		vectorScoreById = Object.fromEntries(
			ids.map((id) => [id, vectorScoreMap.get(id) ?? Number.NEGATIVE_INFINITY]),
		)
		vectorOrder = sortIdsByScore(ids, (id) => vectorScoreById[id]!)
	}

	const lexicalRankById = new Map<string, number>()
	for (let r = 0; r < lexicalOrder.length; r += 1) {
		lexicalRankById.set(lexicalOrder[r]!, r + 1)
	}
	const vectorRankById = new Map<string, number>()
	for (let r = 0; r < vectorOrder.length; r += 1) {
		vectorRankById.set(vectorOrder[r]!, r + 1)
	}

	const fused = reciprocalRankFusion(
		[lexicalOrder, vectorOrder],
		CAPABILITY_SEARCH_RRF_K,
	)
	const ordered = [...ids]
		.sort((a, b) => {
			const fusedDiff = (fused.get(b) ?? 0) - (fused.get(a) ?? 0)
			if (fusedDiff !== 0) return fusedDiff
			const vectorDiff = vectorScoreById[b]! - vectorScoreById[a]!
			if (vectorDiff !== 0) return vectorDiff
			return lexicalScoreById[b]! - lexicalScoreById[a]!
		})
		.slice(0, Math.max(1, Math.min(input.limit, ids.length)))

	const matches: Array<CapabilitySearchHit> = ordered.map((id) => {
		const spec = specs[id]!
		const base = input.detail ? toDetail(spec) : toSummary(spec)
		return {
			...base,
			fusedScore: fused.get(id) ?? 0,
			lexicalRank: lexicalRankById.get(id),
			vectorRank: vectorRankById.get(id),
			lexicalScore: lexicalScoreById[id] ?? 0,
			vectorScore: vectorScoreById[id] ?? Number.NEGATIVE_INFINITY,
		}
	})

	return { matches, offline }
}
