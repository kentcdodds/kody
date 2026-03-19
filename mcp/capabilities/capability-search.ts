import { type CapabilitySpec } from './types.ts'

type CapabilityVectorizeEnv = { CAPABILITY_VECTOR_INDEX?: VectorizeIndex }

export function getCapabilityVectorIndex(env: Env): VectorizeIndex | undefined {
	return (env as unknown as CapabilityVectorizeEnv).CAPABILITY_VECTOR_INDEX
}

/** Must match Vectorize index dimensions for production indexes. */
export const CAPABILITY_EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5'
export const CAPABILITY_EMBEDDING_DIMENSIONS = 384

const rrfK = 60

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

function cosineSimilarity(
	a: ReadonlyArray<number>,
	b: ReadonlyArray<number>,
): number {
	let dot = 0
	for (let i = 0; i < a.length; i += 1) dot += a[i]! * b[i]!
	return dot
}

export function buildCapabilityEmbedText(spec: CapabilitySpec): string {
	const keywords = spec.keywords.join(' ')
	const fields = [...spec.inputFields, ...spec.outputFields].join(' ')
	return [spec.name, spec.domain, spec.description, keywords, fields]
		.join('\n')
		.slice(0, 8_000)
}

function tokenize(s: string): Set<string> {
	return new Set(s.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
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

function reciprocalRankFusion(
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

function sortIdsByScore(
	ids: ReadonlyArray<string>,
	scoreFn: (id: string) => number,
): Array<string> {
	return [...ids].sort((a, b) => scoreFn(b) - scoreFn(a))
}

export type CapabilitySummaryRow = {
	name: string
	domain: string
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
}

function toSummary(spec: CapabilitySpec): CapabilitySummaryRow {
	return {
		name: spec.name,
		domain: spec.domain,
		requiredInputFields: spec.requiredInputFields,
	}
}

function toDetail(spec: CapabilitySpec): CapabilityDetailRow {
	const row: CapabilityDetailRow = {
		...toSummary(spec),
		description: spec.description,
		keywords: spec.keywords,
		readOnly: spec.readOnly,
		idempotent: spec.idempotent,
		destructive: spec.destructive,
		inputSchema: spec.inputSchema,
		...('outputSchema' in spec && spec.outputSchema !== undefined
			? { outputSchema: spec.outputSchema }
			: {}),
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

async function embedQueryWithAi(
	env: Env,
	text: string,
): Promise<Array<number>> {
	const out = (await env.AI.run(CAPABILITY_EMBEDDING_MODEL, {
		text,
		pooling: 'mean',
	})) as { data?: Array<Array<number>> }
	const vec = out.data?.[0]
	if (!vec?.length) throw new Error('Workers AI embedding returned no vector')
	return vec
}

export async function searchCapabilities(input: {
	env: Env
	query: string
	limit: number
	detail: boolean
	specs: Record<string, CapabilitySpec>
}): Promise<{ matches: Array<CapabilitySearchHit>; offline: boolean }> {
	const q = input.query.trim()
	const specs = input.specs
	const ids = Object.keys(specs)
	const docsById = Object.fromEntries(
		ids.map((id) => [id, buildCapabilityEmbedText(specs[id]!)] as const),
	)

	const lexicalOrder = sortIdsByScore(ids, (id) =>
		lexicalScore(q, docsById[id]!),
	)

	let vectorOrder: Array<string>

	const offline = isCapabilitySearchOffline(input.env)

	if (offline) {
		const qVec = deterministicEmbedding(q)
		const simById = Object.fromEntries(
			ids.map((id) => {
				const cVec = deterministicEmbedding(docsById[id]!)
				return [id, cosineSimilarity(qVec, cVec)] as const
			}),
		)
		vectorOrder = sortIdsByScore(ids, (id) => simById[id]!)
	} else {
		const index = getCapabilityVectorIndex(input.env)!
		const qVec = await embedQueryWithAi(input.env, q)
		const matches = await index.query(qVec, {
			topK: Math.min(Math.max(ids.length, input.limit * 5), 100),
			returnMetadata: 'none',
		})
		const seen = new Set<string>()
		const fromIndex: Array<string> = []
		for (const m of matches.matches) {
			if (typeof m.id !== 'string' || !specs[m.id] || seen.has(m.id)) continue
			seen.add(m.id)
			fromIndex.push(m.id)
		}
		vectorOrder = [...fromIndex, ...ids.filter((id) => !seen.has(id))]
	}

	const lexicalRankById = new Map<string, number>()
	for (let r = 0; r < lexicalOrder.length; r += 1) {
		lexicalRankById.set(lexicalOrder[r]!, r + 1)
	}
	const vectorRankById = new Map<string, number>()
	for (let r = 0; r < vectorOrder.length; r += 1) {
		vectorRankById.set(vectorOrder[r]!, r + 1)
	}

	const fused = reciprocalRankFusion([lexicalOrder, vectorOrder], rrfK)
	const ordered = sortIdsByScore(ids, (id) => fused.get(id) ?? 0).slice(
		0,
		Math.max(1, Math.min(input.limit, ids.length)),
	)

	const matches: Array<CapabilitySearchHit> = ordered.map((id) => {
		const spec = specs[id]!
		const base = input.detail ? toDetail(spec) : toSummary(spec)
		return {
			...base,
			fusedScore: fused.get(id) ?? 0,
			lexicalRank: lexicalRankById.get(id),
			vectorRank: vectorRankById.get(id),
		}
	})

	return { matches, offline }
}
