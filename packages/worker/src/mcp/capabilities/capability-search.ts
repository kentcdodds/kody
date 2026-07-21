import { type CapabilitySpec } from './types.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { fnv1a32 } from '@kody-internal/shared/fnv1a.ts'

type CapabilityVectorizeEnv = {
	AI?: Ai
	AI_GATEWAY_ID?: string
	CAPABILITY_VECTOR_INDEX?: VectorizeIndex
	SENTRY_ENVIRONMENT?: string
	WRANGLER_IS_LOCAL_DEV?: string
}

type WorkersAiEmbeddingResponse = {
	data?: unknown
	shape?: unknown
}

export function getCapabilityVectorIndex(env: Env): VectorizeIndex | undefined {
	return (env as unknown as CapabilityVectorizeEnv).CAPABILITY_VECTOR_INDEX
}

/** Must match Vectorize index dimensions for production indexes. */
export const CAPABILITY_EMBEDDING_DIMENSIONS = 384
export const CAPABILITY_EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5'
export const CAPABILITY_EMBEDDING_BATCH_SIZE = 8
export const CAPABILITY_EMBEDDING_MAX_INPUT_CHARS = 2_000

export const CAPABILITY_SEARCH_RRF_K = 60

/**
 * Indexed metadata `kind` for builtin capability vectors in the shared
 * CAPABILITY_VECTOR_INDEX (see capability-reindex.ts). Distinct from package /
 * memory / job kinds in the same index.
 */
export const CAPABILITY_VECTOR_KIND = 'builtin'

/**
 * Always scope capability Vectorize queries to builtin capability vectors.
 * Caller-supplied RBAC/provider filters are merged with implicit AND; `kind` is
 * forced to builtin so callers cannot widen into packages or other corpora.
 */
export function buildCapabilityVectorMetadataFilter(
	callerFilter?: VectorizeVectorMetadataFilter,
): VectorizeVectorMetadataFilter {
	if (!callerFilter || Object.keys(callerFilter).length === 0) {
		return { kind: { $eq: CAPABILITY_VECTOR_KIND } }
	}
	return {
		...callerFilter,
		kind: { $eq: CAPABILITY_VECTOR_KIND },
	}
}

function truncateEmbeddingInput(text: string) {
	if (text.length <= CAPABILITY_EMBEDDING_MAX_INPUT_CHARS) return text
	return text.slice(0, CAPABILITY_EMBEDDING_MAX_INPUT_CHARS)
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

function capabilityLexicalScore(
	query: string,
	identityQuery: string,
	spec: CapabilitySpec,
	document: string,
): number {
	const documentScore = lexicalScore(query, document)
	const identityScore = lexicalScore(
		identityQuery,
		`${spec.name}\n${spec.domain}`,
	)
	// Dynamic operations may not be indexed yet. Normalize operation identity
	// against query terms that occur in this registry's identities so exact
	// entity names are not diluted by conversational query words.
	return Math.min(1, documentScore + identityScore)
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
	source: CapabilitySpec['source']
	remoteConnector?: CapabilitySpec['remoteConnector']
	requiredInputFields: Array<string>
}

export type CapabilityDetailRow = CapabilitySummaryRow & {
	description: string
	keywords: Array<string>
	readOnly: boolean
	idempotent: boolean
	destructive: boolean
	inputTypeDefinition: string
	outputTypeDefinition?: string
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
		source: spec.source,
		...(spec.remoteConnector ? { remoteConnector: spec.remoteConnector } : {}),
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
		inputTypeDefinition: spec.inputTypeDefinition,
		...(spec.outputTypeDefinition
			? { outputTypeDefinition: spec.outputTypeDefinition }
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
	if (
		!getCapabilityVectorIndex(env) &&
		runtime['SENTRY_ENVIRONMENT'] !== 'production'
	)
		return true
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
	const truncatedTexts = texts.map((text) => truncateEmbeddingInput(text))

	const runtime = env as unknown as CapabilityVectorizeEnv
	if (!runtime.AI) {
		if (runtime.SENTRY_ENVIRONMENT !== 'production') {
			return truncatedTexts.map((text) => deterministicEmbedding(text))
		}
		throw new Error(
			'AI binding is required for capability embeddings in production.',
		)
	}
	const aiRuntime = runtime as CapabilityVectorizeEnv & { AI: Ai }

	const rows: Array<Array<number>> = []
	for (
		let offset = 0;
		offset < truncatedTexts.length;
		offset += CAPABILITY_EMBEDDING_BATCH_SIZE
	) {
		const batch = truncatedTexts.slice(
			offset,
			offset + CAPABILITY_EMBEDDING_BATCH_SIZE,
		)
		rows.push(...(await embedTextBatchForVectorize(aiRuntime, batch)))
	}
	return rows
}

async function runWorkersAiEmbeddingRequest(
	runtime: CapabilityVectorizeEnv & { AI: Ai },
	texts: ReadonlyArray<string>,
	options?: { gateway: { id: string } },
) {
	return (await runtime.AI.run(
		CAPABILITY_EMBEDDING_MODEL,
		{
			text: [...texts],
			pooling: 'cls',
		},
		options,
	)) as WorkersAiEmbeddingResponse
}

async function embedTextBatchForVectorize(
	runtime: CapabilityVectorizeEnv & { AI: Ai },
	texts: ReadonlyArray<string>,
) {
	const gatewayId = runtime.AI_GATEWAY_ID?.trim()
	if (gatewayId) {
		try {
			const response = await runWorkersAiEmbeddingRequest(runtime, texts, {
				gateway: { id: gatewayId },
			})
			return parseWorkersAiEmbeddingResponse(response, texts.length)
		} catch (error) {
			console.warn(
				JSON.stringify({
					message:
						'Workers AI Gateway embedding request failed; retrying direct Workers AI',
					gatewayId,
					error: getErrorMessage(error),
				}),
			)
			try {
				const response = await runWorkersAiEmbeddingRequest(runtime, texts)
				return parseWorkersAiEmbeddingResponse(response, texts.length)
			} catch (directError) {
				throw new Error(
					`Workers AI embedding request failed after AI Gateway fallback. Gateway error: ${getErrorMessage(error)}. Direct error: ${getErrorMessage(directError)}`,
				)
			}
		}
	}

	const response = await runWorkersAiEmbeddingRequest(runtime, texts)
	return parseWorkersAiEmbeddingResponse(response, texts.length)
}

function parseWorkersAiEmbeddingResponse(
	response: WorkersAiEmbeddingResponse,
	expectedRows: number,
): Array<Array<number>> {
	if (!Array.isArray(response.data)) {
		throw new Error('Workers AI embedding response did not include data rows.')
	}
	if (response.data.length !== expectedRows) {
		throw new Error(
			`Workers AI embedding response row count mismatch: expected ${expectedRows}, received ${response.data.length}.`,
		)
	}
	if (Array.isArray(response.shape)) {
		const [rows, dimensions] = response.shape
		if (
			rows !== expectedRows ||
			dimensions !== CAPABILITY_EMBEDDING_DIMENSIONS
		) {
			throw new Error(
				`Workers AI embedding response shape mismatch: expected [${expectedRows}, ${CAPABILITY_EMBEDDING_DIMENSIONS}], received ${JSON.stringify(response.shape)}.`,
			)
		}
	}

	return response.data.map((row, rowIndex) => {
		if (!Array.isArray(row)) {
			throw new Error(`Workers AI embedding row ${rowIndex} is not an array.`)
		}
		if (row.length !== CAPABILITY_EMBEDDING_DIMENSIONS) {
			throw new Error(
				`Workers AI embedding row ${rowIndex} dimension mismatch: expected ${CAPABILITY_EMBEDDING_DIMENSIONS}, received ${row.length}.`,
			)
		}
		return row.map((value, columnIndex) => {
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				throw new Error(
					`Workers AI embedding value at row ${rowIndex}, column ${columnIndex} is not a finite number.`,
				)
			}
			return value
		})
	})
}

export async function searchCapabilities(input: {
	env: Env
	query: string
	limit: number
	detail: boolean
	specs: Record<string, CapabilitySpec>
	/**
	 * Optional online-only metadata filter combined with the builtin capability
	 * kind filter (RBAC/provider scoping). Never widens into other index kinds.
	 */
	vectorMetadataFilter?: VectorizeVectorMetadataFilter
	/**
	 * Optional precomputed query embedding. Callers that also rank packages
	 * (or other Vectorize-backed corpora) against the same query should embed
	 * once and pass the vector here to avoid a second Workers AI round-trip.
	 */
	queryVector?: ReadonlyArray<number>
}): Promise<{ matches: Array<CapabilitySearchHit>; offline: boolean }> {
	const q = input.query.trim()
	const specs = input.specs
	const ids = Object.keys(specs)
	const docsById = Object.fromEntries(
		ids.map((id) => [id, buildCapabilityEmbedText(specs[id]!)] as const),
	)
	const identityTokenUniverse = new Set(
		ids.flatMap((id) => [
			...tokenize(`${specs[id]!.name}\n${specs[id]!.domain}`),
		]),
	)
	const identityQuery = [...tokenize(q)]
		.filter((token) => identityTokenUniverse.has(token))
		.join(' ')
	const lexicalScoreById = Object.fromEntries(
		ids.map(
			(id) =>
				[
					id,
					capabilityLexicalScore(q, identityQuery, specs[id]!, docsById[id]!),
				] as const,
		),
	)

	const lexicalOrder = sortIdsByScore(ids, (id) => lexicalScoreById[id]!)

	let vectorOrder: Array<string>
	let vectorScoreById: Record<string, number>
	let vectorHitIds: Set<string>

	const offline = isCapabilitySearchOffline(input.env)

	if (offline) {
		const qVec =
			input.queryVector &&
			input.queryVector.length === CAPABILITY_EMBEDDING_DIMENSIONS
				? [...input.queryVector]
				: deterministicEmbedding(q)
		vectorScoreById = Object.fromEntries(
			ids.map((id) => {
				const cVec = deterministicEmbedding(docsById[id]!)
				return [id, cosineSimilarity(qVec, cVec)] as const
			}),
		)
		vectorOrder = sortIdsByScore(ids, (id) => vectorScoreById[id]!)
		vectorHitIds = new Set(ids)
	} else {
		const index = getCapabilityVectorIndex(input.env)
		if (!index) {
			throw new Error(
				'CAPABILITY_VECTOR_INDEX binding is required for capability search outside offline mode.',
			)
		}
		const vectorIndex = index
		// Clone at the Vectorize boundary — Workers may mutate the query array.
		const qVec = [
			...(input.queryVector ?? (await embedTextForVectorize(input.env, q))),
		]
		const topK = Math.min(Math.max(ids.length, input.limit * 5), 100)
		const vectorScoreMap = new Map<string, number>()
		const filter = buildCapabilityVectorMetadataFilter(
			input.vectorMetadataFilter,
		)

		const vecMatches = await vectorIndex.query(qVec, {
			topK,
			returnMetadata: 'none',
			filter,
		})
		const fromIndex: Array<string> = []
		const seen = new Set<string>()
		for (const match of vecMatches.matches) {
			if (
				typeof match.id !== 'string' ||
				!specs[match.id] ||
				seen.has(match.id)
			)
				continue
			seen.add(match.id)
			fromIndex.push(match.id)
			vectorScoreMap.set(match.id, match.score)
		}
		// Do not re-embed documents missing from Vectorize topK on the query path,
		// and do not fall back to an unfiltered cross-kind query. Lexical ranking
		// recalls non-vector hits; reindexing owns document embeddings.
		vectorHitIds = seen
		vectorScoreById = Object.fromEntries(
			ids.map((id) => [id, vectorScoreMap.get(id) ?? Number.NEGATIVE_INFINITY]),
		)
		// Only real Vectorize hits participate in vectorOrder / RRF.
		vectorOrder = fromIndex
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
			const aHasVector = vectorHitIds.has(a)
			const bHasVector = vectorHitIds.has(b)
			if (aHasVector !== bHasVector) return aHasVector ? -1 : 1
			if (aHasVector && bHasVector) {
				const vectorDiff = vectorScoreById[b]! - vectorScoreById[a]!
				if (vectorDiff !== 0) return vectorDiff
			}
			return lexicalScoreById[b]! - lexicalScoreById[a]!
		})
		.slice(0, Math.max(1, Math.min(input.limit, ids.length)))

	const matches: Array<CapabilitySearchHit> = ordered.map((id) => {
		const spec = specs[id]!
		const base = input.detail ? toDetail(spec) : toSummary(spec)
		const hasVectorHit = vectorHitIds.has(id)
		const rawVectorScore = vectorScoreById[id]
		const vectorScore =
			hasVectorHit &&
			rawVectorScore !== undefined &&
			Number.isFinite(rawVectorScore)
				? rawVectorScore
				: 0
		return {
			...base,
			fusedScore: fused.get(id) ?? 0,
			lexicalRank: lexicalRankById.get(id),
			// Omit vectorRank when there was no Vectorize hit so callers can
			// treat the candidate as lexical-only (not vectorScore === 0).
			...(hasVectorHit ? { vectorRank: vectorRankById.get(id) } : {}),
			lexicalScore: lexicalScoreById[id] ?? 0,
			// Keep a stable numeric public field; ranking uses vectorRank presence.
			vectorScore,
		}
	})

	return { matches, offline }
}
